// Local test bench (not published): serves the app with a mock of the claude.ai runtime.
// node app/dev/server.mjs  ->  http://127.0.0.1:8766/
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const blobs = new Map();
const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.jpg': 'image/jpeg' };

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/_blob/')) {
      const id = url.pathname.slice(7);
      if (req.method === 'POST') {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        blobs.set(id, Buffer.concat(chunks));
        res.writeHead(200).end('ok');
        return;
      }
      if (!blobs.has(id)) return res.writeHead(404).end();
      res.writeHead(200, { 'content-type': 'image/jpeg' }).end(blobs.get(id));
      return;
    }
    if (url.pathname === '/') {
      const page = await readFile(join(root, 'index.html'), 'utf8');
      const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><script src="dev/mock.js"></script><script src="dev/fixture-9454.js"></script></head><body>${page}</body></html>`;
      res.writeHead(200, { 'content-type': types['.html'], 'cache-control': 'no-store' }).end(html);
      return;
    }
    const file = join(root, url.pathname);
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' }).end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(8766, '127.0.0.1', () => console.log('http://127.0.0.1:8766/'));
