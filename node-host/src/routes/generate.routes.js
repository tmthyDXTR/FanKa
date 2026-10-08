const fs = require('fs');
const path = require('path');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { requireAuth } = require('../auth/middleware');

const router = express.Router();

router.use(requireAuth);

const generateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Generation limit reached. Try again later.' },
});

const DEFAULT_CONFIG = {
  model: null,
  temperature: 0.7,
  maxTokensPerCard: 180,
  maxTokensCap: 4096,
  timeoutMs: 90_000,
  systemPrompt: 'Create useful Mandarin Chinese flashcards, using everyday language that a native speaker would use. Return only a JSON object with a "cards" array. Each card must have exactly these string fields: "hanzi" (a natural Chinese sentence or phrase) and "english" (natural English translation). Make every card relevant to the requested topic and distinct. Return the exact requested number.',
  userPrompt: 'Create exactly {count} distinct Mandarin flashcards about: {topic}',
  extraParams: {},
};

// Params that must not be overridden through extraParams.
const RESERVED_PARAMS = new Set(['model', 'messages', 'stream', 'temperature', 'max_tokens']);

const CONFIG_PATH = process.env.LLM_CONFIG_PATH || path.join(__dirname, '..', '..', 'data', 'llm-config.json');

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function nonEmptyString(value, fallback) {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function renderTemplate(template, vars) {
  return template.replace(/\{(count|topic)\}/g, (_, key) => String(vars[key]));
}

// Read on every request so edits to the file apply without restarting the app.
// Missing or invalid files fall back to the defaults; values are clamped to safe ranges.
function loadGenerationConfig() {
  let file = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) file = parsed;
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn(`Ignoring ${CONFIG_PATH}: ${error.message}`);
  }

  const extraParams = {};
  if (file.extraParams && typeof file.extraParams === 'object' && !Array.isArray(file.extraParams)) {
    for (const [key, value] of Object.entries(file.extraParams)) {
      if (!RESERVED_PARAMS.has(key)) extraParams[key] = value;
    }
  }

  return {
    model: nonEmptyString(file.model, process.env.LLM_MODEL?.trim() || DEFAULT_CONFIG.model),
    temperature: clampNumber(file.temperature, 0, 2, DEFAULT_CONFIG.temperature),
    maxTokensPerCard: clampNumber(file.maxTokensPerCard, 20, 1000, DEFAULT_CONFIG.maxTokensPerCard),
    maxTokensCap: clampNumber(file.maxTokensCap, 256, 8192, DEFAULT_CONFIG.maxTokensCap),
    timeoutMs: clampNumber(file.timeoutMs, 5_000, 180_000, DEFAULT_CONFIG.timeoutMs),
    systemPrompt: nonEmptyString(file.systemPrompt, DEFAULT_CONFIG.systemPrompt),
    userPrompt: nonEmptyString(file.userPrompt, DEFAULT_CONFIG.userPrompt),
    extraParams,
  };
}

function getProviderUrl() {
  const baseUrl = process.env.LLM_API_BASE_URL?.trim();
  if (!baseUrl) return null;

  const url = new URL(baseUrl);
  const localHost = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && localHost)) {
    throw new Error('LLM_API_BASE_URL must use HTTPS (HTTP is allowed for localhost).');
  }

  return `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
}

function parseCards(content) {
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  const jsonText = start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned;
  const parsed = JSON.parse(jsonText);
  if (!parsed || !Array.isArray(parsed.cards)) {
    throw new Error('The model response must contain a cards array.');
  }

  return parsed.cards.map((card) => ({
    hanzi: typeof card?.hanzi === 'string' ? card.hanzi.trim() : '',
    english: typeof card?.english === 'string' ? card.english.trim() : '',
  }));
}

function extractResponseText(data) {
  const message = data?.choices?.[0]?.message;
  const content = message?.content ?? data?.output_text;

  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (typeof part?.text === 'string') return part.text;
        return '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  if (typeof content?.text === 'string') return content.text.trim();

  return '';
}

router.post('/generate-cards', generateLimiter, async (req, res) => {
  const topic = typeof req.body?.topic === 'string' ? req.body.topic.trim() : '';
  const count = Number(req.body?.count);
  if (topic.length < 3 || topic.length > 300) {
    return res.status(400).json({ error: 'Topic must be between 3 and 300 characters.' });
  }
  if (!Number.isInteger(count) || count < 1 || count > 20) {
    return res.status(400).json({ error: 'Count must be a whole number between 1 and 20.' });
  }

  const cfg = loadGenerationConfig();
  const model = cfg.model;
  let url;
  try {
    url = getProviderUrl();
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
  if (!url || !model) {
    return res.status(503).json({
      error: 'Card generation is not configured. Set LLM_API_BASE_URL and LLM_MODEL on the server.',
    });
  }

  const headers = { 'Content-Type': 'application/json' };
  if (process.env.LLM_API_KEY) headers.Authorization = `Bearer ${process.env.LLM_API_KEY}`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(cfg.timeoutMs),
      body: JSON.stringify({
        model,
        temperature: 0.6,
        max_tokens: Math.min(count * 180, 4096),
        messages: [
          {
            role: 'system',
            content: cfg.systemPrompt,
          },
          {
            role: 'user',
            content: renderTemplate(cfg.userPrompt, { count, topic }),
          },
        ],
      }),
    });

    if (!response.ok) {
      console.error(`LLM provider returned HTTP ${response.status}.`);
      return res.status(502).json({ error: `The language model provider returned HTTP ${response.status}.` });
    }

    const data = await response.json();
    const content = extractResponseText(data);
    if (!content) {
      const finishReason = data?.choices?.[0]?.finish_reason;
      const reasonText = typeof finishReason === 'string' ? ` (finish reason: ${finishReason})` : '';
      console.error(`LLM provider returned no text content${reasonText}.`);
      return res.status(502).json({
        error: `The selected model returned no card text${reasonText}. Try again or set LLM_MODEL to a different model.`,
      });
    }

    let cards;
    try {
      cards = parseCards(content);
    } catch {
      return res.status(502).json({ error: 'The language model response was not valid card JSON. Try generating again.' });
    }

    const valid = cards.filter((card) => card.hanzi && card.english);
    if (valid.length < count) {
      return res.status(502).json({
        error: `The language model returned ${valid.length} valid cards; ${count} were requested. Try generating again.`,
      });
    }

    res.json({ cards: valid.slice(0, count) });
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      return res.status(504).json({ error: 'The language model request timed out. Try again.' });
    }
    console.error('Card generation request failed:', error.message);
    res.status(502).json({ error: 'Could not reach the language model provider. Check the server configuration and try again.' });
  }
});

module.exports = router;
