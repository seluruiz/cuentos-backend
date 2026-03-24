require('dotenv').config();

const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const Database = require('better-sqlite3');

const app = express();

app.set('trust proxy', true);
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de requêtes, veuillez réessayer plus tard.' },
});

app.use('/api/', apiLimiter);

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

db.exec(`
  CREATE TABLE IF NOT EXISTS daily_usage (
    user_id TEXT NOT NULL,
    day TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, day)
  );

  CREATE TABLE IF NOT EXISTS stories (
    story_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    story_text TEXT NOT NULL,
    audio_token TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_stories_user_id ON stories(user_id);
`);

const premiumCache = new Map();
const PREMIUM_CACHE_MS = 5 * 60 * 1000;

function getTodayString() {
  return new Date().toISOString().slice(0, 10);
}

function getOrCreateDailyUsage(userId, day) {
  const row = db
    .prepare(`SELECT count FROM daily_usage WHERE user_id = ? AND day = ?`)
    .get(userId, day);

  if (!row) {
    db.prepare(`
      INSERT INTO daily_usage (user_id, day, count, updated_at)
      VALUES (?, ?, 0, ?)
    `).run(userId, day, new Date().toISOString());
    return 0;
  }

  return row.count;
}

function incrementDailyUsage(userId, day) {
  const existing = db
    .prepare(`SELECT count FROM daily_usage WHERE user_id = ? AND day = ?`)
    .get(userId, day);

  if (!existing) {
    db.prepare(`
      INSERT INTO daily_usage (user_id, day, count, updated_at)
      VALUES (?, ?, 1, ?)
    `).run(userId, day, new Date().toISOString());
    return;
  }

  db.prepare(`
    UPDATE daily_usage
    SET count = count + 1, updated_at = ?
    WHERE user_id = ? AND day = ?
  `).run(new Date().toISOString(), userId, day);
}

function saveStory({ storyId, userId, storyText, audioToken }) {
  db.prepare(`
    INSERT OR REPLACE INTO stories (story_id, user_id, story_text, audio_token, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    storyId,
    userId,
    storyText,
    audioToken,
    new Date().toISOString()
  );
}

function getStory(storyId) {
  return db
    .prepare(`SELECT story_id, user_id, story_text, audio_token FROM stories WHERE story_id = ?`)
    .get(storyId);
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
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  let isPremium = false;

  try {
    const rcResponse = await fetch(
      `https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(rcUserId)}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.REVENUECAT_SECRET_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    if (rcResponse.ok) {
      const rcData = await rcResponse.json();
      isPremium = hasActiveEntitlement(rcData?.subscriber, 'premium');
    }
  } catch (error) {
    console.error('Error validando con RevenueCat:', error);
  }

  premiumCache.set(rcUserId, {
    value: isPremium,
    expiresAt: Date.now() + PREMIUM_CACHE_MS,
  });

  return isPremium;
}

async function attachAccessContext(req, res, next) {
  const { rcUserId } = req.body;

  if (!rcUserId || typeof rcUserId !== 'string') {
    return res.status(400).json({ error: 'rcUserId manquant' });
  }

  req.rcUserId = rcUserId;
  req.isPremium = await getPremiumStatus(rcUserId);

  next();
}

