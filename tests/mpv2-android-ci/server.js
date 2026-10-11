'use strict';
// Loopback-only integration harness: real upstream Lampa, MPV2 from checkout,
// one allowlisted test stream. Never expose this HTTP proxy to the Internet.
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '../..');
const LAMPA = path.join(ROOT, '.ci-lampa');
const PORT = Number(process.env.CI_PORT || 8787);
const SOURCE = String(process.env.MPV2_VIDEO_URL || '').trim();
if (!/^https?:\/\/[^/]+/i.test(SOURCE)) {
  console.error('MPV2_VIDEO_URL must be a valid HTTP(S) URL'); process.exit(2);
}
const allowed = new URL(SOURCE);
let mediaRequests = 0;
let mediaBytes = 0;
const errors = [];
function warn(msg) {
  const text = String(msg || '').split(SOURCE).join('[MEDIA_URL]').slice(0, 350);
  errors.push(text); if (errors.length > 30) errors.shift();
  console.error('[mpv2-ci-proxy] ' + text);
}
function headers(res, mime = 'text/plain') {
  res.setHeader('Content-Type', mime);
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Cache-Control', 'no-store');
}
function fail(res, status, text) {
  res.statusCode = status; headers(res); res.end(text);
}
function media(req, res, target = SOURCE, redirects = 0) {
  const url = new URL(target);
  if (url.hostname !== allowed.hostname || !['http:', 'https:'].includes(url.protocol)) {
    warn('Stream redirected outside its allowlisted hostname');
    return fail(res, 502, 'Unauthorized redirect');
  }
  const headersIn = { 'Accept-Encoding': 'identity', 'User-Agent': 'MPV2-Android-CI/1.0' };
  if (req.headers.range) headersIn.Range = req.headers.range;
  const transport = url.protocol === 'https:' ? https : http;
  const up = transport.request(url, {
    method: req.method === 'HEAD' ? 'HEAD' : 'GET',
    headers: headersIn, timeout: 15000
  }, upstream => {
    if ([301, 302, 303, 307, 308].includes(upstream.statusCode)) {
      upstream.resume();
      if (!upstream.headers.location || redirects >= 3) return fail(res, 502, 'Bad redirect');
      return media(req, res, new URL(upstream.headers.location, url).href, redirects + 1);
    }
    mediaRequests++;
    res.statusCode = upstream.statusCode;
    headers(res, upstream.headers['content-type'] || 'application/octet-stream');
    for (const key of ['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
      if (upstream.headers[key] !== undefined) res.setHeader(key, upstream.headers[key]);
    }
    upstream.on('data', chunk => { mediaBytes += chunk.length; });
    upstream.on('error', err => { warn(err.message); res.destroy(err); });
    upstream.pipe(res);
  });
  up.on('timeout', () => up.destroy(new Error('Upstream timed out')));
  up.on('error', err => {
    warn(err.message);
    if (!res.headersSent) fail(res, 502, 'Upstream request failed');
    else res.destroy(err);
  });
  req.on('aborted', () => up.destroy());
  up.end();
}
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript',
  '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.mp4': 'video/mp4', '.ico': 'image/x-icon'
};
function file(res, target, inject = false) {
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return fail(res, 404, 'Missing file');
  headers(res, MIME[path.extname(target)] || 'application/octet-stream');
  if (inject) {
    const markup = fs.readFileSync(target, 'utf8');
    if (!markup.includes('</body>')) return fail(res, 500, 'Upstream Lampa index changed');
    return res.end(markup.replace('</body>',
      '<script src="/lampac-js/uploads/mpvwasm-lampa-player.js"></script>' +
      '<script src="/ci/bootstrap.js"></script></body>'));
  }
  fs.createReadStream(target).pipe(res);
}
function serve(root, requested, res) {
  const decoded = decodeURIComponent(requested).replace(/^\/+/, '');
  const candidate = path.resolve(root, decoded);
  if (candidate !== root && !candidate.startsWith(root + path.sep))
    return fail(res, 403, 'Forbidden');
  file(res, candidate, candidate === path.join(LAMPA, 'index.html'));
}
const server = http.createServer((req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost:' + PORT);
    if (u.pathname === '/ci/health') {
      headers(res, 'application/json');
      return res.end(JSON.stringify({ ok: true, streamHost: allowed.hostname, mediaRequests,
        mediaBytes, errors }));
    }
    if (u.pathname === '/ci/source') return media(req, res);
    if (u.pathname === '/ci/bootstrap.js') return file(res, path.join(__dirname, 'bootstrap.js'));
    if (u.pathname === '/mpvwasm/proxy') {
      let decoded = '';
      try { decoded = Buffer.from(u.searchParams.get('u') || '', 'base64url').toString('utf8'); } catch (_) {}
      if (decoded !== SOURCE && decoded !== 'http://localhost:' + PORT + '/ci/source' &&
          decoded !== 'http://127.0.0.1:' + PORT + '/ci/source') return fail(res, 403, 'Unpermitted URL');
      return media(req, res);
    }
    if (u.pathname.startsWith('/mpvwasm/assets/'))
      return serve(path.join(ROOT, 'Modules/MpvWasm/assets'),
        u.pathname.slice('/mpvwasm/assets/'.length), res);
    if (u.pathname === '/lampac-js/uploads/mpvwasm-lampa-player.js')
      return file(res, path.join(ROOT, 'Modules/LampaWeb/plugins/mpvwasm-lampa-player.js'));
    if (u.pathname === '/') return file(res, path.join(LAMPA, 'index.html'), true);
    return serve(LAMPA, u.pathname, res);
  } catch (err) {
    warn(err.message);
    if (!res.headersSent) fail(res, 500, 'CI server error');
  }
});
server.listen(PORT, '127.0.0.1', () =>
  console.log('[mpv2-ci] Serving Lampa and MPV2 on localhost:' + PORT + ' (stream host ' + allowed.hostname + ')'));
