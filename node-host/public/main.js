import { dotnet } from './_framework/dotnet.js';
import {
  DEFAULT_SETTINGS, REVIEW_LADDER_BUCKETS,
  newCardMeta, metaFromServer, applyEasy, applyHard, applyWrong, formatInterval
} from './srs.js';

// Shrinks a group of text elements together (proportionally) until their shared
// card face stops overflowing, down to a readable floor. Grouping matters because
// e.g. pinyin + english share one card face, so a long one can push the other out.
const MIN_FONT_PX = 10;
const FONT_SCALE_STEP = 0.05;

function autoFitGroup(elements) {
  const els = elements.filter((el) => el && el.textContent);
  if (els.length === 0) return;

  const container = els[0].closest('.card-face');
  if (!container) return;

  els.forEach((el) => { el.style.fontSize = ''; }); // start from the slider-driven size

  const baseSizes = els.map((el) => parseFloat(getComputedStyle(el).fontSize));
  const minScale = MIN_FONT_PX / Math.max(...baseSizes);
  let scale = 1;

  while (
    scale > minScale &&
    (container.scrollHeight > container.clientHeight || container.scrollWidth > container.clientWidth)
  ) {
    scale -= FONT_SCALE_STEP;
    els.forEach((el, i) => {
      el.style.fontSize = `${Math.max(MIN_FONT_PX, baseSizes[i] * scale)}px`;
    });
  }
}

function autoFitCardText() {
  autoFitGroup([document.getElementById('frontHanzi')]);
  autoFitGroup([document.getElementById('backPinyin'), document.getElementById('backEnglish')]);
}

// ---------------------------------------------------------------------------
// 1. Immediate UI Event Listeners (Runs instantly before WASM initializes)
// ---------------------------------------------------------------------------
const inputHanzi = document.getElementById('inputHanzi');
const inputPinyin = document.getElementById('inputPinyin');

// Real-time Hanzi to Pinyin conversion via pinyin-pro CDN
inputHanzi.addEventListener('input', (e) => {
  const hanziText = e.target.value.trim();
  
  if (!hanziText) {
    inputPinyin.value = '';
    return;
  }

  // Use the global pinyinPro object loaded by <script src="https://unpkg.com/pinyin-pro"></script>
  if (window.pinyinPro && typeof window.pinyinPro.pinyin === 'function') {
    inputPinyin.value = window.pinyinPro.pinyin(hanziText, {
      toneType: 'symbol' // Generates standard tone marks (e.g., "nǐ hǎo")
    });
  }
});

// Card font size: S / M / L / XL steps, shared by hanzi and english text
const fontSizeRange = document.getElementById('fontSizeRange');
const CARD_FONT_SIZES = ['1.5rem', '2rem', '2.5rem', '4rem'];

fontSizeRange.addEventListener('input', (e) => {
  document.documentElement.style.setProperty('--card-font-size', CARD_FONT_SIZES[e.target.value]);
  autoFitCardText();
});

// Sync the CSS variable to the slider's actual value on load - browsers can restore a
// range input's position after a reload without firing 'input', leaving this stale otherwise
document.documentElement.style.setProperty('--card-font-size', CARD_FONT_SIZES[fontSizeRange.value]);

// Overview (login/decks/add card) vs. Study (toggle/font size/flip card) screens
const overviewView = document.getElementById('overviewView');
const studyView = document.getElementById('studyView');
const headerSection = document.getElementById('headerSection');

function openStudyView() {
  headerSection.style.display = 'none';
  overviewView.style.display = 'none';
  studyView.style.display = 'flex';
  document.body.classList.add('studying');
  // The card has no real layout box while hidden, so only auto-fit once it's actually visible
  autoFitCardText();
}

function closeStudyView() {
  studyView.style.display = 'none';
  document.body.classList.remove('studying');
  overviewView.style.display = 'block';
  headerSection.style.display = 'flex';
}

document.getElementById('btnLearnNow').addEventListener('click', openStudyView);

document.getElementById('btnBackToOverview').addEventListener('click', () => {
  if (generatorReviewActive) pauseReview();
  closeStudyView();
});

// ---------------------------------------------------------------------------
// 2. WebAssembly Runtime Initialization
// ---------------------------------------------------------------------------
const { getAssemblyExports } = await dotnet.create();
const exports = await getAssemblyExports("flashcards-wasm.dll");

// Per-card review state, index-aligned with the WASM deck (persisted server-side when a
// saved deck is loaded, so it survives reload/logout/login). Scheduling rules live in srs.js:
// a minutes-based learning phase followed by an exponentially growing review phase.
function initCardMeta(count) {
  return Array.from({ length: count }, () => newCardMeta());
}

let cardMeta = initCardMeta(exports.DeckEngine.GetDeckCount());
let currentCardIndex = null;

// Counts turns advanced via Wrong/Hard/Easy; used to force a fresh card into rotation
// every 3rd turn so new vocabulary isn't crowded out by overdue Hard/review-ladder reviews.
let turnCounter = 0;

// Adjustable per-deck learning-phase delays (minutes)
let deckSettings = { ...DEFAULT_SETTINGS };

const DELAY_INPUT_IDS = {
  wrongDelayMinutes: 'wrongDelayInput',
  hardDelayMinutes: 'hardDelayInput',
  lapseDelayMinutes: 'lapseDelayInput'
};

function resetDeckSettings() {
  deckSettings = { ...DEFAULT_SETTINGS };
  showDeckSettings();
}

function showDeckSettings() {
  for (const [key, id] of Object.entries(DELAY_INPUT_IDS)) {
    document.getElementById(id).value = deckSettings[key];
  }
}

function isReady(meta) {
  return !meta.readyAt || meta.readyAt.getTime() <= Date.now();
}

// Cards ready for review now. Expired-timer cards come first (most overdue first), then never-touched cards
// last - otherwise a deck full of fresh cards would bury due Hard/review-ladder cards forever.
function getActiveQueueIndices() {
  const normallyReady = cardMeta
    .map((_, i) => i)
    .filter((i) => isReady(cardMeta[i]))
    .sort((a, b) => {
      const ra = cardMeta[a].readyAt ? cardMeta[a].readyAt.getTime() : Infinity;
      const rb = cardMeta[b].readyAt ? cardMeta[b].readyAt.getTime() : Infinity;
      return ra - rb;
    });

  return normallyReady;
}

// Picks the card to show next. Every 3rd turn, prefers an untouched/remaining card (if any)
// over overdue Hard/review-ladder reviews.
function pickCurrentCardIndex(queue) {
  if (turnCounter % 3 === 2) {
    const freshIndex = queue.find((i) => cardMeta[i].bucket === 'remaining');
    if (freshIndex !== undefined) return freshIndex;
  }

  return queue[0];
}

