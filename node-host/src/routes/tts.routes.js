const express = require('express');

const router = express.Router();

// Proxies the (unofficial, free) Google Translate TTS endpoint same-origin, since calling it
// directly from <audio src> triggers a Range request that endpoint answers with a 404.
router.get('/', async (req, res) => {
  const text = typeof req.query.text === 'string' ? req.query.text.trim() : '';
  if (!text) {
    return res.status(400).json({ error: 'text is required.' });
  }

  const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(text)}&tl=zh-CN&client=tw-ob`;

  try {
    const upstream = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!upstream.ok) {
      return res.status(upstream.status).end();
    }

    const audio = Buffer.from(await upstream.arrayBuffer());
    res.set('Content-Type', 'audio/mpeg');
    res.send(audio);
  } catch {
    res.status(502).json({ error: 'Failed to reach the TTS service.' });
  }
});

module.exports = router;
