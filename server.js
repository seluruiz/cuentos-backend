require('dotenv').config();

const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const Database = require('better-sqlite3');
const multer = require('multer');
const FormData = require('form-data');
const axios = require('axios');

const app = express();
app.set('trust proxy', 1);

// CORS restringido a lo básico
app.use(cors());
app.use(express.json({ limit: '2mb' })); 

// --- RATE LIMITS ESPECÍFICOS ---
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  message: { error: 'Trop de requêtes, veuillez réessayer plus tard.' }
});

const voiceCloneLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hora
  max: 10,
  message: { error: 'Limite de clonage atteinte. Réessayez plus tard.' }
});

const ttsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  message: { error: 'Limite de génération audio atteinte.' }
});

app.use('/api/', apiLimiter);

// --- CONFIGURACIÓN ESTRICTA DE MULTER ---
const upload = multer({
  dest: 'uploads/',
  limits: { 
    fileSize: 15 * 1024 * 1024 // Máximo 15MB
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('audio/') || file.mimetype === 'video/mp4') {
      cb(null, true);
    } else {
      cb(new Error('Format de fichier non autorisé.'));
    }
  }
});

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const publicAudioDir = path.join(__dirname, 'public', 'audio');
fs.mkdirSync(publicAudioDir, { recursive: true });
app.use('/audio', express.static(publicAudioDir));

const dataDir = path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'app.sqlite'));
db.pragma('journal_mode = WAL');

// --- ESTRUCTURA DE BASE DE DATOS ---
db.exec(`
  CREATE TABLE IF NOT EXISTS lifetime_usage (
    user_id TEXT PRIMARY KEY,
    count INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS stories (
    story_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    story_text TEXT NOT NULL,
    audio_token TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS user_voices (
    voice_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_stories_user_id ON stories(user_id);
  CREATE INDEX IF NOT EXISTS idx_user_voices_user_id ON user_voices(user_id);
`);

const premiumCache = new Map();

function getTotalUsage(userId) {
  const row = db.prepare(`SELECT count FROM lifetime_usage WHERE user_id = ?`).get(userId);
  if (!row) {
    db.prepare(`INSERT INTO lifetime_usage (user_id, count, updated_at) VALUES (?, 0, ?)`).run(userId, new Date().toISOString());
    return 0;
  }
  return row.count;
}

function incrementTotalUsage(userId) {
  const existing = db.prepare(`SELECT count FROM lifetime_usage WHERE user_id = ?`).get(userId);
  if (!existing) {
    db.prepare(`INSERT INTO lifetime_usage (user_id, count, updated_at) VALUES (?, 1, ?)`).run(userId, new Date().toISOString());
  } else {
    db.prepare(`UPDATE lifetime_usage SET count = count + 1, updated_at = ? WHERE user_id = ?`).run(new Date().toISOString(), userId);
  }
}

function saveStory({ storyId, userId, storyText, audioToken }) {
  db.prepare(`INSERT OR REPLACE INTO stories (story_id, user_id, story_text, audio_token, created_at) VALUES (?, ?, ?, ?, ?)`).run(storyId, userId, storyText, audioToken, new Date().toISOString());
}

function getStory(storyId) {
  return db.prepare(`SELECT story_id, user_id, story_text, audio_token FROM stories WHERE story_id = ?`).get(storyId);
}

function saveUserVoice(voiceId, userId, name) {
  db.prepare(`INSERT INTO user_voices (voice_id, user_id, name, created_at) VALUES (?, ?, ?, ?)`).run(voiceId, userId, name, new Date().toISOString());
}

function getUserVoice(voiceId, userId) {
  return db.prepare(`SELECT voice_id FROM user_voices WHERE voice_id = ? AND user_id = ?`).get(voiceId, userId);
}

function deleteUserVoice(voiceId, userId) {
  db.prepare(`DELETE FROM user_voices WHERE voice_id = ? AND user_id = ?`).run(voiceId, userId);
}

function hasActiveEntitlement(subscriber, entitlementId = 'premium') {
  const entitlement = subscriber?.entitlements?.[entitlementId];
  if (!entitlement) return false;
  if (!entitlement.expires_date) return true;
  const expiresAt = new Date(entitlement.expires_date).getTime();
  if (Number.isNaN(expiresAt)) return false;
  return expiresAt > Date.now();
}

