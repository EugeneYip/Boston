/**
 * Stage 2A.3 — local capture sink.
 *
 *   node research/gis-stage2a3/sink.mjs
 *
 * The Browser pane can render a shot but cannot write a file. This accepts the
 * two things a pair needs — the PNG for the sheet and the RAW RGBA for the
 * measurement — and puts them on disk. Raw rather than PNG for the diff because
 * decoding a PNG here would need a dependency, and this stage adds none.
 *
 * Local only, loopback only, and everything it writes is gitignored.
 */
import { createServer } from 'node:http';
import { writeFileSync, mkdirSync } from 'node:fs';
const DIR = new URL('./captures/', import.meta.url);
mkdirSync(DIR, { recursive: true });
const safe = (s) => s.replace(/[^A-Za-z0-9._-]/g, '_');
createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const [, kind, name] = req.url.split('/');
    const body = Buffer.concat(chunks);
    if (kind === 'png') {
      writeFileSync(new URL(`${safe(name)}.png`, DIR), Buffer.from(body.toString().split(',')[1], 'base64'));
    } else if (kind === 'raw') {
      writeFileSync(new URL(`${safe(name)}.raw`, DIR), body);
    }
    console.log(`${kind} ${name} ${body.length} bytes`);
    res.writeHead(200); res.end('ok');
  });
}).listen(5299, '127.0.0.1', () => console.log('sink on http://127.0.0.1:5299'));