// ---------------------------------------------------------------------------
// 3. Card Rendering & Deck Control Functions
// ---------------------------------------------------------------------------
const modeToggle = document.getElementById('modeToggle');
const btnAudio = document.getElementById('btnAudio');
const btnAudioBack = document.getElementById('btnAudioBack');

// Wraps each hanzi character in <ruby> so its pinyin renders above it
function buildRubyMarkup(hanzi) {
  const hasPinyinPro = window.pinyinPro && typeof window.pinyinPro.pinyin === 'function';
  return Array.from(hanzi).map((ch) => {
    const py = hasPinyinPro ? window.pinyinPro.pinyin(ch, { toneType: 'symbol' }) : '';
    return `<ruby>${ch}<rt>${py}</rt></ruby>`;
  }).join('');
}

const hardStackVisual = document.getElementById('hardStackVisual');
const remainingStackVisual = document.getElementById('remainingStackVisual');
const acceptedStackVisual = document.getElementById('acceptedStackVisual');
const MAX_VISUAL_CARDS = 15;

// One mini-stack per rung of the review ladder (1d/3d/7d/16d/35d+) so graduating cards stay
// visible as concrete progress instead of disappearing into a single "Done" pile. Built from
// REVIEW_LADDER_BUCKETS (srs.js) so the two files can't drift out of sync; the visual
// mature-to-fresh ordering comes from the markup, not from this array.
const LADDER_ID_SUFFIXES = ['1d', '3d', '7d', '16d', 'Mature'];
const reviewLadderRungs = REVIEW_LADDER_BUCKETS.map((bucket, i) => ({
  bucket,
  stack: document.getElementById(`ladderStack${LADDER_ID_SUFFIXES[i]}`),
  countEl: document.getElementById(`ladderCount${LADDER_ID_SUFFIXES[i]}`)
}));

const frontProgressDots = document.getElementById('frontProgressDots');
const backProgressDots = document.getElementById('backProgressDots');

// Fills in dots for how far along the review ladder the current card is (one dot per ladder
// step), colored by whichever pile (hard/review ladder) the card belongs to.
function updateProgressDots(streak, bucket) {
  const dotClass = bucket === 'hard' ? 'hard' : (bucket ? 'easy' : null);
  [frontProgressDots, backProgressDots].forEach((container) => {
    container.classList.remove('hard', 'easy');
    if (dotClass) container.classList.add(dotClass);

    container.querySelectorAll('.dot').forEach((dot, i) => {
      dot.classList.toggle('filled', i < streak);
    });
  });
}

// Renders a small fanned deck icon; height caps out visually at MAX_VISUAL_CARDS
function renderStackVisual(container, count) {
  container.innerHTML = '';

  if (count === 0) {
    const placeholder = document.createElement('div');
    placeholder.className = 'mini-card empty';
    container.appendChild(placeholder);
    return;
  }

  const visibleCount = Math.min(count, MAX_VISUAL_CARDS);
  for (let i = 0; i < visibleCount; i++) {
    const card = document.createElement('div');
    card.className = 'mini-card' + (i === visibleCount - 1 ? ' top' : '');
    card.style.transform = `translate(calc(-50% + ${i * 3}px), ${-i * 4}px)`;
    card.style.zIndex = i;
    container.appendChild(card);
  }
}

function renderCurrentCard() {
  // Pile counts reflect every card's current bucket, regardless of whether it's resting
  const hardCount = cardMeta.filter((m) => m.bucket === 'hard').length;
  const remainingCount = cardMeta.filter((m) => m.bucket === 'remaining').length;

  document.getElementById('hardCount').innerText = hardCount;
  document.getElementById('remainingCount').innerText = remainingCount;
  renderStackVisual(hardStackVisual, hardCount);
  renderStackVisual(remainingStackVisual, remainingCount);

  reviewLadderRungs.forEach(({ bucket, stack, countEl }) => {
    const count = cardMeta.filter((m) => m.bucket === bucket).length;
    countEl.innerText = count;
    renderStackVisual(stack, count);
  });

  if (cardMeta.length === 0) {
    scene.dataset.hanzi = '';
    currentCardIndex = null;
    document.getElementById('frontHanzi').innerText = 'Deck empty';
    document.getElementById('backPinyin').innerHTML = '';
    document.getElementById('backEnglish').innerText = '';
    btnAudio.style.display = 'none';
    btnAudioBack.style.display = 'none';
    updateProgressDots(0, null);
    updateEvalControlsVisibility();
    return;
  }

  const queue = getActiveQueueIndices();

  if (queue.length === 0) {
    // Every card is resting on its timer; show when the soonest one will be ready again
    scene.dataset.hanzi = '';
    currentCardIndex = null;
    const nextReadyAtMs = Math.min(...cardMeta.map((m) => m.readyAt?.getTime() ?? Infinity));
    document.getElementById('frontHanzi').innerText =
      `All caught up! Next review in ${formatInterval(nextReadyAtMs - Date.now())}`;
    document.getElementById('backPinyin').innerHTML = '';
    document.getElementById('backEnglish').innerText = '';
    btnAudio.style.display = 'none';
    btnAudioBack.style.display = 'none';
    updateProgressDots(0, null);
    updateEvalControlsVisibility();
    return;
  }

  currentCardIndex = pickCurrentCardIndex(queue);
  const json = exports.DeckEngine.GetCardJson(currentCardIndex);
  const card = JSON.parse(json);

  if (!card || !card.Hanzi) return;

  // Keep the real hanzi available for audio playback regardless of display mode
  scene.dataset.hanzi = card.Hanzi;

  const backPinyin = document.getElementById('backPinyin');
  backPinyin.classList.toggle('ruby-active', modeToggle.checked);

  if (modeToggle.checked) {
    document.getElementById('frontHanzi').innerText = card.English;
    backPinyin.innerHTML = buildRubyMarkup(card.Hanzi);
    document.getElementById('backEnglish').innerText = '';
  } else {
    document.getElementById('frontHanzi').innerText = card.Hanzi;
    backPinyin.innerText = card.Pinyin;
    document.getElementById('backEnglish').innerText = card.English;
  }

  // Only show Listen next to whichever side currently displays the hanzi
  btnAudio.style.display = modeToggle.checked ? 'none' : '';
  btnAudioBack.style.display = modeToggle.checked ? '' : 'none';
  const currentMeta = cardMeta[currentCardIndex];
  updateProgressDots(
    currentMeta.phase === 'review' ? currentMeta.reviewStep + 1 : 0,
    currentMeta.bucket === 'remaining' ? null : currentMeta.bucket
  );
  autoFitCardText();
  updateEvalControlsVisibility();
}