async function getPremiumStatus(rcUserId) {
  const cached = premiumCache.get(rcUserId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  let isPremium = false;
  try {
    const rcResponse = await fetch(`https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(rcUserId)}`, {
      headers: { Authorization: `Bearer ${process.env.REVENUECAT_SECRET_KEY}`, 'Content-Type': 'application/json' },
    });
    if (rcResponse.ok) {
      const rcData = await rcResponse.json();
      isPremium = hasActiveEntitlement(rcData?.subscriber, 'premium');
    }
  } catch (error) {} 

  if (isPremium) {
    premiumCache.set(rcUserId, { value: true, expiresAt: Date.now() + 5 * 60 * 1000 });
  } else {
    premiumCache.set(rcUserId, { value: false, expiresAt: Date.now() + 5 * 1000 });
  }
  
  return isPremium;
}

async function attachAccessContext(req, res, next) {
  let rcUserId = req.headers['x-rc-user-id'] || req.headers['x-rc-userid'];
  
  if (!rcUserId && req.body && req.body.rcUserId) rcUserId = req.body.rcUserId;
  if (!rcUserId && req.query && req.query.rcUserId) rcUserId = req.query.rcUserId;

  if (!rcUserId || typeof rcUserId !== 'string') {
    return res.status(401).json({ error: 'Identification manquante' });
  }
  
  req.rcUserId = rcUserId;
  req.isPremium = await getPremiumStatus(rcUserId);
  next();
}

async function enforceStoryQuota(req, res, next) {
  await attachAccessContext(req, res, async () => {
    if (req.isPremium) return next();
    
    const used = getTotalUsage(req.rcUserId);
    if (used >= 1) {
      return res.status(429).json({ error: 'Limite gratuite atteinte' });
    }
    next();
  });
}

function chunkText(text, maxLength) {
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
  const chunks = [];
  let currentChunk = '';
  for (const sentence of sentences) {
    if ((currentChunk + sentence).length > maxLength) {
      if (currentChunk.trim()) chunks.push(currentChunk.trim());
      currentChunk = sentence;
    } else {
      currentChunk += ` ${sentence}`;
    }
  }
  if (currentChunk.trim()) chunks.push(currentChunk.trim());
  return chunks.length > 0 ? chunks : [text];
}

app.get('/', (req, res) => res.json({ ok: true }));

app.post('/api/voice/clone', attachAccessContext, voiceCloneLimiter, (req, res, next) => {
  upload.single('audio')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}, async (req, res) => {
  try {
    if (!req.isPremium) {
      if (req.file) fs.unlinkSync(req.file.path);
      return res.status(403).json({ error: 'Premium requis pour cloner une voix' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'Aucun fichier audio reçu' });
    }

    const voiceName = req.body.voiceName || 'Voix Magique';
    const formData = new FormData();
    formData.append('name', voiceName);
    formData.append('description', `Voix app Cuentos - User: ${req.rcUserId.slice(-6)}`);
    formData.append('files', fs.createReadStream(req.file.path), {
      filename: req.file.originalname,
      contentType: req.file.mimetype,
    });

    const elevenLabsResponse = await axios.post(
      'https://api.elevenlabs.io/v1/voices/add',
      formData,
      { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, ...formData.getHeaders() } }
    );

    fs.unlinkSync(req.file.path); 
    const newVoiceId = elevenLabsResponse.data.voice_id;

    saveUserVoice(newVoiceId, req.rcUserId, voiceName);

    res.status(200).json({ success: true, voiceId: newVoiceId });
  } catch (error) {
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path); 
    res.status(500).json({ error: 'Erreur lors de la création de la voix' });
  }
});

app.delete('/api/voice/:voiceId', attachAccessContext, async (req, res) => {
  try {
    const { voiceId } = req.params;

    const voiceRecord = getUserVoice(voiceId, req.rcUserId);
    if (!voiceRecord) {
      return res.status(403).json({ error: 'Non autorisé à supprimer cette voix' });
    }

    await axios.delete(`https://api.elevenlabs.io/v1/voices/${voiceId}`, {
      headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY }
    });

    deleteUserVoice(voiceId, req.rcUserId);

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Erreur lors de la suppression' });
  }
});

