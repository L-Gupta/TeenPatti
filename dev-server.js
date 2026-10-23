'use strict';
// Local server: static files + the same API handlers Vercel runs. On Vercel this file is not used.

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { handle } = require('./lib/router');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};
const ROUTES = { '/api/auth': 'auth', '/api/state': 'state', '/api/action': 'action' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');

  if (ROUTES[url.pathname]) return handle(ROUTES[url.pathname], req, res);

  let rel;
  try { rel = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname); } catch (e) { rel = ''; }
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n  Teen Patti table is running\n');
  console.log(`  This computer:   http://localhost:${PORT}`);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list) if (i.family === 'IPv4' && !i.internal) console.log(`  Other devices:   http://${i.address}:${PORT}`);
  }
  console.log('\n  (other devices must be on the same Wi-Fi/network)\n');
});