// Wrong/Hard/Easy buttons should only appear once the card has been flipped to its answer
// side; Flip itself (also in #evalControls) stays visible so you can always reveal the answer
const evalControls = document.getElementById('evalControls');
function updateEvalControlsVisibility() {
  reviewControls.classList.toggle('answer-shown', scene.classList.contains('flipped'));
  if (generatorReviewActive) return;
  const visible = scene.classList.contains('flipped') && currentCardIndex !== null;
  const display = visible ? 'visible' : 'hidden';
  document.getElementById('btnGood').style.visibility = display;
  document.getElementById('btnHard').style.visibility = display;
  document.getElementById('btnWrong').style.visibility = display;
}

// Arrow keys mirror the on-screen D-pad layout: Flip=Left, Easy=Up, Hard=Down, Wrong=Right
const directionButtons = {
  left: document.getElementById('btnFlip'),
  up: document.getElementById('btnGood'),
  down: document.getElementById('btnHard'),
  right: document.getElementById('btnWrong')
};
const pressedTimers = new Map();
let generatedCards = [];
let generatedCardIndex = 0;
let acceptedGeneratedCount = 0;
let declinedGeneratedCount = 0;
let generatorReviewActive = false;
let acceptingGeneratedCard = false;

const generateCardsForm = document.getElementById('generateCardsForm');
const generateTopicInput = document.getElementById('generateTopic');
const generateCountInput = document.getElementById('generateCount');
const generateButton = document.getElementById('btnGenerateCards');
const generatorStatus = document.getElementById('generatorStatus');
const generatorProgress = document.getElementById('generatorProgress');
const reviewCount = document.getElementById('reviewCount');
const btnAcceptCard = document.getElementById('btnAcceptCard');
const btnDeclineCard = document.getElementById('btnDeclineCard');
const btnReviewFlip = document.getElementById('btnReviewFlip');

// Same layout as learn mode: Left=Flip, Up=Accept, Right=Decline (Accept/Decline only after flipping)
const reviewDirectionButtons = { left: btnReviewFlip, up: btnAcceptCard, right: btnDeclineCard };
const reviewControls = document.getElementById('reviewControls');

// Generated cards are reviewed inside the study view, which reuses the card scene. The
// Accepted pile only exists in review mode; Hard is relabeled Declined and reused as-is.
function enterReviewMode() {
  studyView.classList.add('reviewing');
  document.getElementById('hardLabel').textContent = 'Declined';
  scene.classList.remove('flipped');
  openStudyView();
}

const btnResumeReview = document.getElementById('btnResumeReview');

function leaveReviewMode() {
  generatorReviewActive = false;
  studyView.classList.remove('reviewing');
  document.getElementById('hardLabel').textContent = 'Hard';
  scene.classList.remove('flipped');
  renderCurrentCard();
}

// Leaves the review but keeps the remaining suggestions so it can be resumed from the overview
function pauseReview() {
  leaveReviewMode();
  const left = generatedCards.length - generatedCardIndex;
  btnResumeReview.hidden = false;
  btnResumeReview.textContent = `▶ Resume review (${left} left)`;
  generatorStatus.classList.remove('error');
  generatorStatus.textContent = `${acceptedGeneratedCount} accepted, ${declinedGeneratedCount} declined, ${left} still to review.`;
}

function finishReview() {
  leaveReviewMode();
  btnResumeReview.hidden = true;
  generateButton.disabled = false;
  generatorStatus.classList.remove('error');
  generatorStatus.textContent = `Review complete: ${acceptedGeneratedCount} accepted, ${declinedGeneratedCount} declined.`;
  closeStudyView();
}

btnResumeReview.addEventListener('click', () => {
  btnResumeReview.hidden = true;
  generatorStatus.textContent = '';
  generatorReviewActive = true;
  enterReviewMode();
  showGeneratedCard();
});

function renderReviewCard() {
  const card = generatedCards[generatedCardIndex];
  scene.dataset.hanzi = card.hanzi;

  const backPinyin = document.getElementById('backPinyin');
  backPinyin.classList.toggle('ruby-active', modeToggle.checked);
  if (modeToggle.checked) {
    document.getElementById('frontHanzi').innerText = card.english;
    backPinyin.innerHTML = buildRubyMarkup(card.hanzi);
    document.getElementById('backEnglish').innerText = '';
  } else {
    document.getElementById('frontHanzi').innerText = card.hanzi;
    backPinyin.innerText = card.pinyin;
    document.getElementById('backEnglish').innerText = card.english;
  }
  btnAudio.style.display = modeToggle.checked ? 'none' : '';
  btnAudioBack.style.display = modeToggle.checked ? '' : 'none';
  autoFitCardText();
}

function showGeneratedCard() {
  renderGeneratedStacks();
  if (generatedCardIndex >= generatedCards.length) {
    finishReview();
    return;
  }

  reviewCount.style.color = '';
  reviewCount.textContent = `Suggestion ${generatedCardIndex + 1} of ${generatedCards.length}`;
  scene.classList.remove('flipped');
  updateEvalControlsVisibility();
  renderReviewCard();
  btnAcceptCard.disabled = acceptingGeneratedCard;
  btnDeclineCard.disabled = acceptingGeneratedCard;
}

function renderGeneratedStacks() {
  document.getElementById('acceptedCount').innerText = acceptedGeneratedCount;
  document.getElementById('hardCount').innerText = declinedGeneratedCount;
  renderStackVisual(acceptedStackVisual, acceptedGeneratedCount);
  renderStackVisual(hardStackVisual, declinedGeneratedCount);
}

async function acceptGeneratedCard() {
  if (!generatorReviewActive || acceptingGeneratedCard) return;
  nudgeCard('up');
  acceptingGeneratedCard = true;
  btnAcceptCard.disabled = true;
  btnDeclineCard.disabled = true;
  const card = generatedCards[generatedCardIndex];
  try {
    let serverId = null;
    if (currentDeckId) {
      const response = await apiCall(`/api/decks/${currentDeckId}/cards`, {
        method: 'POST',
        body: JSON.stringify(card)
      });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.error || 'Could not save this card to the selected deck.');
      }
      serverId = (await response.json()).id;
      await loadMyDecks();
    }

    exports.DeckEngine.AddCard(card.hanzi, card.pinyin, card.english);
    cardMeta.push(newCardMeta(serverId));
    acceptedGeneratedCount += 1;
    generatedCardIndex += 1;
    acceptingGeneratedCard = false;
    showGeneratedCard();
  } catch (error) {
    reviewCount.style.color = '#ef4444';
    reviewCount.textContent = error.message;
  } finally {
    acceptingGeneratedCard = false;
    if (generatorReviewActive) {
      btnAcceptCard.disabled = false;
      btnDeclineCard.disabled = false;
    }
  }
}

