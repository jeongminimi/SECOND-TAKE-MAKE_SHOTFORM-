'use strict';
/**
 * Saving one record at a time, the way the operator screen does it.
 *
 * importJson.js takes a whole document and joins rows by payload-local keys; here a form sends a
 * single row that points at rows already in the database by id. Both go through validate.js, so the
 * rules are the same — only the way records find each other differs.
 *
 * Nothing is ever hard-deleted: a record the operator is done with is deactivated, which keeps the
 * history of why a past selection happened intact while stopping the record from being picked again.
 */
const fs = require('node:fs');
const path = require('node:path');
const { tx } = require('../db');
const { toStoredPath } = require('../config');
const V = require('./validate');
const { parseTimecode } = require('../util/time');
const { suggestFromFilename } = require('./youtubeUrl');

/**
 * Identifiers are the program's business, not the operator's. They are built from the names that
 * were typed and only shown as small print afterwards, so nobody has to invent `P003-orbit-bluehour`
 * before they can save a row. A collision gets a number, never an overwrite.
 */
function slug(s) {
  return String(s ?? '').trim().toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function uniqueKey(db, table, column, base) {
  const stem = base || 'item';
  const taken = (k) => db.prepare(`SELECT 1 FROM ${table} WHERE ${column} = ?`).get(k);
  if (!taken(stem)) return stem;
  for (let i = 2; ; i++) {
    const k = `${stem}-${i}`;
    if (!taken(k)) return k;
  }
}

const num = (v) => (v === '' || v === null || v === undefined ? null : Number(v));
/** A position in a video, typed either as `1:23` or as a number of seconds. See util/time.js. */
const secs = (v) => parseTimecode(v);
const str = (v) => (v === '' || v === undefined ? null : v);
const bool = (v, dflt = 0) => (v === undefined || v === null ? dflt : (v ? 1 : 0));

/** Returns {row, issues}; issues may hold warnings even when the save succeeded. */
function saved(row, issues, extra = {}) {
  return { row, issues, warnings: issues.filter((i) => i.level === 'warn'), ...extra };
}

/**
 * Changing where a clip starts changes the video and the caption, but not who was chosen that day.
 * So the reels built from it are put back to `pending` and re-rendered on the SAME row by re-running
 * their date — no re-selection, no new revision, and the record of why that day was picked is kept.
 *
 * @returns {string[]} the operating dates that need re-running
 */
function markReelsForRerender(db, { clipAssetId = null, candidateId = null }) {
  const where = clipAssetId != null
    ? { sql: 'r.clip_asset_id = ?', arg: clipAssetId }
    : { sql: 'ds.candidate_id = ?', arg: candidateId };
  const rows = db.prepare(`SELECT r.id, ds.operating_date FROM reels r
                             JOIN daily_selections ds ON ds.id = r.selection_id
                            WHERE ${where.sql}`).all(where.arg);
  if (!rows.length) return [];
  const live = db.prepare(`SELECT 1 FROM publish_jobs WHERE mode = 'live' AND reel_id IN (${rows.map(() => '?').join(',')})`)
    .get(...rows.map((r) => r.id));
  if (live) throw new Error('A live publish job already used this reel; register a new clip instead of changing this one');
  db.prepare(`UPDATE reels SET render_status = 'pending', updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
                WHERE id IN (${rows.map(() => '?').join(',')})`).run(...rows.map((r) => r.id));
  return [...new Set(rows.map((r) => r.operating_date))].sort();
}

function saveChannel(db, d) {
  const issues = V.validateChannel(d);
  V.assertValid(issues);
  return tx(db, () => {
    const row = d.id
      ? db.prepare(`UPDATE source_channels SET platform = ?, external_id = ?, name = ?, is_active = ?, is_test = ? WHERE id = ? RETURNING *`)
        .get(d.platform, d.external_id, d.name, bool(d.is_active, 1), bool(d.is_test), d.id)
      : db.prepare(`INSERT INTO source_channels (platform, external_id, name, is_active, is_test) VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT (platform, external_id) DO UPDATE SET name = excluded.name, is_active = excluded.is_active, is_test = excluded.is_test
                    RETURNING *`).get(d.platform, d.external_id, d.name, bool(d.is_active, 1), bool(d.is_test));
    if (!row) throw new Error(`channel ${d.id} not found`);
    return saved(row, issues);
  });
}

/**
 * A video registered from a file with no link still needs something in the key the table dedupes on.
 * Leaving it blank is what the task asked for, but (platform, platform_video_id) is UNIQUE and the
 * INSERT upserts on it: the second link-less video would overwrite the first. So a local row gets a
 * key derived from its own title, and `platform: 'local'` keeps it from reading as a platform id.
 */
function localVideoKey(db, d) {
  if (d.id) return d.platform_video_id ?? null;
  return uniqueKey(db, 'source_videos', 'platform_video_id', `file-${slug(d.title)}`);
}

function saveVideo(db, d) {
  if (String(d.platform ?? '').toLowerCase() === 'local') {
    d = { ...d, official_url: d.official_url ?? '', platform_video_id: d.platform_video_id || localVideoKey(db, d) };
  }
  const issues = V.validateVideo(d);
  V.assertValid(issues);
  return tx(db, () => {
    const ch = db.prepare('SELECT id FROM source_channels WHERE id = ?').get(d.channel_id);
    if (!ch) throw new Error(`video: unknown channel ${d.channel_id}`);
    const row = d.id
      ? db.prepare(`UPDATE source_videos SET channel_id = ?, platform = ?, platform_video_id = ?, official_url = ?, title = ?, description = ?, published_at = ?, is_active = ?
                    WHERE id = ? RETURNING *`)
        .get(d.channel_id, d.platform, d.platform_video_id, d.official_url, d.title, str(d.description), d.published_at, bool(d.is_active, 1), d.id)
      : db.prepare(`INSERT INTO source_videos (channel_id, platform, platform_video_id, official_url, title, description, published_at, is_active)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT (platform, platform_video_id) DO UPDATE SET channel_id = excluded.channel_id, official_url = excluded.official_url,
                      title = excluded.title, description = excluded.description, published_at = excluded.published_at, is_active = excluded.is_active
                    RETURNING *`)
        .get(d.channel_id, d.platform, d.platform_video_id, d.official_url, d.title, str(d.description), d.published_at, bool(d.is_active, 1));
    if (!row) throw new Error(`video ${d.id} not found`);
    return saved(row, issues);
  });
}

function saveTrack(db, d) {
  if (!d.id && !d.track_key) d = { ...d, track_key: uniqueKey(db, 'tracks', 'track_key', `tr-${slug(d.title_en || d.title_ko)}`) };
  const issues = V.validateTrack(d);
  V.assertValid(issues);
  return tx(db, () => {
    const row = d.id
      ? db.prepare(`UPDATE tracks SET track_key = ?, original_artist_en = ?, original_artist_ko = ?, title_en = ?, title_ko = ?, name_evidence = ? WHERE id = ? RETURNING *`)
        .get(d.track_key, str(d.original_artist_en), str(d.original_artist_ko), str(d.title_en), str(d.title_ko), str(d.name_evidence), d.id)
      : db.prepare(`INSERT INTO tracks (track_key, original_artist_en, original_artist_ko, title_en, title_ko, name_evidence) VALUES (?, ?, ?, ?, ?, ?)
                    ON CONFLICT (track_key) DO UPDATE SET original_artist_en = excluded.original_artist_en, original_artist_ko = excluded.original_artist_ko,
                      title_en = excluded.title_en, title_ko = excluded.title_ko, name_evidence = excluded.name_evidence
                    RETURNING *`).get(d.track_key, str(d.original_artist_en), str(d.original_artist_ko), str(d.title_en), str(d.title_ko), str(d.name_evidence));
    if (!row) throw new Error(`track ${d.id} not found`);
    return saved(row, issues);
  });
}

/** Tags and cues arrive as arrays from the form and are stored as JSON, exactly as the importer stores them. */
function saveCandidate(db, d) {
  if (!d.id && !d.candidate_key) {
    const track = d.track_id ? db.prepare('SELECT title_en, title_ko FROM tracks WHERE id = ?').get(d.track_id) : null;
    const parts = [d.performer_en || d.performer_ko, track?.title_en || track?.title_ko, (d.arrangement_tags ?? [])[0] || d.performance_type];
    d = { ...d, candidate_key: uniqueKey(db, 'performance_candidates', 'candidate_key', slug(parts.filter(Boolean).join(' '))) };
  }
  const tags = Array.isArray(d.arrangement_tags) ? d.arrangement_tags.filter(Boolean) : [];
  const cues = Array.isArray(d.watch_cues) ? d.watch_cues : [];
  const shaped = {
    ...d,
    arrangement_tags: tags,
    watch_cues: cues,
    segment_start_sec: secs(d.segment_start_sec),
    segment_end_sec: secs(d.segment_end_sec),
  };
  const issues = V.validateCandidate(shaped);
  V.assertValid(issues);
  return tx(db, () => {
    const v = db.prepare('SELECT id FROM source_videos WHERE id = ?').get(d.source_video_id);
    if (!v) throw new Error(`candidate ${d.candidate_key}: unknown source video ${d.source_video_id}`);
    if (d.track_id != null && !db.prepare('SELECT id FROM tracks WHERE id = ?').get(d.track_id)) {
      throw new Error(`candidate ${d.candidate_key}: unknown track ${d.track_id}`);
    }
    const vals = [
      d.candidate_key, d.source_video_id, d.track_id ?? null, str(d.performer_en), str(d.performer_ko), str(d.program_name),
      str(d.performance_type), JSON.stringify(tags), str(d.version_evidence),
      shaped.segment_start_sec, shaped.segment_end_sec, str(d.segment_evidence),
      str(d.why_watch_en), str(d.why_watch_evidence), str(d.occasion_note), str(d.occasion_date), str(d.occasion_evidence),
      JSON.stringify(cues), str(d.judgement_notes), str(d.extra_hashtags), bool(d.is_active, 1),
    ];
    const row = d.id
      ? db.prepare(`UPDATE performance_candidates SET candidate_key = ?, source_video_id = ?, track_id = ?, performer_en = ?, performer_ko = ?,
                      program_name = ?, performance_type = ?, arrangement_tags = ?, version_evidence = ?, segment_start_sec = ?, segment_end_sec = ?,
                      segment_evidence = ?, why_watch_en = ?, why_watch_evidence = ?, occasion_note = ?, occasion_date = ?, occasion_evidence = ?,
                      watch_cues = ?, judgement_notes = ?, extra_hashtags = ?, is_active = ? WHERE id = ? RETURNING *`).get(...vals, d.id)
      : db.prepare(`INSERT INTO performance_candidates (candidate_key, source_video_id, track_id, performer_en, performer_ko, program_name,
                      performance_type, arrangement_tags, version_evidence, segment_start_sec, segment_end_sec, segment_evidence,
                      why_watch_en, why_watch_evidence, occasion_note, occasion_date, occasion_evidence, watch_cues, judgement_notes,
                      extra_hashtags, is_active)
                    VALUES (${vals.map(() => '?').join(', ')})
                    ON CONFLICT (candidate_key) DO UPDATE SET source_video_id = excluded.source_video_id, track_id = excluded.track_id,
                      performer_en = excluded.performer_en, performer_ko = excluded.performer_ko, program_name = excluded.program_name,
                      performance_type = excluded.performance_type, arrangement_tags = excluded.arrangement_tags, version_evidence = excluded.version_evidence,
                      segment_start_sec = excluded.segment_start_sec, segment_end_sec = excluded.segment_end_sec, segment_evidence = excluded.segment_evidence,
                      why_watch_en = excluded.why_watch_en, why_watch_evidence = excluded.why_watch_evidence, occasion_note = excluded.occasion_note,
                      occasion_date = excluded.occasion_date, occasion_evidence = excluded.occasion_evidence, watch_cues = excluded.watch_cues,
                      judgement_notes = excluded.judgement_notes, extra_hashtags = excluded.extra_hashtags, is_active = excluded.is_active
                    RETURNING *`).get(...vals);
    if (!row) throw new Error(`candidate ${d.id} not found`);
    return saved(row, issues);
  });
}

/** The file must already be on disk — registering a path we cannot see would be a claim without a file. */
function saveClipAsset(db, cfg, d) {
  if (!d.id && !d.asset_key) {
    const cand = db.prepare('SELECT candidate_key FROM performance_candidates WHERE id = ?').get(d.candidate_id);
    d = { ...d, asset_key: uniqueKey(db, 'clip_assets', 'asset_key', `${slug(cand?.candidate_key) || 'clip'}-clip`) };
  }
  const shaped = { ...d, source_start_sec: secs(d.source_start_sec), source_end_sec: secs(d.source_end_sec) };
  const issues = V.validateClipAsset(shaped);
  V.assertValid(issues);
  return tx(db, () => {
    if (!db.prepare('SELECT id FROM performance_candidates WHERE id = ?').get(d.candidate_id)) {
      throw new Error(`clip asset ${d.asset_key}: unknown candidate ${d.candidate_id}`);
    }
    const vals = [d.asset_key, d.candidate_id, d.file_ref, shaped.source_start_sec, shaped.source_end_sec,
      num(d.file_offset_sec) ?? 0, bool(d.is_test_asset), bool(d.personal_use_only), str(d.notes)];
    const row = d.id
      ? db.prepare(`UPDATE clip_assets SET asset_key = ?, candidate_id = ?, file_ref = ?, source_start_sec = ?, source_end_sec = ?,
                      file_offset_sec = ?, is_test_asset = ?, personal_use_only = ?, notes = ? WHERE id = ? RETURNING *`).get(...vals, d.id)
      : db.prepare(`INSERT INTO clip_assets (asset_key, candidate_id, file_ref, source_start_sec, source_end_sec, file_offset_sec, is_test_asset, personal_use_only, notes)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT (asset_key) DO UPDATE SET candidate_id = excluded.candidate_id, file_ref = excluded.file_ref,
                      source_start_sec = excluded.source_start_sec, source_end_sec = excluded.source_end_sec,
                      file_offset_sec = excluded.file_offset_sec, is_test_asset = excluded.is_test_asset,
                      personal_use_only = excluded.personal_use_only, notes = excluded.notes
                    RETURNING *`).get(...vals);
    if (!row) throw new Error(`clip asset ${d.id} not found`);
    // A range that moved has to reach the finished video; a clip registered for the first time has no
    // reel to re-render yet, so this is a no-op for new clips.
    const rerunDates = markReelsForRerender(db, { clipAssetId: row.id });
    return saved(row, issues, { rerunDates });
  });
}

function savePermission(db, d) {
  const shaped = {
    ...d,
    permitted_start_sec: num(d.permitted_start_sec),
    permitted_end_sec: num(d.permitted_end_sec),
  };
  const asset = db.prepare('SELECT asset_key FROM clip_assets WHERE id = ?').get(d.clip_asset_id);
  if (!asset) throw new Error(`permission: unknown clip asset ${d.clip_asset_id}`);
  const issues = V.validatePermission(shaped, asset.asset_key);
  V.assertValid(issues);
  return tx(db, () => {
    const row = db.prepare(`
      INSERT INTO usage_permissions (clip_asset_id, rights_category, rights_holder, status, allows_edit, allows_repost, platforms,
        territories, valid_from, valid_until, permitted_start_sec, permitted_end_sec, evidence_ref, is_test_permission)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (clip_asset_id, rights_category) DO UPDATE SET rights_holder = excluded.rights_holder, status = excluded.status,
        allows_edit = excluded.allows_edit, allows_repost = excluded.allows_repost, platforms = excluded.platforms,
        territories = excluded.territories, valid_from = excluded.valid_from, valid_until = excluded.valid_until,
        permitted_start_sec = excluded.permitted_start_sec, permitted_end_sec = excluded.permitted_end_sec,
        evidence_ref = excluded.evidence_ref, is_test_permission = excluded.is_test_permission
      RETURNING *`).get(d.clip_asset_id, d.rights_category, str(d.rights_holder), d.status, bool(d.allows_edit), bool(d.allows_repost),
      JSON.stringify(d.platforms ?? []), JSON.stringify(d.territories ?? []), str(d.valid_from), str(d.valid_until),
      shaped.permitted_start_sec, shaped.permitted_end_sec, str(d.evidence_ref), bool(d.is_test_permission));
    return saved(row, issues);
  });
}

const ACTIVATABLE = { channel: 'source_channels', video: 'source_videos', candidate: 'performance_candidates' };

/**
 * Records where the interesting moment is and how the operator knows — the two fields that let the
 * caption carry `▶ 1:23` instead of a bare link. Written from step 5, where the clip range is typed
 * off the YouTube "most replayed" graph, so the time and its source arrive together.
 *
 * Touches only these two columns: everything else about the candidate is left exactly as it was.
 */
function setCandidateSegment(db, { candidate_id, start_sec, end_sec = null, evidence }) {
  const start = secs(start_sec);
  const end = secs(end_sec);
  const cand = db.prepare('SELECT * FROM performance_candidates WHERE id = ?').get(candidate_id);
  if (!cand) throw new Error(`candidate ${candidate_id} not found`);
  // The stored row keeps these two as JSON text; validateCandidate works on the parsed shape.
  const issues = V.validateCandidate({
    ...cand,
    arrangement_tags: JSON.parse(cand.arrangement_tags || '[]'),
    watch_cues: JSON.parse(cand.watch_cues || '[]'),
    segment_start_sec: start, segment_end_sec: end, segment_evidence: evidence ?? null,
  });
  V.assertValid(issues);
  return tx(db, () => {
    const row = db.prepare(`UPDATE performance_candidates SET segment_start_sec = ?, segment_end_sec = ?, segment_evidence = ?
                              WHERE id = ? RETURNING *`).get(start, end, str(evidence), candidate_id);
    return saved(row, issues, { rerunDates: markReelsForRerender(db, { candidateId: candidate_id }) });
  });
}

function setActive(db, kind, id, active) {
  const table = ACTIVATABLE[kind];
  if (!table) throw new Error(`cannot deactivate "${kind}"`);
  const row = db.prepare(`UPDATE ${table} SET is_active = ? WHERE id = ? RETURNING *`).get(active ? 1 : 0, id);
  if (!row) throw new Error(`${kind} ${id} not found`);
  return row;
}

/**
 * Keeps the operator's filename but strips anything that could step outside the folder.
 * A name that collides gets a numeric suffix rather than overwriting what is already there.
 */
function safeName(name, fallback = 'file') {
  const base = path.basename(String(name ?? '')).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '').trim();
  return base || fallback;
}

