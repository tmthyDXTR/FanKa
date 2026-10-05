const path = require('path');
const fs = require('fs');
const express = require('express');
const cookieParser = require('cookie-parser');
const mime = require('mime-types');

const authRoutes = require('./src/routes/auth.routes');
const deckRoutes = require('./src/routes/decks.routes');
const ttsRoutes = require('./src/routes/tts.routes');
const generateRoutes = require('./src/routes/generate.routes');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// dotnet publish appends a content hash to framework files (e.g. dotnet.abc123.wasm),
// so those are safe to cache forever; everything else should revalidate.
const FINGERPRINTED = /\.[a-z0-9]{6,}\.(wasm|js|dat)$/i;

function acceptsBrotli(req) {
  return (req.headers['accept-encoding'] || '').includes('br');
}

function cacheControlFor(filePath) {
  return FINGERPRINTED.test(filePath) ? 'public, max-age=31536000, immutable' : 'no-cache';
}

const app = express();
app.set('trust proxy', 1); // behind cPanel's Passenger/Apache reverse proxy
app.use(express.json());
app.use(cookieParser());

app.use('/api', authRoutes);
app.use('/api/decks', deckRoutes);
app.use('/api/tts', ttsRoutes);
app.use('/api', generateRoutes);

// `npm run dev`: serve ../wwwroot live (uncompressed, no cache) with auto-reload on change.
// _framework (the .NET runtime) still comes from public/ via the normal handlers below.
if (process.env.DEV_LIVE === '1') {
  const LIVE_DIR = path.join(__dirname, '..', 'wwwroot');
  const clients = new Set();

  app.get('/__livereload', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
  });

  let timer;
  fs.watch(LIVE_DIR, { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(() => clients.forEach((c) => c.write('data: reload\n\n')), 100);
  });

  const reloadTag = '<script>new EventSource("/__livereload").onmessage=()=>location.reload()</script>';
  const sendIndex = (res) => res.type('html').send(fs.readFileSync(path.join(LIVE_DIR, 'index.html'), 'utf8').replace('</body>', reloadTag + '</body>'));

  app.get(['/', '/index.html'], (req, res) => sendIndex(res));
  app.use(express.static(LIVE_DIR, { index: false, setHeaders: (res) => res.set('Cache-Control', 'no-store') }));
  // Skip the stale pre-compressed copies in public/ for the files we serve live
  app.use((req, res, next) => {
    if (/^\/(_framework)\//.test(req.path) || !acceptsBrotli(req)) return next();
    delete req.headers['accept-encoding'];
    next();
  });
  console.log(`Live reload: serving ${LIVE_DIR}`);
}

// Prefer pre-compressed .br variants (produced by `dotnet publish`) when the client supports them.
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  if (!acceptsBrotli(req)) return next();

  const requestedPath = path.resolve(PUBLIC_DIR, '.' + decodeURIComponent(req.path));
  if (requestedPath !== PUBLIC_DIR && !requestedPath.startsWith(PUBLIC_DIR + path.sep)) {
    return next(); // path traversal guard
  }

  const brPath = `${requestedPath}.br`;
  fs.stat(brPath, (err, stat) => {
    if (err || !stat.isFile()) return next();
    res.set('Content-Encoding', 'br');
    res.set('Content-Type', mime.lookup(requestedPath) || 'application/octet-stream');
    res.set('Cache-Control', cacheControlFor(requestedPath));
    res.sendFile(brPath);
  });
});

app.use(express.static(PUBLIC_DIR, {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.wasm')) {
      res.set('Content-Type', 'application/wasm');
    }
    res.set('Cache-Control', cacheControlFor(filePath));
  },
}));

// Single-page app: let client-side routes fall back to index.html.
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Flashcards WASM app listening on port ${PORT}`);
});