function declineGeneratedCard() {
  if (!generatorReviewActive || acceptingGeneratedCard) return;
  nudgeCard('right');
  declinedGeneratedCount += 1;
  generatedCardIndex += 1;
  showGeneratedCard();
}

generateCardsForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (generatorReviewActive) return;

  const topic = generateTopicInput.value.trim();
  const count = Number(generateCountInput.value);
  if (topic.length < 3 || topic.length > 300 || !Number.isInteger(count) || count < 1 || count > 20) {
    generatorStatus.classList.add('error');
    generatorStatus.textContent = 'Enter a topic (3–300 characters) and choose 1–20 cards.';
    return;
  }

  generateButton.disabled = true;
  generatorProgress.hidden = false;
  generatorStatus.classList.remove('error');
  generatorStatus.textContent = `Creating ${count} suggestions…`;
  try {
    const response = await apiCall('/api/generate-cards', {
      method: 'POST',
      body: JSON.stringify({ topic, count })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) throw new Error('Please log in to generate cards.');
      throw new Error(result.error || 'Card generation failed.');
    }
    if (!Array.isArray(result.cards) || result.cards.length !== count) {
      throw new Error('The server returned an unexpected set of cards. Please try again.');
    }

    if (!window.pinyinPro || typeof window.pinyinPro.pinyin !== 'function') {
      throw new Error('The pinyin library did not load. Check your connection and reload.');
    }
    generatedCards = result.cards.map((card) => ({
      ...card,
      pinyin: window.pinyinPro.pinyin(card.hanzi, { toneType: 'symbol' })
    }));
    generatedCardIndex = 0;
    acceptedGeneratedCount = 0;
    declinedGeneratedCount = 0;
    generatorReviewActive = true;
    generatorProgress.hidden = true;
    generateButton.disabled = true;
    generatorStatus.textContent = '';
    enterReviewMode();
    showGeneratedCard();
  } catch (error) {
    generatorProgress.hidden = true;
    generatorStatus.classList.add('error');
    generatorStatus.textContent = error.message;
    generateButton.disabled = false;
  }
});

btnAcceptCard.addEventListener('click', acceptGeneratedCard);
btnDeclineCard.addEventListener('click', declineGeneratedCard);
btnReviewFlip.addEventListener('click', () => toggleFlip());

function showPressedButton(button) {
  button.classList.add('is-pressed');
  clearTimeout(pressedTimers.get(button));
  pressedTimers.set(button, setTimeout(() => {
    button.classList.remove('is-pressed');
    pressedTimers.delete(button);
  }, 160));
}

function clearDirectionPreview() {
  [...Object.values(directionButtons), ...Object.values(reviewDirectionButtons)]
    .forEach((button) => button.classList.remove('is-pressed'));
}

document.addEventListener('keydown', (e) => {
  if (studyView.style.display === 'none') return;

  if (e.key === ' ' || e.code === 'Space') {
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    e.preventDefault();
    document.getElementById('btnSpaceListen').classList.add('is-pressed');
    if (!e.repeat) speakHanzi();
    return;
  }

  if (generatorReviewActive) {
    const reviewKeys = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up' };
    const direction = reviewKeys[e.key];
    if (!direction) return;
    e.preventDefault();
    if (direction !== 'left' && !scene.classList.contains('flipped')) return;
    showPressedButton(reviewDirectionButtons[direction]);
    if (direction === 'left') toggleFlip();
    else if (direction === 'up') acceptGeneratedCard();
    else declineGeneratedCard();
    return;
  }

  if (e.key === 'ArrowLeft') {
    e.preventDefault();
    showPressedButton(directionButtons.left);
    directionButtons.left.click();
    return;
  }

  if (!scene.classList.contains('flipped') || currentCardIndex === null) return;

  if (e.key === 'ArrowUp') {
    e.preventDefault();
    showPressedButton(directionButtons.up);
    directionButtons.up.click();
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    showPressedButton(directionButtons.down);
    directionButtons.down.click();
  } else if (e.key === 'ArrowRight') {
    e.preventDefault();
    showPressedButton(directionButtons.right);
    directionButtons.right.click();
  }
});

document.addEventListener('keyup', (e) => {
  if (e.key === ' ' || e.code === 'Space') {
    document.getElementById('btnSpaceListen').classList.remove('is-pressed');
  }
});

window.addEventListener('blur', () => {
  document.getElementById('btnSpaceListen').classList.remove('is-pressed');
});

// Moves the card a short distance in the given direction and eases it back, as visual feedback
// for what is about to happen to it. Tuned via --card-nudge-distance / --card-nudge-duration.
const NUDGE_VECTORS = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] };
let nudgeTimer = null;
const cardMotion = document.getElementById('cardMotion');

function cssNumber(name) {
  return parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name)) || 0;
}

function nudgeCard(direction) {
  const [vx, vy] = NUDGE_VECTORS[direction];
  const distance = cssNumber('--card-nudge-distance');
  const durationMs = cssNumber('--card-nudge-duration') * 1000;

  clearTimeout(nudgeTimer);
  cardMotion.classList.remove('dragging');
  cardMotion.style.transform = `translate(${vx * distance}px, ${vy * distance}px)`;
  nudgeTimer = setTimeout(() => { cardMotion.style.transform = ''; }, durationMs);
}

// Swipe gestures mirror the arrow keys: Left=Flip, Up=Easy, Down=Hard, Right=Wrong
let touchStart = null;
let dragging = false;
let swipeHandled = false;
const SWIPE_MIN_PX = 40;

studyView.addEventListener('touchstart', (e) => {
  if (e.touches.length !== 1 || e.target.closest('input, textarea, select, button, label, .options-menu')) {
    touchStart = null;
    return;
  }
  touchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  dragging = scene.contains(e.target);
}, { passive: true });

// While dragging on the card, it follows the finger (damped and capped at the nudge distance)
studyView.addEventListener('touchmove', (e) => {
  if (!touchStart || !dragging) return;
  const t = e.touches[0];
  const dx = t.clientX - touchStart.x;
  const dy = t.clientY - touchStart.y;
  const max = cssNumber('--card-nudge-distance');
  const follow = cssNumber('--card-drag-follow');
  const horizontal = Math.abs(dx) > Math.abs(dy);
  const clamp = (v) => Math.max(-max, Math.min(max, v * follow));
  const direction = horizontal ? (dx < 0 ? 'left' : 'right') : (dy < 0 ? 'up' : 'down');

  clearTimeout(nudgeTimer);
  cardMotion.classList.add('dragging');
  cardMotion.style.transform = horizontal ? `translate(${clamp(dx)}px, 0)` : `translate(0, ${clamp(dy)}px)`;
  clearDirectionPreview();
  if (Math.max(Math.abs(dx), Math.abs(dy)) >= 10) (generatorReviewActive ? reviewDirectionButtons : directionButtons)[direction]?.classList.add('is-pressed');
}, { passive: true });

