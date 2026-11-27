'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function openDb(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON;');
  // TRUNCATE (not WAL/DELETE): no journal file is unlinked, which keeps SQLite working on
  // synced / sandboxed folders that forbid deletes, and on plain Windows drives alike.
  db.exec('PRAGMA journal_mode = TRUNCATE;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  migrate(db);
  const fk = db.prepare('PRAGMA foreign_keys').get();
  if (!fk || fk.foreign_keys !== 1) throw new Error('SQLite foreign keys could not be enabled');
  return db;
}

/** Adds columns introduced after v0.1 to databases created earlier (CREATE TABLE IF NOT EXISTS does not). */
const COLUMN_MIGRATIONS = [
  ['performance_candidates', 'watch_cues', "TEXT NOT NULL DEFAULT '[]'"],
  ['reels', 'template_id', 'TEXT'],
  ['source_videos', 'is_active', 'INTEGER NOT NULL DEFAULT 1'],
  ['performance_candidates', 'is_active', 'INTEGER NOT NULL DEFAULT 1'],
  // Every verdict is stored in both languages: English for tests and logs, Korean for the operator.
  ['daily_selections', 'reason_ko', 'TEXT'],
  ['daily_selections', 'skip_reason_ko', 'TEXT'],
  ['reels', 'format_reason_ko', 'TEXT'],
  ['publish_jobs', 'expected_status_ko', 'TEXT'],
  ['clip_assets', 'personal_use_only', 'INTEGER NOT NULL DEFAULT 0'],
  // Left as NULL on purpose: a reel with no stored framing uses whatever its template asks for.
  ['reels', 'crop_x', 'REAL'],
  ['reels', 'crop_y', 'REAL'],
  ['reels', 'zoom', 'REAL'],
  // The generated hashtags describe the performance; a scene tag (#kpop) is the operator's to type.
  ['performance_candidates', 'extra_hashtags', 'TEXT'],
  // The editor's text shapes. Added after the editor shipped with the wordless shapes only.
  ['edits', 'tag_text', 'TEXT'],
  ['edits', 'title_text', 'TEXT'],
  ['edits', 'performer_text', 'TEXT'],
  ['edits', 'ko_text', 'TEXT'],
  ['edits', 'why_text', 'TEXT'],
  ['edits', 'footer_text', 'TEXT'],
  // 반자동 올리기: 붙여 넣을 글과, 올렸다는 표시.
  ['edits', 'caption', 'TEXT'],
  ['edits', 'posted_at', 'TEXT'],
];
function migrate(db) {
  for (const [table, col, ddl] of COLUMN_MIGRATIONS) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
  }
}

/** Runs fn inside a transaction (BEGIN IMMEDIATE so concurrent runs of the same date serialize). */
function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

const json = {
  parse(v, fallback = null) {
    if (v === null || v === undefined || v === '') return fallback;
    try { return JSON.parse(v); } catch { return fallback; }
  },
};

module.exports = { openDb, tx, json };
