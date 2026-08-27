#!/usr/bin/env node
/**
 * Parse-check every source file. Catches truncated or half-written files —
 * the usual damage after an agent or the machine dies mid-write.
 * Usage: node tools/parsecheck.mjs
 */
import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { transformSync } = await import(join(root, 'node_modules/esbuild/lib/main.js'));

const files = execSync("find src -name '*.js'", { cwd: root })
  .toString().trim().split('\n').filter(Boolean);

let bad = 0;
for (const f of files) {
  try {
    transformSync(readFileSync(join(root, f), 'utf8'),
      { loader: 'js', format: 'esm', sourcefile: f });
  } catch (e) {
    bad++;
    console.log(`SYNTAX FAIL  ${f}`);
    for (const err of (e.errors || []).slice(0, 3)) {
      console.log(`   line ${err.location?.line}: ${err.text}`);
    }
  }
}
console.log(bad === 0
  ? `OK — all ${files.length} files parse cleanly.`
  : `FAIL — ${bad}/${files.length} files did not parse.`);
process.exit(bad === 0 ? 0 : 1);
