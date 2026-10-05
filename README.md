# node-host

A Node.js/Express app that serves the published `dotnet` WebAssembly client **and**
the login/decks/TTS API, for hosts that only support Node.js (e.g. FastComet
shared hosting, which has no .NET runtime).

- Static client files (`dotnet publish` output) served with correct
  `Content-Type: application/wasm`, brotli (`.br`) negotiation, and long-lived
  immutable caching for the content-hashed `_framework` files.
- `/api/register`, `/api/login`, `/api/refresh`, `/api/logout`, `/api/me` —
  email/password accounts with short-lived JWT access tokens (sent in the
  response body, used as `Authorization: Bearer <token>`) and a rotating,
  httpOnly-cookie refresh token.
- `/api/decks/*` — per-user deck/card CRUD (including editing a card via
  `PUT /api/decks/:deckId/cards/:cardId`), per-deck review-timer settings and
  card progress, backed by SQLite (`better-sqlite3`).
- `/api/tts` — proxies Google Translate's TTS endpoint same-origin.
- `/api/generate-cards` — authenticated Mandarin flashcard generation through a configurable OpenAI-compatible model API.

## App features

- **Learn mode**: flip the card, then grade it Easy / Hard / Wrong. Cards move between
  Remaining, Hard, Easy and Done piles with adjustable per-deck timers, and progress is saved
  per card for saved decks. Controls mirror the arrow keys and swipes (Left = Flip, Up = Easy,
  Down = Hard, Right = Wrong). Space plays the pronunciation.
- **Options (⚙)**: card direction (汉字 → English or English → 汉字), auto-listen after flip,
  show/hide pinyin, dark/light theme, and card text size.
- **Edit Cards**: browse the whole deck as small front/back tiles, search across hanzi,
  pinyin and English, and edit or delete cards of a saved deck. Changing the hanzi
  regenerates the pinyin.
- **AI card generation**: see below.
- **Layout tuning**: card size and the swipe/nudge animation are CSS variables at the top of
  `wwwroot/index.html` (`--card-width-desktop`, `--card-height-desktop`,
  `--card-nudge-distance`, `--card-nudge-duration`, `--card-drag-follow`).

## Setup

```bash
cd node-host
cp .env.example .env   # then set JWT_SECRET (see the comment in that file)
npm install
```

`better-sqlite3` is a native module — `npm install` compiles/downloads a
binding for the Node version it's run with. **Requires Node >= 22** (older
Node versions' V8 API isn't compatible with this better-sqlite3 release). If
`npm install` reports install scripts were blocked, run:

```bash
npm install-scripts approve better-sqlite3
npm rebuild better-sqlite3
```

## Build & sync the WASM client

From the project root:

```bash
dotnet publish -c Release
cd node-host
npm run sync-wasm   # copies bin/Release/net10.0/publish/wwwroot -> node-host/public
```

Run `npm run sync-wasm` again any time you re-publish.

## AI card generation

The overview page can generate 1–20 suggested cards for a topic. Sign in, enter
a topic and quantity, and a progress bar shows while the model works. The model
only writes the hanzi and English; pinyin is generated in the browser with
`pinyin-pro`.

Suggestions are then reviewed inside the Learn screen, with the same layout as
learning: **Left** = Flip, **Up** = Accept, **Right** = Decline (Accept and
Decline appear after flipping). Arrow keys and swipes work too. Accepted and
declined cards are tallied in the piles. Accepted cards are added to the
in-memory deck and, when a saved deck is loaded, to that server deck as well.

If you press Back mid-review, the remaining suggestions are kept and a
**Resume review** button on the overview shows how many are left. A page reload
discards an unfinished review.

Configure an OpenAI-compatible chat completions provider in the server
environment (for example, in `.env` for local development):

```dotenv
LLM_API_BASE_URL=https://openrouter.ai/api/v1
LLM_API_KEY=your-provider-api-key
LLM_MODEL=provider/model-id
```

Choose a model that is currently available to your account; free-tier model
availability and identifiers can change. To switch providers, change the base
URL, model, and key. The key is only used by the Node server and is never sent
to the browser. Local OpenAI-compatible servers can use an `http://localhost`
base URL and omit the key. Models that return no usable text or invalid JSON produce an error; try again or pick another
model. Generation is limited to 10 requests per IP per hour
and requires a signed-in user. If these variables are unset, the UI reports
that generation is not configured.

## Run locally

```bash
PORT=3000 npm start
```

For UI work, `npm run dev` serves the raw `../wwwroot` files live with auto-reload, so no
publish is needed. Restart the server after changing `.env` or route files. Keep real keys
and `JWT_SECRET` only in `.env`, never in `.env.example` or in chat.

The SQLite database is created at `node-host/data/flashcards.db` on first run
(override with `DB_PATH` in `.env`).

## Deploy to FastComet

1. Upload the whole `node-host` folder to your account (e.g. via File Manager/FTP),
   excluding `node_modules` and `data/` (these are created on the server).
2. In cPanel, open **Setup Node.js App** and create an application:
   - Application root: the uploaded `node-host` folder
   - Application startup file: `server.js`
   - Node version: **22 or newer**
3. In the app's **Environment Variables**, set `JWT_SECRET` (a long random
   string) and `NODE_ENV=production`.
4. Click **Run NPM Install**. If better-sqlite3's build step is blocked, use
   the app's "Run JS Script"/terminal option to run the two approve/rebuild
   commands above.
5. Start/restart the app. Passenger sets `PORT` automatically; `server.js`
   reads it.
6. Point your domain/subdomain at the Node.js app as shown in the cPanel UI.
7. Back up `node-host/data/flashcards.db` periodically — it's the only
   persistent state (users, decks, cards).

Whenever you change the WASM app, re-run `dotnet publish` + `npm run
sync-wasm` locally, re-upload the `public` folder, and restart the Node.js
app in cPanel. Server code changes (`server.js`, `src/**`) just need a
re-upload + restart, no rebuild.
