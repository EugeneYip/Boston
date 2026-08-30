#!/usr/bin/env node
/**
 * Scope-check every source file: report references to identifiers that are not
 * declared in any enclosing scope, not imported, and not a known global.
 *
 * WHY THIS EXISTS
 * `parsecheck.mjs` runs esbuild's parser, which only proves a file is
 * syntactically well-formed. A bare identifier is legal syntax — esbuild
 * assumes it is a global and says nothing. So parsecheck reported "OK — all 80
 * files parse cleanly" on a tree whose boot died immediately with
 * `ReferenceError: tile is not defined at Terrain.build` (`tile` was a
 * parameter of `_patch()` being read from `build()`). The shared dev server was
 * dead for a long stretch and the visual critic had to serve its own snapshot
 * to get any captures at all. This tool closes exactly that gap.
 *
 * It is a static approximation, deliberately biased against false positives: a
 * name declared anywhere in an enclosing scope resolves, hoisting and forward
 * references are honoured, and anything in GLOBALS is allowed. It cannot see
 * conditional or cross-module runtime failures — booting the app remains the
 * authoritative gate.
 *
 * Usage: node tools/scopecheck.mjs
 */
import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { parseAst } from 'rollup/parseAst';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const GLOBALS = new Set([
  // ECMAScript
  'globalThis','undefined','NaN','Infinity','Object','Function','Boolean','Symbol','Error',
  'EvalError','RangeError','ReferenceError','SyntaxError','TypeError','URIError','AggregateError',
  'Number','BigInt','Math','Date','String','RegExp','Array','Int8Array','Uint8Array',
  'Uint8ClampedArray','Int16Array','Uint16Array','Int32Array','Uint32Array','Float32Array',
  'Float64Array','BigInt64Array','BigUint64Array','Map','Set','WeakMap','WeakSet','WeakRef',
  'ArrayBuffer','SharedArrayBuffer','DataView','JSON','Promise','Reflect','Proxy','Intl',
  'parseInt','parseFloat','isNaN','isFinite','decodeURI','decodeURIComponent','encodeURI',
  'encodeURIComponent','escape','unescape','eval','arguments','structuredClone','queueMicrotask',
  // DOM / browser
  'window','document','navigator','location','history','screen','console','performance',
  'localStorage','sessionStorage','indexedDB','caches','crypto','fetch','Headers','Request',
  'Response','FormData','Blob','File','FileReader','URL','URLSearchParams','AbortController',
  'AbortSignal','Event','EventTarget','CustomEvent','MessageChannel','MessagePort','Worker',
  'SharedWorker','WebSocket','XMLHttpRequest','Image','Audio','Option','HTMLElement','Element',
  'Node','NodeList','DocumentFragment','MutationObserver','ResizeObserver','IntersectionObserver',
  'PerformanceObserver','requestAnimationFrame','cancelAnimationFrame','requestIdleCallback',
  'cancelIdleCallback','setTimeout','clearTimeout','setInterval','clearInterval','alert','confirm',
  'prompt','getComputedStyle','matchMedia','devicePixelRatio','innerWidth','innerHeight',
  'outerWidth','outerHeight','scrollX','scrollY','self','top','parent','frames','open','close',
  'postMessage','addEventListener','removeEventListener','dispatchEvent','atob','btoa',
  'TextEncoder','TextDecoder','ReadableStream','WritableStream','TransformStream',
  'OffscreenCanvas','ImageData','ImageBitmap','createImageBitmap','Path2D','DOMMatrix','DOMPoint',
  'CanvasRenderingContext2D','WebGLRenderingContext','WebGL2RenderingContext','GPUBuffer',
  'AudioContext','webkitAudioContext','MediaRecorder','MediaStream','Gamepad','Touch','PointerEvent',
  'KeyboardEvent','MouseEvent','WheelEvent','TouchEvent','DragEvent','ProgressEvent','ErrorEvent',
  'CSS','FontFace','Notification','Screen','VisualViewport','visualViewport','speechSynthesis',
  // Node (tools/ and config files)
  'process','Buffer','__dirname','__filename','require','module','exports','global','setImmediate',
]);

const FN = new Set(['FunctionDeclaration','FunctionExpression','ArrowFunctionExpression']);

/** A lexical scope. `varScope` marks a function/module boundary that `var` hoists to. */
class Scope {
  constructor(parent, isVarScope) {
    this.parent = parent; this.isVarScope = isVarScope; this.names = new Set();
  }
  declare(n) { this.names.add(n); }
  varScope() { let s = this; while (!s.isVarScope) s = s.parent; return s; }
  resolve(n) { for (let s = this; s; s = s.parent) if (s.names.has(n)) return true; return false; }
}

