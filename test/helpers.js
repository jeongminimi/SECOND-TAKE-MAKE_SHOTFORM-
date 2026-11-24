'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig } = require('../src/config');
const { openDb } = require('../src/db');
const { importFile } = require('../src/ingest/importJson');
const { ensureTestClip } = require('../src/setup/testAssets');
const { checkFfmpeg } = require('../src/render/ffmpeg');
const log = require('../src/util/log');

const SEED = path.join(__dirname, '..', 'data', 'seed', 'test-candidates.json');
log.setQuiet(true);

/**
 * Fresh DB + output dir in the OS temp folder. Test clip lives in the project (generated once, git-ignored).
 * `seed: false` leaves the database empty — used to prove a candidate can be built from nothing but the forms.
 */
async function makeEnv(overrides = {}, { seed = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpop-reels-test-'));
  const cfg = loadConfig({
    paths: { db: path.join(dir, 'test.db'), output: path.join(dir, 'output'), clips: path.join(dir, 'clips'), evidence: path.join(dir, 'evidence') },
    analysis: { cacheDir: path.join(dir, 'analysis') },
    ...overrides,
  });
  const db = openDb(cfg.resolved.db);
  if (seed) importFile(db, SEED);
  const ff = checkFfmpeg(cfg);
  if (ff.ok) await ensureTestClip(cfg);
  return { cfg, db, dir, ffmpeg: ff.ok };
}

const count = (db, table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
const NOW = Date.parse('2026-11-01T00:00:00Z'); // fixed "now" so schedule notes are deterministic

module.exports = { makeEnv, count, SEED, NOW };
