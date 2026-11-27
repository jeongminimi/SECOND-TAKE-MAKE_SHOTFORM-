'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// The browser loads these as plain <script> tags, so they all share one global scope. The same name
// declared with `const` in two of them is a SyntaxError that silently kills the whole second file —
// ① 영상 고르기 went blank that way on 2026-11-26 (mmss in app.js and create.js), and the same thing
// had already happened twice with other names. Compiling the files the way the browser parses them
// is the only check that knows about scope, so that is what this does. It never runs the code.
const PUBLIC = path.join(__dirname, '..', 'src', 'web', 'public');

/** The page's <script src> list, in load order. terms.js is built by the server, so it is skipped. */
function pageScripts() {
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  return [...html.matchAll(/<script\s+src="\/([^"]+\.js)"/g)]
    .map((m) => path.join(PUBLIC, path.basename(m[1])))
    .filter((p) => fs.existsSync(p));
}

test('browser scripts: each file on its own is valid JavaScript', () => {
  const files = pageScripts();
  assert.ok(files.length >= 2, 'index.html should load more than one script');
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    assert.doesNotThrow(() => new vm.Script(src), `${path.basename(f)} must parse on its own`);
  }
});

test('browser scripts: loaded together they still parse — no name is declared twice in global scope', () => {
  const joined = pageScripts().map((f) => fs.readFileSync(f, 'utf8')).join('\n;\n');
  assert.doesNotThrow(() => new vm.Script(joined),
    'two page scripts declare the same top-level name; wrap the newer file in an IIFE');
});