function checkFile(file, src) {
  let ast;
  try { ast = parseAst(src, { allowReturnOutsideFunction: true }); }
  catch { return []; }   // parsecheck owns syntax errors; stay silent here

  const binding = new Set();   // Identifier nodes that are declarations, not references
  const refs = [];             // { name, scope, node }
  const lineOf = (pos) => src.slice(0, pos).split('\n').length;

  // Declare every name a binding pattern introduces, and remember those nodes so
  // the generic walk does not later count them as references.
  const bind = (node, scope) => {
    if (!node) return;
    switch (node.type) {
      case 'Identifier': binding.add(node); scope.declare(node.name); break;
      case 'ObjectPattern':
        for (const p of node.properties) {
          if (p.type === 'RestElement') bind(p.argument, scope);
          else bind(p.value, scope);
        }
        break;
      case 'ArrayPattern': for (const e of node.elements) bind(e, scope); break;
      case 'AssignmentPattern': bind(node.left, scope); break;
      case 'RestElement': bind(node.argument, scope); break;
      default: break;   // MemberExpression target in `[a.b] = x` is a reference
    }
  };

  // Pass 1: hoist declarations that are visible before their textual position.
  const hoist = (body, scope) => {
    for (const st of body) {
      if (!st) continue;
      if (st.type === 'FunctionDeclaration' && st.id) { binding.add(st.id); scope.declare(st.id.name); }
      else if (st.type === 'ClassDeclaration' && st.id) { binding.add(st.id); scope.declare(st.id.name); }
      else if (st.type === 'ImportDeclaration') {
        for (const sp of st.specifiers) { binding.add(sp.local); scope.declare(sp.local.name); }
      }
      else if (st.type === 'ExportNamedDeclaration' && st.declaration) hoist([st.declaration], scope);
      else if (st.type === 'ExportDefaultDeclaration' && st.declaration?.id &&
               (st.declaration.type === 'FunctionDeclaration' || st.declaration.type === 'ClassDeclaration')) {
        binding.add(st.declaration.id); scope.declare(st.declaration.id.name);
      }
    }
  };

  // `var` and nested function declarations hoist all the way to the function scope.
  const hoistVars = (node, varScope) => {
    const seen = new Set();
    const walk = (n) => {
      if (!n || typeof n !== 'object' || seen.has(n)) return;
      if (Array.isArray(n)) { for (const c of n) walk(c); return; }
      if (!n.type) return;
      seen.add(n);
      if (FN.has(n.type) && n !== node) return;              // stop at nested functions
      if (n.type === 'VariableDeclaration' && n.kind === 'var') for (const d of n.declarations) bind(d.id, varScope);
      if (n.type === 'FunctionDeclaration' && n.id && n !== node) { binding.add(n.id); varScope.declare(n.id.name); }
      for (const k in n) { if (k === 'type' || k === 'start' || k === 'end' || k === 'loc') continue; walk(n[k]); }
    };
    walk(node);
  };

  const walk = (node, scope) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const c of node) walk(c, scope); return; }
    if (!node.type) return;

    switch (node.type) {
      case 'Identifier':
        if (!binding.has(node)) refs.push({ name: node.name, scope, node });
        return;

      case 'MemberExpression':
        walk(node.object, scope);
        if (node.computed) walk(node.property, scope);      // a[b] -> b is a reference
        return;

      case 'Property':
        if (node.computed) walk(node.key, scope);           // {[k]: v} -> k is a reference
        walk(node.value, scope);                            // plain keys are not
        return;

      case 'PropertyDefinition':
      case 'MethodDefinition':
        if (node.computed) walk(node.key, scope);
        walk(node.value, scope);
        return;

      case 'MetaProperty': return;                        // import.meta, new.target
      case 'LabeledStatement': walk(node.body, scope); return;
      case 'BreakStatement': case 'ContinueStatement': return;   // labels are not references

      case 'ExportNamedDeclaration':
        // `export { a }` references a binding; `export { a } from 'x'` does not.
        walk(node.declaration, scope);
        if (!node.source) for (const sp of node.specifiers) walk(sp.local, scope);
        return;
      case 'ImportDeclaration': case 'ExportAllDeclaration': return;

      case 'VariableDeclaration':
        for (const d of node.declarations) {
          if (node.kind !== 'var') bind(d.id, scope);        // var already hoisted
          else markVarPattern(d.id);
          walk(d.id, scope);                                 // defaults / computed keys
          walk(d.init, scope);
        }
        return;

      case 'FunctionDeclaration': case 'FunctionExpression': case 'ArrowFunctionExpression': {
        const s = new Scope(scope, true);
        if (node.type === 'FunctionExpression' && node.id) { binding.add(node.id); s.declare(node.id.name); }
        for (const p of node.params) { bind(p, s); walk(p, s); }
        s.declare('arguments');
        hoistVars(node.body, s);
        if (node.body?.type === 'BlockStatement') { hoist(node.body.body, s); walk(node.body.body, s); }
        else walk(node.body, s);
        return;
      }

      case 'ClassDeclaration': case 'ClassExpression': {
        const s = new Scope(scope, false);
        if (node.id) { binding.add(node.id); s.declare(node.id.name); }
        walk(node.superClass, scope);
        walk(node.body, s);
        return;
      }

      case 'BlockStatement': {
        const s = new Scope(scope, false);
        hoist(node.body, s);
        walk(node.body, s);
        return;
      }

      case 'SwitchStatement': {
        walk(node.discriminant, scope);
        const s = new Scope(scope, false);
        for (const c of node.cases) hoist(c.consequent, s);
        for (const c of node.cases) { walk(c.test, s); walk(c.consequent, s); }
        return;
      }

      case 'CatchClause': {
        const s = new Scope(scope, false);
        if (node.param) { bind(node.param, s); walk(node.param, s); }
        hoist(node.body.body, s);
        walk(node.body.body, s);
        return;
      }

      case 'ForStatement': {
        const s = new Scope(scope, false);
        walk(node.init, s); walk(node.test, s); walk(node.update, s);
        walkLoopBody(node.body, s);
        return;
      }
      case 'ForInStatement': case 'ForOfStatement': {
        const s = new Scope(scope, false);
        if (node.left?.type === 'VariableDeclaration') walk(node.left, s);
        else walk(node.left, s);
        walk(node.right, scope);
        walkLoopBody(node.body, s);
        return;
      }

      default: {
        for (const k in node) {
          if (k === 'type' || k === 'start' || k === 'end' || k === 'loc' || k === 'range') continue;
          walk(node[k], scope);
        }
      }
    }
  };

  // A loop body block shares the loop's scope rather than nesting a redundant one,
  // so `for (let i...) { ... i ... }` resolves without a second lookup level.
  function walkLoopBody(body, s) {
    if (body?.type === 'BlockStatement') { hoist(body.body, s); walk(body.body, s); }
    else walk(body, s);
  }
  // `var` patterns were bound into the function scope during hoisting; mark their
  // identifier nodes so the generic walk does not re-read them as references.
  function markVarPattern(n) {
    if (!n) return;
    if (n.type === 'Identifier') binding.add(n);
    else if (n.type === 'ObjectPattern') for (const p of n.properties) markVarPattern(p.type === 'RestElement' ? p.argument : p.value);
    else if (n.type === 'ArrayPattern') for (const e of n.elements) markVarPattern(e);
    else if (n.type === 'AssignmentPattern') markVarPattern(n.left);
    else if (n.type === 'RestElement') markVarPattern(n.argument);
  }

  const module = new Scope(null, true);
  hoist(ast.body, module);
  hoistVars(ast, module);
  walk(ast.body, module);

  const out = [];
  const reported = new Set();
  for (const r of refs) {
    if (GLOBALS.has(r.name)) continue;
    if (r.scope.resolve(r.name)) continue;
    const line = lineOf(r.node.start);
    const key = r.name + ':' + line;
    if (reported.has(key)) continue;
    reported.add(key);
    out.push({ name: r.name, line });
  }
  return out.sort((a, b) => a.line - b.line);
}

// Explicit paths check just those files; otherwise sweep the tree.
const argv = process.argv.slice(2);
const files = argv.length ? argv
  : execSync("find src tools -name '*.js' -o -name '*.mjs'", { cwd: root })
      .toString().trim().split('\n').filter(Boolean);

let bad = 0, total = 0;
for (const f of files) {
  const found = checkFile(f, readFileSync(f.startsWith('/') ? f : join(root, f), 'utf8'));
  if (found.length) {
    bad++; total += found.length;
    console.log(`SCOPE FAIL   ${f}`);
    for (const v of found.slice(0, 8)) console.log(`   line ${v.line}: '${v.name}' is not defined`);
    if (found.length > 8) console.log(`   ... and ${found.length - 8} more`);
  }
}
console.log(bad === 0
  ? `OK — no undefined references in ${files.length} files.`
  : `FAIL — ${total} undefined reference(s) in ${bad}/${files.length} files.`);
process.exit(bad === 0 ? 0 : 1);
