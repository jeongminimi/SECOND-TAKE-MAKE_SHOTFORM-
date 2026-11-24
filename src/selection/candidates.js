'use strict';
const { json } = require('../db');

const CANDIDATE_SQL = `
  SELECT pc.*,
         sv.platform, sv.platform_video_id, sv.official_url, sv.title AS video_title, sv.description AS video_description,
         sv.published_at, sv.is_active AS video_active,
         sc.id AS channel_id, sc.name AS channel_name, sc.is_active AS channel_active, sc.is_test AS channel_is_test,
         t.track_key, t.original_artist_en, t.original_artist_ko, t.title_en, t.title_ko, t.name_evidence
    FROM performance_candidates pc
    JOIN source_videos sv   ON sv.id = pc.source_video_id
    JOIN source_channels sc ON sc.id = sv.channel_id
    LEFT JOIN tracks t      ON t.id = pc.track_id`;

function hydrate(row) {
  if (!row) return row;
  return { ...row, arrangement_tags: json.parse(row.arrangement_tags, []), watch_cues: json.parse(row.watch_cues, []) };
}

function loadCandidates(db) {
  return db.prepare(`${CANDIDATE_SQL} ORDER BY pc.candidate_key`).all().map(hydrate);
}

function loadCandidate(db, id) {
  return hydrate(db.prepare(`${CANDIDATE_SQL} WHERE pc.id = ?`).get(id));
}

function loadClipAssets(db, candidateId) {
  const assets = db.prepare('SELECT * FROM clip_assets WHERE candidate_id = ? ORDER BY id').all(candidateId);
  const permStmt = db.prepare('SELECT * FROM usage_permissions WHERE clip_asset_id = ? ORDER BY rights_category');
  return assets.map((a) => ({
    ...a,
    permissions: permStmt.all(a.id).map((p) => ({ ...p, platforms: json.parse(p.platforms, []), territories: json.parse(p.territories, []) })),
  }));
}

/** Candidate ids that were actually published (live mode). Dry runs never count. */
function livePublishedCandidateIds(db) {
  return new Set(db.prepare(`
    SELECT DISTINCT ds.candidate_id AS id
      FROM publish_jobs pj
      JOIN reels r ON r.id = pj.reel_id
      JOIN daily_selections ds ON ds.id = r.selection_id
     WHERE pj.mode = 'live' AND pj.status = 'published'`).all().map((r) => r.id));
}

/** Previously confirmed selections (status=selected) in [fromDate, toDate], with performer. */
function confirmedSelectionsBetween(db, fromDate, toDate) {
  return db.prepare(`
    SELECT ds.operating_date, pc.performer_en, pc.candidate_key
      FROM daily_selections ds JOIN performance_candidates pc ON pc.id = ds.candidate_id
     WHERE ds.status = 'selected' AND ds.operating_date BETWEEN ? AND ?`).all(fromDate, toDate);
}

module.exports = { loadCandidates, loadCandidate, loadClipAssets, livePublishedCandidateIds, confirmedSelectionsBetween };