app.post('/api/story/generate', enforceStoryQuota, async (req, res) => {
  try {
    const { childName, childAge, theme, storyline, language = 'fr' } = req.body;
    if (!childName || !childAge || !theme) return res.status(400).json({ error: 'Faltan datos' });

    const prompt = `You are a master sleep-therapist and children's storyteller. Write a BEDTIME STORY in ${language} for ${childName} (${childAge} years old). Theme: ${theme}. Storyline: ${storyline || 'Une aventure douce et magique'}. CRITICAL REQUIREMENTS: 1. Length: Exactly between 800 and 950 words. 2. Format: This is an AUDIO SCRIPT for a TTS engine. You MUST use short sentences, abundant ellipses (...) to force slow, relaxing pauses, and exclamation/question marks for emotional expression. 3. Tone: Hypnotic, whispered, safe. Use sensory words (warm, soft, floating, heavy eyelids). 4. Name Repetition: Use the name "${childName}" strategically at least 6-8 times. 5. Age Adaptation: The child is ${childAge} years old. STRUCTURE (5 PARTS): 1. Calm Introduction. 2. Soft Adventure. 3. Small Emotional Conflict. 4. Resolution. 5. Sleep Closure. Return ONLY valid JSON: {"title": "A magical title", "storyText": "Full story with paragraph breaks (\\n\\n)", "imagePrompt": "A highly detailed description of the main scene."}`;

    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are an elite children bedtime storyteller. You strictly follow word counts and return valid JSON.' },
        { role: 'user', content: prompt },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.7,
    });

    const parsed = JSON.parse(response.choices[0].message.content);
    let imageUrl = null;

    if (parsed.imagePrompt) {
      try {
        const imageRes = await client.images.generate({
          model: 'dall-e-3',
          prompt: `Soft, dreamy watercolor children's book illustration. Warm nighttime bedtime story style. Highly detailed, calming atmosphere. Scene: ${parsed.imagePrompt}`,
          n: 1, size: '1024x1024',
        });
        imageUrl = imageRes.data[0].url;
      } catch (imgError) {}
    }

    const storyId = crypto.randomUUID();
    const audioToken = crypto.createHmac('sha256', process.env.STORY_TOKEN_SECRET).update(`${storyId}:${req.rcUserId}:${Date.now()}:${Math.random()}`).digest('hex');

    saveStory({ storyId, userId: req.rcUserId, storyText: parsed.storyText || '', audioToken });

    if (!req.isPremium) {
      incrementTotalUsage(req.rcUserId);
    }

    res.json({
      storyId, audioToken,
      title: parsed.title || `L'aventure de ${childName}`,
      storyText: parsed.storyText || '',
      imageUrl,
    });
  } catch (error) {
    res.status(500).json({ error: 'Error generando el cuento' });
  }
});

app.post('/api/story/tts', attachAccessContext, ttsLimiter, async (req, res) => {
  try {
    const { storyId, audioToken, voice = 'nova', speed = 0.88, customVoiceId } = req.body;

    let sourceText = '';
    if (storyId && audioToken) {
      const story = getStory(storyId);
      // ARREGLO DE SEGURIDAD: 
      // Solo pedimos que el Token encriptado coincida. 
      // Eliminamos la comprobación de ID de usuario para permitir que los usuarios 
      // con compras restauradas puedan escuchar sus propios cuentos antiguos.
      if (story && story.audio_token === audioToken) {
        sourceText = story.story_text;
      }
    }

    if (!sourceText) {
      return res.status(403).json({ error: 'Accès audio non autorisé ou histoire introuvable' });
    }

    if (customVoiceId) {
      const voiceRecord = getUserVoice(customVoiceId, req.rcUserId);
      if (!voiceRecord) {
        return res.status(403).json({ error: 'Voix non autorisée ou inexistante' });
      }
    }

    const chunks = chunkText(sourceText, 3500);
    const audioBuffers = [];

    if (customVoiceId) { 
        for (const chunk of chunks) {
            const response = await axios.post(
                `https://api.elevenlabs.io/v1/text-to-speech/${customVoiceId}`,
                { text: chunk, model_id: "eleven_multilingual_v2", voice_settings: { stability: 0.5, similarity_boost: 0.75 } },
                { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json' }, responseType: 'arraybuffer' }
            );
            audioBuffers.push(Buffer.from(response.data, 'binary'));
        }
    } else {
        for (const chunk of chunks) {
          const mp3 = await client.audio.speech.create({
            model: 'tts-1-hd', voice, input: chunk, speed, response_format: 'mp3',
          });
          const arrayBuffer = await mp3.arrayBuffer();
          audioBuffers.push(Buffer.from(arrayBuffer));
        }
    }

    res.json({ audioBase64: Buffer.concat(audioBuffers).toString('base64'), mimeType: 'audio/mpeg' });
  } catch (error) {
    res.status(500).json({ error: 'Erreur lors de la génération audio' });
  }
});

const port = process.env.PORT || 3001;
app.listen(port, () => console.log(`Serveur actif sur le port ${port}`));