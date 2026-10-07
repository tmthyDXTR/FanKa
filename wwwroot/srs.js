// Spaced-repetition scheduling, kept free of DOM/WASM so it can be unit-tested in Node.
//
// Learning phase (minutes): new cards and lapsed cards. Wrong/Hard repeat after a short delay,
// Easy graduates the card into the Review phase.
// Review phase (days): every Easy follows REVIEW_LADDER_DAYS, then multiplies by EASY_MULTIPLIER.
// Hard grows the interval by only HARD_MULTIPLIER; Wrong is a lapse that sends the card back to
// Learning and re-graduates it with a reduced interval.

export const REVIEW_LADDER_DAYS = [1, 3, 7, 16, 35];
export const EASY_MULTIPLIER = 2.2;
export const HARD_MULTIPLIER = 1.2;
export const LAPSE_INTERVAL_FACTOR = 0.35;

// One pile per rung of the review ladder, so progress stays visible instead of disappearing
// into a single "Done" bucket once a card matures. The last rung keeps collecting every card
// that outgrows the fixed ladder (interval growing by EASY_MULTIPLIER forever).
export const REVIEW_LADDER_BUCKETS = ['review-1d', 'review-3d', 'review-7d', 'review-16d', 'review-mature'];

export const DEFAULT_SETTINGS = { wrongDelayMinutes: 1, hardDelayMinutes: 10, lapseDelayMinutes: 10 };

const MS_PER_MINUTE = 60000;
const MS_PER_DAY = 86400000;

export function newCardMeta(serverId = null) {
  return { serverId, bucket: 'remaining', phase: 'learning', reviewStep: 0, intervalDays: 0, readyAt: null };
}

export function metaFromServer(card) {
  const phase = card.phase === 'review' ? 'review' : 'learning';
  const reviewStep = Number(card.reviewStep) || 0;
  return {
    serverId: card.id,
    // Re-derive the pile instead of trusting the stored string, so decks saved before the
    // ladder piles existed (bucket 'easy'/'done') display correctly without a data migration.
    bucket: card.bucket === 'hard' ? 'hard' : reviewBucket(phase, reviewStep),
    phase,
    reviewStep,
    intervalDays: Number(card.intervalDays) || 0,
    readyAt: card.readyAt ? new Date(card.readyAt) : null
  };
}

// Pile shown in the UI: Hard = last answer was Hard, Remaining = new/learning,
// review-1d..review-mature = which rung of the review ladder the card has reached.
function reviewBucket(phase, reviewStep) {
  if (phase !== 'review') return 'remaining';
  return REVIEW_LADDER_BUCKETS[Math.min(reviewStep, REVIEW_LADDER_BUCKETS.length - 1)];
}

function ladderStepFor(intervalDays) {
  let step = 0;
  REVIEW_LADDER_DAYS.forEach((days, i) => {
    if (days <= intervalDays) step = i;
  });
  return step;
}

function graduate(meta, now) {
  // A lapsed card keeps its old interval so it can return at a fraction of it
  const days = meta.intervalDays > 0
    ? Math.max(REVIEW_LADDER_DAYS[0], Math.round(meta.intervalDays * LAPSE_INTERVAL_FACTOR))
    : REVIEW_LADDER_DAYS[0];

  meta.phase = 'review';
  meta.intervalDays = days;
  meta.reviewStep = ladderStepFor(days);
  meta.bucket = reviewBucket(meta.phase, meta.reviewStep);
  meta.readyAt = new Date(now + days * MS_PER_DAY);
}

export function applyEasy(meta, now = Date.now()) {
  if (meta.phase !== 'review') {
    graduate(meta, now);
    return meta;
  }

  const nextStep = meta.reviewStep + 1;
  const days = nextStep < REVIEW_LADDER_DAYS.length
    ? Math.max(REVIEW_LADDER_DAYS[nextStep], meta.intervalDays)
    : meta.intervalDays * EASY_MULTIPLIER;

  meta.reviewStep = Math.min(nextStep, REVIEW_LADDER_DAYS.length - 1);
  meta.intervalDays = days;
  meta.bucket = reviewBucket(meta.phase, meta.reviewStep);
  meta.readyAt = new Date(now + days * MS_PER_DAY);
  return meta;
}

export function applyHard(meta, settings = DEFAULT_SETTINGS, now = Date.now()) {
  if (meta.phase === 'review') {
    meta.intervalDays *= HARD_MULTIPLIER;
    meta.readyAt = new Date(now + meta.intervalDays * MS_PER_DAY);
  } else {
    meta.readyAt = new Date(now + settings.hardDelayMinutes * MS_PER_MINUTE);
  }
  meta.bucket = 'hard';
  return meta;
}

export function applyWrong(meta, settings = DEFAULT_SETTINGS, now = Date.now()) {
  const lapse = meta.phase === 'review';
  meta.phase = 'learning';
  meta.reviewStep = 0;
  meta.bucket = 'remaining';
  const delay = lapse ? settings.lapseDelayMinutes : settings.wrongDelayMinutes;
  meta.readyAt = new Date(now + delay * MS_PER_MINUTE);
  return meta;
}

export function formatInterval(ms) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}
