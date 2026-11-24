'use strict';
/**
 * runDay: test candidates → automatic selection → rights check → English copy → 9:16 render → dry-run schedule.
 * Re-running the same date is idempotent:
 *   selection  — reused (unless reselect)
 *   reel       — reused; a failed/pending render is resumed on the SAME reel row
 *   publish job — upserted on (reel, platform, mode)
 */
const fs = require('node:fs');
const { selectDaily, selectionPlan } = require('./selection/selectDaily');
const { loadCandidate, loadClipAssets } = require('./selection/candidates');
const { buildCopy } = require('./copy/templates');
const { renderReel } = require('./render/renderReel');
const { pickTemplate } = require('./render/templateEngine');
const { scheduleDryRun, scheduleLive } = require('./publish/dryRun');
const log = require('./util/log');
const { fromStoredPath } = require('./config');

function getReel(db, selectionId) {
  return db.prepare('SELECT * FROM reels WHERE selection_id = ?').get(selectionId);
}

function clipAssetWithPermissions(db, candidateId, clipAssetId) {
  if (!clipAssetId) return null;
  return loadClipAssets(db, candidateId).find((a) => a.id === clipAssetId) ?? null;
}

function ensureReel(db, cfg, selection) {
  const existing = getReel(db, selection.id);
  if (existing) return { reel: existing, created: false };
  const plan = selectionPlan(selection);
  const cand = loadCandidate(db, selection.candidate_id);
  const clip = plan.format === 'licensed_clip' ? clipAssetWithPermissions(db, cand.id, plan.clip_asset_id) : null;
  const copy = buildCopy(cand, { format: plan.format, clipAsset: clip, account: cfg.account });
  const reel = db.prepare(`
    INSERT INTO reels (selection_id, clip_asset_id, output_format, template_id, format_reason, format_reason_ko, title_en, caption, official_link, guide_page_path, render_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending') RETURNING *`)
    .get(selection.id, clip ? clip.id : null, plan.format, pickTemplate(cfg, plan.format, selection.operating_date),
      plan.format_reason, plan.format_reason_ko ?? null, copy.title_en, copy.caption, copy.official_link, null);
  db.prepare('UPDATE reels SET guide_page_path = ? WHERE id = ?').run(`/guide/${reel.id}`, reel.id);
  return { reel: getReel(db, selection.id), created: true };
}

async function renderIfNeeded(db, cfg, selection, reel) {
  const fileOk = reel.output_path && fs.existsSync(fromStoredPath(cfg, reel.output_path));
  if (reel.render_status === 'done' && fileOk) return { reel, rendered: false };
  const cand = loadCandidate(db, selection.candidate_id);
  const clip = clipAssetWithPermissions(db, cand.id, reel.clip_asset_id);
  const copy = buildCopy(cand, { format: reel.output_format, clipAsset: clip, account: cfg.account });
  db.prepare(`UPDATE reels SET render_status = 'rendering', render_attempts = render_attempts + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`).run(reel.id);
  try {
    const out = await renderReel({ cfg, reel, copy, clipAsset: clip, operatingDate: selection.operating_date });
    // caption is rebuilt too: an approved segment change or new cues must reach the copy as well as the video
    db.prepare(`UPDATE reels SET render_status = 'done', render_error = NULL, output_path = ?, poster_path = ?, template_id = ?, caption = ?, title_en = ?, official_link = ?,
                  updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`)
      .run(out.outputPath, out.posterPath, out.templateId, copy.caption, copy.title_en, copy.official_link, reel.id);
  } catch (e) {
    db.prepare(`UPDATE reels SET render_status = 'failed', render_error = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`).run(String(e.message).slice(0, 2000), reel.id);
    log.warn(`render failed for reel ${reel.id}: ${e.message}`);
  }
  return { reel: db.prepare('SELECT * FROM reels WHERE id = ?').get(reel.id), rendered: true };
}

async function runDay(db, cfg, operatingDate, { reselect = false, mode = cfg.publish.defaultMode ?? 'dry_run', now } = {}) {
  if (mode === 'live') scheduleLive();
  const sel = selectDaily(db, cfg, operatingDate, { reselect, mode });
  const selection = sel.selection;
  const result = { operatingDate, selection, selectionReused: sel.reused, reel: null, reelCreated: false, rendered: false, job: null };
  if (selection.status === 'skipped') {
    log.info(`${operatingDate}: skipped — ${selection.skip_reason}`);
    return result;
  }
  const { reel, created } = ensureReel(db, cfg, selection);
  result.reelCreated = created;
  const r = await renderIfNeeded(db, cfg, selection, reel);
  result.reel = r.reel;
  result.rendered = r.rendered;
  if (r.reel.render_status !== 'done') {
    log.warn(`${operatingDate}: render ${r.reel.render_status} — publish job not scheduled. Re-run the same date to resume.`);
    return result;
  }
  const plan = selectionPlan(selection);
  const clip = clipAssetWithPermissions(db, selection.candidate_id, r.reel.clip_asset_id);
  result.job = scheduleDryRun(db, cfg, { reel: r.reel, selection, clipAsset: clip, scheduledAt: plan.publish_at_utc, now: now ?? Date.now() });
  log.info(`${operatingDate}: ${r.reel.output_format} "${r.reel.title_en}" → ${r.reel.output_path} · job ${result.job.status}`);
  return result;
}

module.exports = { runDay, ensureReel, renderIfNeeded };
