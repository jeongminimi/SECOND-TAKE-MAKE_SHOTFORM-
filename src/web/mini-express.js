'use strict';
/**
 * Fallback used ONLY when the `express` package is not installed (e.g. offline sandbox).
 * Implements the tiny subset this app uses: app.get/post with :params, app.use(prefix, static),
 * express.json(), res.json/send/status/type/set/sendFile. Run `npm install` to use real Express.
 *
 * This file only ever grows by catching up with something server.js already does. Before using an
 * Express response method in a route, check it exists here — test/web.test.js runs the whole API
 * against this implementation so a missing one fails there rather than on someone's machine.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.mp4': 'video/mp4', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8' };

function compile(p) {
  const keys = [];
  const re = new RegExp('^' + p.replace(/\/:([A-Za-z_]+)/g, (_, k) => { keys.push(k); return '/([^/]+)'; }) + '/?$');
  return { re, keys };
}

function sendFile(req, res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.statusCode = 404; res.end('Not found'); return; }
    const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
    const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
    if (range) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Number(range[2]) : st.size - 1;
      res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
      fs.createReadStream(file, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Accept-Ranges': 'bytes' });
      fs.createReadStream(file).pipe(res);
    }
  });
}

function miniExpress() {
  const routes = [];
  const mounts = [];
  const app = (req, res) => handle(req, res);
  const enhance = (req, res) => {
    res.status = (c) => { res.statusCode = c; return res; };
    res.type = (t) => { res.setHeader('Content-Type', MIME['.' + t] ?? t); return res; };
    res.set = (k, v) => { if (k && typeof k === 'object') for (const [n, val] of Object.entries(k)) res.setHeader(n, val); else res.setHeader(k, v); return res; };
    res.json = (o) => { if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(o)); };
    res.send = (b) => { if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(b); };
    res.sendFile = (f) => sendFile(req, res, f);
  };
  async function handle(req, res) {
    enhance(req, res);
    const url = new URL(req.url, 'http://localhost');
    req.path = decodeURIComponent(url.pathname);
    req.query = Object.fromEntries(url.searchParams);
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(req.path);
      if (!m) continue;
      req.params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      // Only JSON is buffered here. An upload keeps its stream so the route can read the bytes itself,
      // the same way express.json() leaves a non-JSON body alone.
      if (['POST', 'PUT', 'PATCH'].includes(req.method) && /application\/json/i.test(req.headers['content-type'] ?? '')) {
        let body = '';
        for await (const chunk of req) body += chunk;
        try { req.body = body ? JSON.parse(body) : {}; } catch { req.body = {}; }
      }
      try { await r.fn(req, res); } catch (e) { res.statusCode = 500; res.json({ error: e.message }); }
      return;
    }
    for (const m of mounts) {
      if (req.method !== 'GET' && req.method !== 'HEAD') continue;
      if (req.path === m.prefix || req.path.startsWith(m.prefix === '/' ? '/' : m.prefix + '/')) {
        const rel = req.path.slice(m.prefix === '/' ? 0 : m.prefix.length) || '/';
        const file = path.join(m.dir, rel.endsWith('/') ? rel + 'index.html' : rel);
        if (!path.resolve(file).startsWith(path.resolve(m.dir))) break;
        if (fs.existsSync(file) && fs.statSync(file).isFile()) return sendFile(req, res, file);
      }
    }
    res.statusCode = 404; res.end('Not found');
  }
  for (const m of ['get', 'post', 'put', 'patch', 'delete']) {
    app[m] = (p, fn) => routes.push({ method: m.toUpperCase(), ...compile(p), fn });
  }
  app.use = (prefix, mw) => { if (typeof prefix === 'string' && mw && mw.__static) mounts.push({ prefix, dir: mw.__static }); };
  app.listen = (port, cb) => http.createServer(app).listen(port, cb);
  return app;
}
miniExpress.json = () => () => {};
miniExpress.static = (dir) => ({ __static: dir });
miniExpress.isFallback = true;

module.exports = miniExpress;
