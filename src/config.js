'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function deepMerge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(base?.[k] ?? {}, v) : v;
  }
  return out;
}

/** Loads config/default.json, then config/local.json (git-ignored) if present, then programmatic overrides. */
function loadConfig(overrides = {}) {
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'default.json'), 'utf8'));
  const localPath = path.join(ROOT, 'config', 'local.json');
  const local = fs.existsSync(localPath) ? JSON.parse(fs.readFileSync(localPath, 'utf8')) : {};
  const cfg = deepMerge(deepMerge(base, local), overrides);
  const abs = (p) => (path.isAbsolute(p) ? p : path.join(ROOT, p));
  cfg.resolved = {
    root: ROOT,
    db: cfg.paths.db === ':memory:' ? ':memory:' : abs(cfg.paths.db),
    output: abs(cfg.paths.output),
    testAssets: abs(cfg.paths.testAssets),
    evidence: abs(cfg.paths.evidence),
  };
  return cfg;
}

/** Stored paths are project-relative (forward slashes) when inside the project, absolute otherwise. */
function toStoredPath(cfg, abs) {
  const rel = path.relative(cfg.resolved.root, abs);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : abs;
}
function fromStoredPath(cfg, stored) {
  return path.isAbsolute(stored) ? stored : path.join(cfg.resolved.root, stored);
}

module.exports = { loadConfig, ROOT, toStoredPath, fromStoredPath };