studyView.addEventListener('touchend', (e) => {
  if (!touchStart) return;
  const t = e.changedTouches[0];
  const dx = t.clientX - touchStart.x;
  const dy = t.clientY - touchStart.y;
  touchStart = null;

  if (dragging) {
    dragging = false;
    cardMotion.classList.remove('dragging');
    cardMotion.style.transform = '';
  }
  clearDirectionPreview();

  if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE_MIN_PX) return;

  swipeHandled = true;
  setTimeout(() => { swipeHandled = false; }, 400);

  const horizontal = Math.abs(dx) > Math.abs(dy);
  const key = horizontal ? (dx < 0 ? 'ArrowLeft' : 'ArrowRight') : (dy < 0 ? 'ArrowUp' : 'ArrowDown');
  document.dispatchEvent(new KeyboardEvent('keydown', { key }));
}, { passive: true });

// 3D Card Flip handlers
const scene = document.getElementById('cardScene');

const autoListenToggle = document.getElementById('autoListenToggle');
autoListenToggle.checked = localStorage.getItem('autoListen') === '1';
autoListenToggle.addEventListener('change', () => {
  localStorage.setItem('autoListen', autoListenToggle.checked ? '1' : '0');
});

const btnOptions = document.getElementById('btnOptions');
const optionsMenu = document.getElementById('optionsMenu');
const showPinyinToggle = document.getElementById('showPinyinToggle');
showPinyinToggle.checked = localStorage.getItem('showPinyin') !== '0';
studyView.classList.toggle('hide-pinyin', !showPinyinToggle.checked);
showPinyinToggle.addEventListener('change', () => {
  localStorage.setItem('showPinyin', showPinyinToggle.checked ? '1' : '0');
  studyView.classList.toggle('hide-pinyin', !showPinyinToggle.checked);
});

const themeToggle = document.getElementById('themeToggle');
themeToggle.checked = localStorage.getItem('theme') === 'light';
document.documentElement.dataset.theme = themeToggle.checked ? 'light' : 'dark';
themeToggle.addEventListener('change', () => {
  const theme = themeToggle.checked ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('theme', theme);
});

btnOptions.addEventListener('click', (e) => {
  e.stopPropagation();
  btnOptions.setAttribute('aria-expanded', optionsMenu.classList.toggle('open'));
});
document.addEventListener('click', (e) => {
  if (!optionsMenu.contains(e.target)) {
    optionsMenu.classList.remove('open');
    btnOptions.setAttribute('aria-expanded', 'false');
  }
});

function toggleFlip() {
  scene.classList.toggle('flipped');
  updateEvalControlsVisibility();
  if (scene.classList.contains('flipped') && autoListenToggle.checked) speakHanzi();
}

document.getElementById('btnFlip').addEventListener('click', toggleFlip);

scene.addEventListener('click', (e) => {
  // Prevent card flip if clicking the Listen audio button directly
  if (swipeHandled) return;
  if (!e.target.classList.contains('audio-btn')) toggleFlip();
});

// Re-render in the newly selected mode whenever the toggle changes
modeToggle.addEventListener('change', () => {
  scene.classList.remove('flipped');
  if (generatorReviewActive) renderReviewCard();
  else renderCurrentCard();
});

// ---------------------------------------------------------------------------
// Edit cards page: browse, search, edit and delete the cards of the current deck
// ---------------------------------------------------------------------------
const editView = document.getElementById('editView');
const editGrid = document.getElementById('editGrid');
const editSearch = document.getElementById('editSearch');
const editCount = document.getElementById('editCount');
const editNote = document.getElementById('editNote');
let editingCardIndex = null;

function getDeckCards() {
  return cardMeta.map((meta, index) => ({ index, meta, ...JSON.parse(exports.DeckEngine.GetCardJson(index)) }));
}

function makeEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function makeSide(label, parts) {
  const side = makeEl('div', 'edit-side');
  side.append(makeEl('div', 'edit-side-label', label));
  parts.forEach(([cls, text]) => side.append(makeEl('div', cls, text)));
  return side;
}

function renderEditGrid() {
  const query = editSearch.value.trim().toLowerCase();
  const all = getDeckCards();
  const cards = query
    ? all.filter((c) => [c.Hanzi, c.Pinyin, c.English].some((t) => t.toLowerCase().includes(query)))
    : all;
  const canEdit = !!currentDeckId;

  editNote.hidden = canEdit;
  editCount.textContent = query ? `${cards.length} of ${all.length} cards` : `${all.length} cards`;
  editGrid.replaceChildren();

  if (cards.length === 0) {
    editGrid.append(makeEl('div', 'edit-empty', query ? 'No cards match your search.' : 'This deck has no cards yet.'));
    return;
  }

  for (const card of cards) {
    const tile = makeEl('div', 'edit-tile');
    if (card.index === editingCardIndex && canEdit) {
      tile.classList.add('editing');
      tile.append(buildEditForm(card));
    } else {
      const sides = makeEl('div', 'edit-tile-sides');
      sides.append(
        makeSide('Front', [['e-hanzi', card.Hanzi]]),
        makeSide('Back', [['e-pinyin', card.Pinyin], ['e-english', card.English]])
      );
      tile.append(sides);
      if (canEdit) {
        const actions = makeEl('div', 'edit-tile-actions');
        const edit = makeEl('button', 'action-btn', 'Edit');
        edit.type = 'button';
        edit.addEventListener('click', () => { editingCardIndex = card.index; renderEditGrid(); });
        const del = makeEl('button', 'action-btn btn-wrong', 'Delete');
        del.type = 'button';
        del.addEventListener('click', () => deleteDeckCard(card));
        actions.append(edit, del);
        tile.append(actions);
      }
    }
    editGrid.append(tile);
  }
}

