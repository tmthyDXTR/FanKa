const express = require('express');
const db = require('../db');
const { requireAuth } = require('../auth/middleware');

const router = express.Router();
router.use(requireAuth);

function ownsDeck(deckId, userId) {
  return db.prepare('SELECT id FROM decks WHERE id = ? AND owner_id = ?').get(deckId, userId);
}

router.get('/', (req, res) => {
  const rows = db
    .prepare(
      `SELECT d.id AS id, d.name AS name, COUNT(c.id) AS cardCount
       FROM decks d LEFT JOIN deck_cards c ON c.deck_id = d.id
       WHERE d.owner_id = ?
       GROUP BY d.id
       ORDER BY d.id`
    )
    .all(req.user.sub);
  res.json(rows);
});

router.post('/', (req, res) => {
  const name = (req.body?.name || '').trim();
  if (!name) {
    return res.status(400).json({ error: 'Name is required.' });
  }

  const info = db.prepare('INSERT INTO decks (name, owner_id) VALUES (?, ?)').run(name, req.user.sub);
  res.status(201).json({ id: info.lastInsertRowid, name, cardCount: 0 });
});

router.delete('/:id', (req, res) => {
  const deckId = Number(req.params.id);
  if (!ownsDeck(deckId, req.user.sub)) return res.status(404).end();

  db.prepare('DELETE FROM decks WHERE id = ?').run(deckId);
  res.status(204).end();
});

router.get('/:id/settings', (req, res) => {
  const deckId = Number(req.params.id);
  const deck = db
    .prepare('SELECT hard_delay_minutes, easy_delay_minutes, done_delay_minutes FROM decks WHERE id = ? AND owner_id = ?')
    .get(deckId, req.user.sub);
  if (!deck) return res.status(404).end();

  res.json({
    hardDelayMinutes: deck.hard_delay_minutes,
    easyDelayMinutes: deck.easy_delay_minutes,
    doneDelayMinutes: deck.done_delay_minutes,
  });
});

router.put('/:id/settings', (req, res) => {
  const deckId = Number(req.params.id);
  if (!ownsDeck(deckId, req.user.sub)) return res.status(404).end();

  const hard = Math.max(0, Number(req.body?.hardDelayMinutes) || 0);
  const easy = Math.max(0, Number(req.body?.easyDelayMinutes) || 0);
  const done = Math.max(0, Number(req.body?.doneDelayMinutes) || 0);
  db.prepare(
    'UPDATE decks SET hard_delay_minutes = ?, easy_delay_minutes = ?, done_delay_minutes = ? WHERE id = ?'
  ).run(hard, easy, done, deckId);
  res.json({ hardDelayMinutes: hard, easyDelayMinutes: easy, doneDelayMinutes: done });
});

router.get('/:id/cards', (req, res) => {
  const deckId = Number(req.params.id);
  if (!ownsDeck(deckId, req.user.sub)) return res.status(404).end();

  const cards = db
    .prepare(
      `SELECT id, hanzi, pinyin, english, bucket, easy_streak AS easyStreak, ready_at AS readyAt
       FROM deck_cards WHERE deck_id = ? ORDER BY id`
    )
    .all(deckId);
  res.json(cards);
});

router.post('/:id/cards', (req, res) => {
  const deckId = Number(req.params.id);
  if (!ownsDeck(deckId, req.user.sub)) return res.status(404).end();

  const { hanzi, pinyin, english } = req.body || {};
  if (![hanzi, pinyin, english].every((v) => typeof v === 'string' && v.trim())) {
    return res.status(400).json({ error: 'Hanzi, Pinyin and English are all required.' });
  }

  const info = db
    .prepare('INSERT INTO deck_cards (deck_id, hanzi, pinyin, english) VALUES (?, ?, ?, ?)')
    .run(deckId, hanzi.trim(), pinyin.trim(), english.trim());

  res.status(201).json({
    id: info.lastInsertRowid,
    hanzi: hanzi.trim(),
    pinyin: pinyin.trim(),
    english: english.trim(),
    bucket: 'remaining',
    easyStreak: 0,
    readyAt: null,
  });
});

router.post('/:id/cards/import', (req, res) => {
  const deckId = Number(req.params.id);
  if (!ownsDeck(deckId, req.user.sub)) return res.status(404).end();

  const rows = Array.isArray(req.body?.cards) ? req.body.cards : [];
  const valid = rows
    .map((c) => ({
      hanzi: String(c?.hanzi ?? '').trim(),
      pinyin: String(c?.pinyin ?? '').trim(),
      english: String(c?.english ?? '').trim(),
    }))
    .filter((c) => c.hanzi && c.pinyin && c.english);

  if (valid.length === 0) {
    return res.status(400).json({ error: 'No valid cards to import.' });
  }

  const insert = db.prepare('INSERT INTO deck_cards (deck_id, hanzi, pinyin, english) VALUES (?, ?, ?, ?)');
  const insertAll = db.transaction((cards) =>
    cards.map((c) => {
      const info = insert.run(deckId, c.hanzi, c.pinyin, c.english);
      return { id: info.lastInsertRowid, hanzi: c.hanzi, pinyin: c.pinyin, english: c.english, bucket: 'remaining', easyStreak: 0, readyAt: null };
    })
  );

  res.status(201).json(insertAll(valid));
});

router.put('/:deckId/cards/:cardId/progress', (req, res) => {
  const deckId = Number(req.params.deckId);
  const cardId = Number(req.params.cardId);
  if (!ownsDeck(deckId, req.user.sub)) return res.status(404).end();

  const card = db.prepare('SELECT id FROM deck_cards WHERE id = ? AND deck_id = ?').get(cardId, deckId);
  if (!card) return res.status(404).end();

  const { bucket, easyStreak, readyAt } = req.body || {};
  db.prepare('UPDATE deck_cards SET bucket = ?, easy_streak = ?, ready_at = ? WHERE id = ?').run(
    String(bucket ?? 'remaining'),
    Number(easyStreak) || 0,
    readyAt ?? null,
    cardId
  );
  res.status(204).end();
});

router.put('/:deckId/cards/:cardId', (req, res) => {
  const deckId = Number(req.params.deckId);
  const cardId = Number(req.params.cardId);
  if (!ownsDeck(deckId, req.user.sub)) return res.status(404).end();

  const { hanzi, pinyin, english } = req.body || {};
  if (![hanzi, pinyin, english].every((v) => typeof v === 'string' && v.trim())) {
    return res.status(400).json({ error: 'Hanzi, Pinyin and English are all required.' });
  }

  const result = db
    .prepare('UPDATE deck_cards SET hanzi = ?, pinyin = ?, english = ? WHERE id = ? AND deck_id = ?')
    .run(hanzi.trim(), pinyin.trim(), english.trim(), cardId, deckId);
  if (result.changes === 0) return res.status(404).end();
  res.json({ id: cardId, hanzi: hanzi.trim(), pinyin: pinyin.trim(), english: english.trim() });
});

router.delete('/:deckId/cards/:cardId', (req, res) => {
  const deckId = Number(req.params.deckId);
  const cardId = Number(req.params.cardId);
  if (!ownsDeck(deckId, req.user.sub)) return res.status(404).end();

  const result = db.prepare('DELETE FROM deck_cards WHERE id = ? AND deck_id = ?').run(cardId, deckId);
  if (result.changes === 0) return res.status(404).end();
  res.status(204).end();
});

module.exports = router;
