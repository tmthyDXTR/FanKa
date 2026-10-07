const express = require('express');

const router = express.Router();

const MAX_CACHE_ENTRIES = 500;
const MAX_TEXT_LENGTH = 200;
const MAX_UPSTREAM_REQUESTS = 2;

// Map keeps insertion order, so the first key is always the least recently used entry.
const cache = new Map();
const inFlight = new Map();
const waiting = [];
let activeUpstream = 0;

function cacheGet(text) {
  const audio = cache.get(text);
  if (audio) {
    cache.delete(text);
    cache.set(text, audio);
  }
  return audio;
}

function cacheSet(text, audio) {
  cache.set(text, audio);
  if (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
}

// Limits simultaneous requests to Google so bursts don't spike threads/sockets.
async function withUpstreamSlot(task) {
  if (activeUpstream >= MAX_UPSTREAM_REQUESTS) {
    await new Promise((resolve) => waiting.push(resolve));
  }
  activeUpstream += 1;
  try {
    return await task();
  } finally {
    activeUpstream -= 1;
    const next = waiting.shift();
    if (next) next();
  }
}

async function fetchAudio(text) {
  const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(text)}&tl=zh-CN&client=tw-ob`;
  const upstream = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000) });
  if (!upstream.ok) {
    const error = new Error('Upstream TTS failure');
    error.status = upstream.status;
    throw error;
  }
  return Buffer.from(await upstream.arrayBuffer());
}

// Proxies the (unofficial, free) Google Translate TTS endpoint same-origin, since calling it
// directly from <audio src> triggers a Range request that endpoint answers with a 404.
router.get('/', async (req, res) => {
  const text = typeof req.query.text === 'string' ? req.query.text.trim() : '';
  if (!text) {
    return res.status(400).json({ error: 'text is required.' });
  }
  if (text.length > MAX_TEXT_LENGTH) {
    return res.status(400).json({ error: 'text is too long.' });
  }

  let audio = cacheGet(text);

  if (!audio) {
    // Concurrent requests for the same text share a single upstream call
    let pending = inFlight.get(text);
    if (!pending) {
      pending = withUpstreamSlot(() => fetchAudio(text))
        .then((result) => {
          cacheSet(text, result);
          return result;
        })
        .finally(() => inFlight.delete(text));
      inFlight.set(text, pending);
    }

    try {
      audio = await pending;
    } catch (error) {
      if (error.status) return res.status(error.status).end();
      return res.status(502).json({ error: 'Failed to reach the TTS service.' });
    }
  }

  res.set('Content-Type', 'audio/mpeg');
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(audio);
});

module.exports = router;