async function enforceStoryQuota(req, res, next) {
  await attachAccessContext(req, res, async () => {
    if (req.isPremium) {
      return next();
    }

    const today = getTodayString();
    const used = getOrCreateDailyUsage(req.rcUserId, today);

    if (used >= 1) {
      return res.status(429).json({ error: 'Límite gratuito diario alcanzado' });
    }

    req.usageDay = today;
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

app.get('/', (req, res) => {
  res.json({ ok: true, message: 'Backend funcionando y seguro' });
});

app.post('/api/story/generate', enforceStoryQuota, async (req, res) => {
  try {
    const { childName, childAge, theme, storyline, language = 'fr' } = req.body;

    if (!childName || !childAge || !theme) {
      return res.status(400).json({ error: 'Faltan datos' });
    }

    const prompt = `
You are a master sleep-therapist and children's storyteller. Write a BEDTIME STORY in ${language} for ${childName} (${childAge} years old).
Theme: ${theme}. Storyline: ${storyline || 'Une aventure douce et magique'}.

CRITICAL REQUIREMENTS:
- Length: Exactly between 800 and 950 words.
- Name Repetition: Use the name "${childName}" strategically at least 6-8 times.
- Age Adaptation: The child is ${childAge}. If age is 2-4, use very simple words and short sentences. If age is 5+, use more descriptive and narrative language.
- Tone: Hypnotic, slow, safe. Use sensory words (warm, soft, floating, heavy eyelids).

STRUCTURE (MUST BE EXACTLY 5 PARTS):
1. Calm Introduction.
2. Soft Adventure.
3. Small Emotional Conflict.
4. Resolution.
5. Sleep Closure.

Return ONLY valid JSON:
{
  "title": "A magical title",
  "storyText": "Full story with paragraph breaks (\\n\\n)",
  "imagePrompt": "A highly detailed description of the main scene."
}
`;

    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content:
            'You are an elite children bedtime storyteller. You strictly follow word counts and return valid JSON.',
        },
        { role: 'user', content: prompt },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.7,
    });

    const parsed = JSON.parse(response.choices[0].message.content);

    let imageUrl = null;

    if (parsed.imagePrompt) {
      try {
        const finalImagePrompt = `Soft, dreamy watercolor children's book illustration. Warm nighttime bedtime story style. Highly detailed, calming atmosphere. Scene: ${parsed.imagePrompt}`;

        const imageRes = await client.images.generate({
          model: 'dall-e-3',
          prompt: finalImagePrompt,
          n: 1,
          size: '1024x1024',
        });

        imageUrl = imageRes.data[0].url;
      } catch (imgError) {
        console.error('Error imagen:', imgError);
      }
    }

    const storyId = crypto.randomUUID();
    const audioToken = crypto
      .createHmac('sha256', process.env.STORY_TOKEN_SECRET)
      .update(`${storyId}:${req.rcUserId}:${Date.now()}:${Math.random()}`)
      .digest('hex');

    saveStory({
      storyId,
      userId: req.rcUserId,
      storyText: parsed.storyText || '',
      audioToken,
    });

    if (!req.isPremium) {
      incrementDailyUsage(req.rcUserId, req.usageDay);
    }

    res.json({
      storyId,
      audioToken,
      title: parsed.title || `L'aventure de ${childName}`,
      storyText: parsed.storyText || '',
      imagePrompt: parsed.imagePrompt || '',
      imageUrl,
    });
  } catch (error) {
    console.error('Error generando cuento:', error);
    res.status(500).json({ error: 'Error generando el cuento' });
  }
});

app.post('/api/story/tts', attachAccessContext, async (req, res) => {
  try {
    const { storyId, audioToken, text, voice = 'nova', speed = 0.88 } = req.body;

    let sourceText = '';

    if (storyId && audioToken) {
      const story = getStory(storyId);

      if (
        story &&
        story.user_id === req.rcUserId &&
        story.audio_token === audioToken
      ) {
        sourceText = story.story_text;
      }
    }

    // Fallback solo para premium: reproducir cuentos antiguos sin token
    if (!sourceText && req.isPremium && text) {
      sourceText = text;
    }

    if (!sourceText) {
      return res.status(403).json({
        error: 'Accès audio non autorisé',
      });
    }

    const chunks = chunkText(sourceText, 3500);
    const audioBuffers = [];

    for (const chunk of chunks) {
      const mp3 = await client.audio.speech.create({
        model: 'tts-1-hd',
        voice,
        input: chunk,
        speed,
        response_format: 'mp3',
      });

      const arrayBuffer = await mp3.arrayBuffer();
      audioBuffers.push(Buffer.from(arrayBuffer));
    }

    const finalBuffer = Buffer.concat(audioBuffers);

    res.json({
      audioBase64: finalBuffer.toString('base64'),
      mimeType: 'audio/mpeg',
    });
  } catch (error) {
    console.error('Error generando audio:', error);
    res.status(500).json({
      error: 'Error generando el audio',
      details: error.message,
    });
  }
});

const port = process.env.PORT || 3001;
app.listen(port, () => {
  console.log(`Servidor funcionando en http://localhost:${port}`);
});