function buildEditForm(card) {
  const form = makeEl('form', 'edit-form');
  const hanzi = makeEl('input'); hanzi.value = card.Hanzi; hanzi.placeholder = 'Hanzi'; hanzi.required = true;
  const pinyin = makeEl('input'); pinyin.value = card.Pinyin; pinyin.placeholder = 'Pinyin'; pinyin.required = true;
  const english = makeEl('input'); english.value = card.English; english.placeholder = 'English'; english.required = true;
  const error = makeEl('div', 'edit-error');
  const save = makeEl('button', 'action-btn', 'Save'); save.type = 'submit';
  const cancel = makeEl('button', 'action-btn', 'Cancel'); cancel.type = 'button';
  const actions = makeEl('div', 'edit-tile-actions');
  actions.append(cancel, save);
  form.append(hanzi, pinyin, english, error, actions);

  hanzi.addEventListener('input', () => {
    if (window.pinyinPro && hanzi.value.trim()) {
      pinyin.value = window.pinyinPro.pinyin(hanzi.value.trim(), { toneType: 'symbol' });
    }
  });
  cancel.addEventListener('click', () => { editingCardIndex = null; renderEditGrid(); });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    save.disabled = true;
    const response = await apiCall(`/api/decks/${currentDeckId}/cards/${card.meta.serverId}`, {
      method: 'PUT',
      body: JSON.stringify({ hanzi: hanzi.value, pinyin: pinyin.value, english: english.value })
    });
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      error.textContent = result.error || 'Could not save this card.';
      save.disabled = false;
      return;
    }
    editingCardIndex = null;
    await reloadCurrentDeck();
  });
  return form;
}

async function deleteDeckCard(card) {
  if (!confirm(`Delete "${card.Hanzi}"?`)) return;
  const response = await apiCall(`/api/decks/${currentDeckId}/cards/${card.meta.serverId}`, { method: 'DELETE' });
  if (response.ok) await reloadCurrentDeck();
}

// The WASM deck has no update/remove, so re-sync it from the server after a change
async function reloadCurrentDeck() {
  await loadDeckById(currentDeckId);
  renderEditGrid();
}

function openEditView() {
  headerSection.style.display = 'none';
  overviewView.style.display = 'none';
  editView.style.display = 'flex';
  editingCardIndex = null;
  editSearch.value = '';
  renderEditGrid();
}

document.getElementById('btnEditCards').addEventListener('click', openEditView);
document.getElementById('btnBackFromEdit').addEventListener('click', () => {
  editView.style.display = 'none';
  overviewView.style.display = 'block';
  headerSection.style.display = 'flex';
});
editSearch.addEventListener('input', renderEditGrid);

// Pushes a card's current review state to the server, when it belongs to a saved deck
async function persistCardProgress(index) {
  const meta = cardMeta[index];
  if (!currentDeckId || !meta.serverId) return;

  await apiCall(`/api/decks/${currentDeckId}/cards/${meta.serverId}/progress`, {
    method: 'PUT',
    body: JSON.stringify({
      bucket: meta.bucket,
      phase: meta.phase,
      reviewStep: meta.reviewStep,
      intervalDays: meta.intervalDays,
      readyAt: meta.readyAt ? meta.readyAt.toISOString() : null
    })
  });
}

// Wrong: a new/learning card retries after the short Wrong delay; a review card lapses back into
// the learning phase (10-minute retry) and later re-graduates at a reduced interval
document.getElementById('btnWrong').addEventListener('click', () => {
  if (currentCardIndex === null) return;
  nudgeCard('right');
  const index = currentCardIndex;
  const meta = cardMeta[index];
  applyWrong(meta, deckSettings);

  persistCardProgress(index);
  turnCounter += 1;
  scene.classList.remove('flipped');
  setTimeout(renderCurrentCard, 200);
});

// Hard: a learning card repeats after the Hard delay; a review card keeps its progress and only
// grows its interval by a small factor
document.getElementById('btnHard').addEventListener('click', () => {
  if (currentCardIndex === null) return;
  nudgeCard('down');
  const index = currentCardIndex;
  const meta = cardMeta[index];
  applyHard(meta, deckSettings);
  persistCardProgress(index);
  turnCounter += 1;
  scene.classList.remove('flipped');
  setTimeout(renderCurrentCard, 200);
});

// Easy: a learning card graduates to the review phase (1 day); a review card moves up the
// interval ladder (1, 3, 7, 16, 35 days, then x2.2 each time).
document.getElementById('btnGood').addEventListener('click', () => {
  if (currentCardIndex === null) return;
  nudgeCard('up');
  const index = currentCardIndex;
  const meta = cardMeta[index];
  applyEasy(meta);

  persistCardProgress(index);
  turnCounter += 1;
  scene.classList.remove('flipped');
  setTimeout(renderCurrentCard, 200);
});

// ---------------------------------------------------------------------------
// 4. Web Audio Pronunciation (Text-to-Speech) - pluggable providers
// ---------------------------------------------------------------------------

// Each provider takes the hanzi text and returns a Promise that resolves once playback starts.
// To add another provider (e.g. an official Google Cloud/Azure TTS key proxied through the
// Server project), just add a new entry here and point ACTIVE_TTS_PROVIDER at its name.
// Only one pronunciation may play at a time: starting a new one stops the previous
let currentAudio = null;
let speakToken = 0;
function stopAudio() {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
}

const ttsProviders = {
  // Built-in browser speech synthesis: free, offline, zero setup, but voice quality/availability
  // depends on what the OS/browser ships with.
  webspeech(text) {
    return new Promise((resolve, reject) => {
      if (!('speechSynthesis' in window)) {
        reject(new Error('Web Speech API not supported'));
        return;
      }

      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'zh-CN';
      utterance.rate = 0.85; // Slower playback rate for distinct Mandarin tones
      utterance.onstart = () => resolve();
      utterance.onerror = (e) => reject(e.error || new Error('Speech synthesis failed'));
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(utterance);
    });
  },

  // Free, no API key needed - proxied through our own server (/api/tts) since calling Google's
  // endpoint directly from <audio src> triggers a Range request it answers with a 404.
  googleTranslate(text) {
    return new Promise((resolve, reject) => {
      const url = `/api/tts?text=${encodeURIComponent(text)}`;
      stopAudio();
      const audio = new Audio(url);
      currentAudio = audio;
      audio.onplay = () => resolve();
      audio.onerror = () => reject(new Error('TTS request failed'));
      audio.play().catch(reject);
    });
  }
};

// Switch providers by changing this one line
const ACTIVE_TTS_PROVIDER = 'googleTranslate';

async function speakText(text, e) {
  if (e) e.stopPropagation();
  if (!text) return;

  const token = ++speakToken;
  stopAudio();

  try {
    await ttsProviders[ACTIVE_TTS_PROVIDER](text);
  } catch (err) {
    console.warn(`TTS provider "${ACTIVE_TTS_PROVIDER}" failed, falling back to webspeech:`, err);
    if (ACTIVE_TTS_PROVIDER !== 'webspeech' && token === speakToken) {
      ttsProviders.webspeech(text).catch(() => {});
    }
  }
}