function uniquePath(dir, name) {
  const ext = path.extname(name);
  const stem = path.basename(name, ext);
  let candidate = path.join(dir, name);
  for (let i = 2; fs.existsSync(candidate); i++) candidate = path.join(dir, `${stem}-${i}${ext}`);
  return candidate;
}

/** Stores an uploaded clip and returns the project-relative path the database records. */
const VIDEO_EXT = new Set(['.mp4', '.mov', '.mkv', '.webm']);

/**
 * The video files the operator has already put in storage/video, newest first.
 *
 * The point is that a file sitting in that folder should not have to be uploaded into the same folder
 * through a browser to be usable. Read-only: it lists what is there and never fetches, moves or
 * records anything. `file_ref` is produced by the same toStoredPath() that storeClipFile() uses, so a
 * value from here can be sent straight to saveClipAsset.
 *
 * Only the folder itself is read — no recursion, no symlink following, nothing outside it.
 * Duration is deliberately absent: probing 30 files would make the list take seconds to appear.
 *
 * Each entry carries what its name can be read as (`suggested`), so picking a file fills the form in.
 * A name that does not parse gets an empty object: the download tool's naming is not a source.
 */
function listVideoFiles(cfg) {
  const dir = cfg.resolved.video;
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && VIDEO_EXT.has(path.extname(e.name).toLowerCase()))
    .map((e) => {
      const full = path.join(dir, e.name);
      const st = fs.statSync(full);
      return {
        file_ref: toStoredPath(cfg, full), name: e.name, bytes: st.size, mtime: st.mtime.toISOString(),
        suggested: suggestFromFilename(e.name),
      };
    })
    .sort((a, b) => (a.mtime < b.mtime ? 1 : a.mtime > b.mtime ? -1 : a.name.localeCompare(b.name)));
}

function storeClipFile(cfg, filename, buffer) {
  fs.mkdirSync(cfg.resolved.clips, { recursive: true });
  const target = uniquePath(cfg.resolved.clips, safeName(filename, 'clip.mp4'));
  fs.writeFileSync(target, buffer);
  return { file_ref: toStoredPath(cfg, target), bytes: buffer.length };
}

/**
 * Stores a permission document outside the database and returns only the pointer.
 * The document itself stays in storage/evidence, which .gitignore keeps out of the repository.
 */
function storeEvidenceFile(cfg, filename, buffer) {
  fs.mkdirSync(cfg.resolved.evidence, { recursive: true });
  const target = uniquePath(cfg.resolved.evidence, safeName(filename, 'evidence.pdf'));
  fs.writeFileSync(target, buffer);
  return { evidence_ref: `evidence://${path.basename(target)}`, bytes: buffer.length };
}

module.exports = {
  saveChannel, saveVideo, saveTrack, saveCandidate, saveClipAsset, savePermission, setActive, setCandidateSegment,
  storeClipFile, storeEvidenceFile, listVideoFiles, safeName, slug, uniqueKey,
};
