'use strict';
/**
 * Publish scheduling. This MVP implements only `dry_run`: it checks the file, caption and schedule that a live
 * run would use and records what it WOULD do. It never invents external container/media ids or metrics.
 *
 * Live publishing (Instagram Graph API) is a follow-up integration — see README "남은 연동".
 * Idempotency contract for the future live publisher:
 *   - one job per (reel, platform, mode) — enforced by a UNIQUE constraint;
 *   - before retrying, look up external_container_id / external_media_id to learn the real state;
 *   - if the outcome cannot be determined, set status = 'pending_confirmation' and do NOT retry automatically.
 */
const fs = require('node:fs');
const { fromStoredPath } = require('../config');
const { probe } = require('../render/ffmpeg');
const { evaluateClip } = require('../rights/evaluate');

function liveReadiness(cfg, { reel, clipAsset, scheduledAt, now }) {
  const notes = [];
  if (Date.parse(scheduledAt) <= now) notes.push('Scheduled time is in the past — a live run would publish immediately or must be rescheduled');
  if (reel.output_format === 'licensed_clip' && clipAsset) {
    const r = evaluateClip(clipAsset, { cfg, publishAtUtc: scheduledAt, mode: 'live' });
    if (!r.eligible) notes.push(`Live rights check fails: ${r.reasons.join(' | ')}`);
  }
  notes.push('Live Instagram publishing is not implemented in this MVP (Meta Graph API integration pending)');
  return notes;
}

function scheduleDryRun(db, cfg, { reel, selection, clipAsset, scheduledAt, now = Date.now() }) {
  const platform = cfg.publish.platform;
  const checks = [];
  const add = (ok, label) => checks.push({ ok, label });

  const abs = reel.output_path ? fromStoredPath(cfg, reel.output_path) : null;
  const exists = abs && fs.existsSync(abs);
  add(Boolean(exists), exists ? `Video file present: ${reel.output_path}` : 'Video file missing');
  let info = null;
  if (exists) {
    info = probe(cfg, abs);
    add(Boolean(info && info.width * 16 === info.height * 9), info ? `Video ${info.width}x${info.height}, ${info.duration.toFixed(1)}s, ${info.codec}/${info.audio ?? 'no audio'}` : 'ffprobe failed');
    if (info) add(info.duration >= 3 && info.duration <= 90, `Duration ${info.duration.toFixed(1)}s within 3–90s`);
  }
  add(reel.caption.length <= 2200, `Caption ${reel.caption.length}/2200 chars`);
  const tags = (reel.caption.match(/#\w+/g) ?? []).length;
  add(tags <= 30, `${tags} hashtags (max 30)`);
  add(/^https?:\/\//.test(reel.official_link), `Official link: ${reel.official_link}`);
  if (reel.output_format === 'licensed_clip' && clipAsset) {
    const r = evaluateClip(clipAsset, { cfg, publishAtUtc: scheduledAt, mode: 'dry_run' });
    add(r.eligible, r.eligible ? `Rights re-checked at ${scheduledAt}` : `Rights no longer valid: ${r.reasons.join(' | ')}`);
  }

  const failed = checks.filter((c) => !c.ok);
  const live = liveReadiness(cfg, { reel, clipAsset, scheduledAt, now });
  const status = failed.length ? 'blocked' : 'simulated';
  const past = Date.parse(scheduledAt) <= now ? ' (note: scheduled time already passed)' : '';
  const expected = (failed.length
    ? `blocked: ${failed.map((f) => f.label).join(' | ')}`
    : live.some((n) => n.startsWith('Live rights check fails'))
      ? 'dry-run OK; a live run would be BLOCKED (test asset/permission)'
      : 'dry-run OK; a live run would schedule this reel') + past;
  const plan = {
    platform, mode: 'dry_run', operating_date: selection.operating_date, scheduled_at_utc: scheduledAt,
    scheduled_local: `${selection.operating_date} ${cfg.publish.localTime} ${cfg.timezone}`,
    file: reel.output_path, file_bytes: info?.size ?? null, format: reel.output_format, title_en: reel.title_en,
    caption: reel.caption, checks, live_readiness: live,
  };

  return db.prepare(`
    INSERT INTO publish_jobs (reel_id, platform, mode, scheduled_at, status, expected_status, plan_json, last_error)
    VALUES (?, ?, 'dry_run', ?, ?, ?, ?, ?)
    ON CONFLICT (reel_id, platform, mode) DO UPDATE SET scheduled_at = excluded.scheduled_at, status = excluded.status,
      expected_status = excluded.expected_status, plan_json = excluded.plan_json, last_error = excluded.last_error,
      updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
    RETURNING *`).get(reel.id, platform, scheduledAt, status, expected, JSON.stringify(plan), failed.length ? failed[0].label : null);
}

function scheduleLive() {
  throw new Error('Live publishing is not implemented in this MVP. Use mode=dry_run. (Requires Meta Graph API integration — see README.)');
}

module.exports = { scheduleDryRun, scheduleLive };