async function speakHanzi(e) {
  return speakText(scene.dataset.hanzi, e);
}

// Listen button is shown on whichever side currently displays the hanzi
btnAudio.addEventListener('click', speakHanzi);
btnAudioBack.addEventListener('click', speakHanzi);
document.getElementById('btnSpaceListen').addEventListener('click', speakHanzi);

// ---------------------------------------------------------------------------
// 5. Add New Card Form Handler
// ---------------------------------------------------------------------------
document.getElementById('addCardForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  
  const hanzi = inputHanzi.value.trim();
  const pinyinVal = inputPinyin.value.trim();
  const english = document.getElementById('inputEnglish').value.trim();

  if (!hanzi || !pinyinVal || !english) return;

  // Send new card data directly into C# DeckEngine via WASM
  exports.DeckEngine.AddCard(hanzi, pinyinVal, english);

  // Reset inputs
  e.target.reset();

  // Auto-save the new card to whichever deck is currently loaded on the server, to get its real id
  let serverId = null;
  if (currentDeckId) {
    const response = await apiCall(`/api/decks/${currentDeckId}/cards`, {
      method: 'POST',
      body: JSON.stringify({ hanzi, pinyin: pinyinVal, english })
    });
    if (response.ok) {
      serverId = (await response.json()).id;
    }
    await loadMyDecks();
  }

  // Queue the new card at the back of the deck without interrupting the current one
  cardMeta.push(newCardMeta(serverId));
  renderCurrentCard();
});

// ---------------------------------------------------------------------------
// 6. Account Login/Register and Cloud Deck Sync
// ---------------------------------------------------------------------------
const authEmail = document.getElementById('authEmail');
const authPassword = document.getElementById('authPassword');
const authForms = document.getElementById('authForms');
const loggedInPanel = document.getElementById('loggedInPanel');
const authStatus = document.getElementById('authStatus');
const authError = document.getElementById('authError');
const myDecksSelect = document.getElementById('myDecksSelect');
const newDeckName = document.getElementById('newDeckName');

// The server-side deck that newly added cards get auto-saved to, if any
let currentDeckId = null;

// Short-lived JWT, kept in memory only (never localStorage) so it can't be stolen via XSS
// reading storage; recovered after a reload via the httpOnly refresh-token cookie instead.
let accessToken = null;

async function apiCall(path, options = {}, isRetry = false) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

  const response = await fetch(path, { ...options, headers });

  // Access tokens expire quickly; on a 401, try the refresh cookie once before giving up,
  // so a page reload or an expired token doesn't force the user to log in again.
  const isAuthEndpoint = path === '/api/refresh' || path === '/api/login' || path === '/api/register';
  if (response.status === 401 && !isRetry && !isAuthEndpoint) {
    const refreshed = await tryRefreshAccessToken();
    if (refreshed) return apiCall(path, options, true);
  }

  return response;
}

async function tryRefreshAccessToken() {
  const response = await fetch('/api/refresh', { method: 'POST' });
  if (!response.ok) {
    accessToken = null;
    return false;
  }

  const data = await response.json();
  accessToken = data.accessToken;
  return true;
}

function showAuthError(message) {
  authError.innerText = message || '';
}

async function loadMyDecks() {
  const previousSelection = myDecksSelect.value;
  const response = await apiCall('/api/decks');
  if (!response.ok) return;

  const decks = await response.json();
  myDecksSelect.innerHTML = decks
    .map((d) => `<option value="${d.id}">${d.name} (${d.cardCount})</option>`)
    .join('');

  // Keep whichever deck was selected instead of resetting to the first option
  if (decks.some((d) => String(d.id) === previousSelection)) {
    myDecksSelect.value = previousSelection;
  }
}

// Replaces the in-session WASM deck with a saved deck's cards, pulled from the server
async function loadDeckById(deckId) {
  const response = await apiCall(`/api/decks/${deckId}/cards`);
  if (!response.ok) return false;

  const cards = await response.json();

  exports.DeckEngine.ClearDeck();
  for (const card of cards) {
    exports.DeckEngine.AddCard(card.hanzi, card.pinyin, card.english);
  }

  cardMeta = cards.map(metaFromServer);
  turnCounter = 0;

  currentDeckId = deckId;
  localStorage.setItem('lastDeckId', String(deckId));
  await loadDeckSettings(deckId);
  scene.classList.remove('flipped');
  renderCurrentCard();
  myDecksSelect.value = String(deckId);
  return true;
}

// Fetches a deck's adjustable review-timer settings and reflects them in the Deck actions UI
async function loadDeckSettings(deckId) {
  const response = await apiCall(`/api/decks/${deckId}/settings`);
  if (!response.ok) return;

  deckSettings = await response.json();
  showDeckSettings();
}

async function refreshAuthState() {
  const response = await apiCall('/api/me');

  if (response.ok) {
    const me = await response.json();
    authForms.style.display = 'none';
    loggedInPanel.style.display = 'flex';
    authStatus.innerText = `Logged in as ${me.email}`;
    await loadMyDecks();
    await autoLoadSavedDeck();
  } else {
    authForms.style.display = 'flex';
    loggedInPanel.style.display = 'none';
    currentDeckId = null;
  }
}

// Loads whichever deck was last used, falling back to the first saved deck,
// so a saved deck takes over from the default built-in one on login/reload.
async function autoLoadSavedDeck() {
  const options = Array.from(myDecksSelect.options);
  if (options.length === 0) return; // no saved decks yet, keep the default local deck

  const lastDeckId = localStorage.getItem('lastDeckId');
  const preferredId = options.some((o) => o.value === lastDeckId) ? lastDeckId : options[0].value;

  const loaded = await loadDeckById(preferredId);
  if (!loaded && preferredId !== options[0].value) {
    await loadDeckById(options[0].value);
  }
}

document.getElementById('btnRegister').addEventListener('click', async () => {
  showAuthError('');
  const response = await apiCall('/api/register', {
    method: 'POST',
    body: JSON.stringify({ email: authEmail.value, password: authPassword.value })
  });

  if (!response.ok) {
    const problem = await response.json().catch(() => null);
    showAuthError(problem?.error || 'Registration failed.');
    return;
  }

  // Registration also signs the user in server-side, so its response already has a token
  const { accessToken: token } = await response.json();
  accessToken = token;
  authPassword.value = '';
  await refreshAuthState();
});

document.getElementById('btnLogin').addEventListener('click', async () => {
  showAuthError('');
  const response = await apiCall('/api/login', {
    method: 'POST',
    body: JSON.stringify({ email: authEmail.value, password: authPassword.value })
  });

  if (!response.ok) {
    showAuthError('Invalid email or password.');
    return;
  }

  const { accessToken: token } = await response.json();
  accessToken = token;
  authPassword.value = '';
  await refreshAuthState();
});

document.getElementById('btnLogout').addEventListener('click', async () => {
  await apiCall('/api/logout', { method: 'POST' });
  accessToken = null;
  currentDeckId = null;
  await refreshAuthState();
});

document.getElementById('btnCreateDeck').addEventListener('click', async () => {
  showAuthError('');
  const name = newDeckName.value.trim();
  if (!name) {
    showAuthError('Enter a name for the deck.');
    return;
  }

  const createResponse = await apiCall('/api/decks', {
    method: 'POST',
    body: JSON.stringify({ name })
  });

  if (!createResponse.ok) {
    showAuthError('Could not create the deck.');
    return;
  }

  const deck = await createResponse.json();
  currentDeckId = deck.id;
  localStorage.setItem('lastDeckId', String(deck.id));

  // Start the new deck empty rather than carrying over the current in-session cards
  exports.DeckEngine.ClearDeck();
  cardMeta = [];
  turnCounter = 0;
  resetDeckSettings();
  scene.classList.remove('flipped');
  renderCurrentCard();

  newDeckName.value = '';
  await loadMyDecks();
  myDecksSelect.value = String(deck.id);
});

document.getElementById('btnSaveTimers').addEventListener('click', async () => {
  showAuthError('');
  if (!currentDeckId) {
    showAuthError('Load or create a deck first.');
    return;
  }

  const readMinutes = (id) => Math.max(0, parseInt(document.getElementById(id).value, 10) || 0);
  const wrongDelayMinutes = readMinutes('wrongDelayInput');
  const hardDelayMinutes = readMinutes('hardDelayInput');
  const lapseDelayMinutes = readMinutes('lapseDelayInput');

  const response = await apiCall(`/api/decks/${currentDeckId}/settings`, {
    method: 'PUT',
    body: JSON.stringify({ wrongDelayMinutes, hardDelayMinutes, lapseDelayMinutes })
  });

  if (!response.ok) {
    showAuthError('Could not save timers.');
    return;
  }

  deckSettings = await response.json();
});

// Selecting a deck loads it immediately
myDecksSelect.addEventListener('change', async () => {
  showAuthError('');
  const deckId = myDecksSelect.value;
  if (!deckId) return;

  const loaded = await loadDeckById(deckId);
  if (!loaded) {
    showAuthError('Could not load the deck.');
    myDecksSelect.value = currentDeckId ? String(currentDeckId) : '';
  }
});

document.getElementById('btnDeleteDeck').addEventListener('click', async () => {
  showAuthError('');
  const deckId = myDecksSelect.value;
  if (!deckId) {
    showAuthError('No deck selected.');
    return;
  }

  const selectedLabel = myDecksSelect.options[myDecksSelect.selectedIndex]?.textContent ?? 'this deck';
  if (!confirm(`Delete "${selectedLabel}"? This cannot be undone.`)) return;

  const response = await apiCall(`/api/decks/${deckId}`, { method: 'DELETE' });
  if (!response.ok) {
    showAuthError('Could not delete the deck.');
    return;
  }

  // If the deck being auto-saved to was just deleted, stop targeting it and clear the view
  if (String(currentDeckId) === String(deckId)) {
    currentDeckId = null;
    localStorage.removeItem('lastDeckId');
    exports.DeckEngine.ClearDeck();
    cardMeta = [];
    turnCounter = 0;
    resetDeckSettings();
    scene.classList.remove('flipped');
    renderCurrentCard();
  }

  await loadMyDecks();

  // The select always shows a deck, so make sure that deck is the one that's loaded
  if (!currentDeckId && myDecksSelect.value) {
    await loadDeckById(myDecksSelect.value);
  }
});

// ---------------------------------------------------------------------------
// 6b. CSV Card Import
// ---------------------------------------------------------------------------

// Splits a single CSV line into fields, honoring double-quoted fields (with "" as an escaped quote)
// so commas inside e.g. an English translation don't get mistaken for field separators.
function parseCsvLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { current += '"'; i++; }
        else inQuotes = false;
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

// Parses CSV text in "hanzi,pinyin,english" order, one card per line, skipping a header row if present
function parseCardsCsv(text) {
  const rows = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map(parseCsvLine);

  if (rows.length > 0 && rows[0][0]?.trim().toLowerCase() === 'hanzi') {
    rows.shift();
  }

  return rows
    .map(([hanzi, pinyin, english]) => ({
      hanzi: (hanzi || '').trim(),
      pinyin: (pinyin || '').trim(),
      english: (english || '').trim()
    }))
    .filter((c) => c.hanzi && c.pinyin && c.english);
}

const importCsvFile = document.getElementById('importCsvFile');
const importCsvText = document.getElementById('importCsvText');
const importStatus = document.getElementById('importStatus');

importCsvFile.addEventListener('change', async () => {
  const file = importCsvFile.files[0];
  if (!file) return;
  importCsvText.value = await file.text();
});

document.getElementById('btnImportCsv').addEventListener('click', async () => {
  showAuthError('');
  importStatus.textContent = '';

  const cards = parseCardsCsv(importCsvText.value);
  if (cards.length === 0) {
    showAuthError('No valid rows found. Expected one card per line: hanzi,pinyin,english');
    return;
  }

  // Server ids stay null when there's no deck to persist to; the cards still load into this session
  let serverIds = cards.map(() => null);
  if (currentDeckId) {
    const response = await apiCall(`/api/decks/${currentDeckId}/cards/import`, {
      method: 'POST',
      body: JSON.stringify({ cards })
    });
    if (response.ok) {
      serverIds = (await response.json()).map((c) => c.id);
    } else {
      showAuthError('Could not save the imported cards to the server.');
    }
    await loadMyDecks();
  }

  cards.forEach((card, i) => {
    exports.DeckEngine.AddCard(card.hanzi, card.pinyin, card.english);
    cardMeta.push(newCardMeta(serverIds[i]));
  });

  importCsvText.value = '';
  importCsvFile.value = '';
  importStatus.textContent = `Imported ${cards.length} card${cards.length === 1 ? '' : 's'}.`;
  renderCurrentCard();
});

// ---------------------------------------------------------------------------
// 7. Initial Card Load
// ---------------------------------------------------------------------------
renderCurrentCard();
refreshAuthState();

// While waiting on timers, periodically check whether a resting card has become ready.
// Only auto-refreshes the "all caught up" waiting screen, never swaps a card mid-review.
setInterval(() => {
  if (!generatorReviewActive && currentCardIndex === null) renderCurrentCard();
}, 5000);