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
const T = require('../util/terms');

/** Notes about a real publish. Returned as pairs so the screen and the tests read the same list. */
function liveReadiness(cfg, { reel, clipAsset, scheduledAt, now }) {
  const notes = [];
  const add = (en, ko) => notes.push({ en, ko });
  if (Date.parse(scheduledAt) <= now) {
    add('Scheduled time is in the past — a live run would publish immediately or must be rescheduled',
      '예약 시각이 이미 지났습니다. 실제 발행이었다면 바로 올라가거나 시각을 다시 잡아야 합니다.');
  }
  if (reel.output_format === 'licensed_clip' && clipAsset) {
    const r = evaluateClip(clipAsset, { cfg, publishAtUtc: scheduledAt, mode: 'live' });
    if (!r.eligible) add(`Live rights check fails: ${r.reasons.join(' | ')}`, `실제 발행 기준 권리 점검에서 막힙니다: ${r.reasons_ko.join(' / ')}`);
  }
  add('Live Instagram publishing is not implemented in this MVP (Meta Graph API integration pending)',
    '실제 Instagram 게시 기능은 아직 만들지 않았습니다. 지금은 예행 연습까지만 됩니다.');
  return notes;
}

function scheduleDryRun(db, cfg, { reel, selection, clipAsset, scheduledAt, now = Date.now() }) {
  const platform = cfg.publish.platform;
  const checks = [];
  const add = (ok, label, label_ko) => checks.push({ ok, label, label_ko });

  const abs = reel.output_path ? fromStoredPath(cfg, reel.output_path) : null;
  const exists = abs && fs.existsSync(abs);
  add(Boolean(exists), exists ? `Video file present: ${reel.output_path}` : 'Video file missing',
    exists ? '완성된 영상 파일이 있습니다' : '완성된 영상 파일이 없습니다. 같은 날짜를 다시 실행하면 이어서 만듭니다.');
  let info = null;
  if (exists) {
    info = probe(cfg, abs);
    add(Boolean(info && info.width * 16 === info.height * 9),
      info ? `Video ${info.width}x${info.height}, ${info.duration.toFixed(1)}s, ${info.codec}/${info.audio ?? 'no audio'}` : 'ffprobe failed',
      info ? `세로 ${info.width}×${info.height}, ${info.duration.toFixed(1)}초, ${info.audio ? '소리 있음' : '무음'}` : '영상 정보를 읽지 못했습니다');
    if (info) {
      add(info.duration >= 3 && info.duration <= 90, `Duration ${info.duration.toFixed(1)}s within 3–90s`,
        `길이 ${info.duration.toFixed(1)}초 (릴스 허용 3~90초)`);
    }
  }
  add(reel.caption.length <= 2200, `Caption ${reel.caption.length}/2200 chars`, `캡션 길이 ${reel.caption.length}자 (최대 2200자)`);
  const tags = (reel.caption.match(/#\w+/g) ?? []).length;
  add(tags <= 30, `${tags} hashtags (max 30)`, `해시태그 ${tags}개 (최대 30개)`);
  add(/^https?:\/\//.test(reel.official_link), `Official link: ${reel.official_link}`, '공식 원본 링크가 캡션에 들어 있습니다');
  if (reel.output_format === 'licensed_clip' && clipAsset) {
    const r = evaluateClip(clipAsset, { cfg, publishAtUtc: scheduledAt, mode: 'dry_run' });
    add(r.eligible, r.eligible ? `Rights re-checked at ${scheduledAt}` : `Rights no longer valid: ${r.reasons.join(' | ')}`,
      r.eligible ? '발행 직전 기준으로 권리를 다시 확인했고 문제없습니다' : `권리가 더 이상 유효하지 않습니다: ${r.reasons_ko.join(' / ')}`);
  }

  const failed = checks.filter((c) => !c.ok);
  const live = liveReadiness(cfg, { reel, clipAsset, scheduledAt, now });
  const status = failed.length ? 'blocked' : 'simulated';
  const isPast = Date.parse(scheduledAt) <= now;
  const past = isPast ? ' (note: scheduled time already passed)' : '';
  const liveBlocked = live.some((n) => n.en.startsWith('Live rights check fails'));
  const expected = (failed.length
    ? `blocked: ${failed.map((f) => f.label).join(' | ')}`
    : liveBlocked
      ? 'dry-run OK; a live run would be BLOCKED (test asset/permission)'
      : 'dry-run OK; a live run would schedule this reel') + past;
  const expectedKo = (failed.length
    ? `막힘: ${failed.map((f) => f.label_ko).join(' / ')}`
    : liveBlocked
      ? '예행 연습은 통과했지만, 실제 발행이었다면 막혔을 것입니다 (테스트 소재·가상 권한).'
      : '예행 연습 통과 — 실제 발행이었다면 이 릴스를 예약했을 것입니다.') + (isPast ? ' 예약 시각은 이미 지났습니다.' : '');
  const plan = {
    platform, mode: 'dry_run', operating_date: selection.operating_date, scheduled_at_utc: scheduledAt,
    scheduled_local: `${selection.operating_date} ${cfg.publish.localTime} ${cfg.timezone}`,
    file: reel.output_path, file_bytes: info?.size ?? null, format: reel.output_format, title_en: reel.title_en,
    caption: reel.caption, checks, live_readiness: live,
  };

  return db.prepare(`
    INSERT INTO publish_jobs (reel_id, platform, mode, scheduled_at, status, expected_status, expected_status_ko, plan_json, last_error)
    VALUES (?, ?, 'dry_run', ?, ?, ?, ?, ?, ?)
    ON CONFLICT (reel_id, platform, mode) DO UPDATE SET scheduled_at = excluded.scheduled_at, status = excluded.status,
      expected_status = excluded.expected_status, expected_status_ko = excluded.expected_status_ko,
      plan_json = excluded.plan_json, last_error = excluded.last_error,
      updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
    RETURNING *`).get(reel.id, platform, scheduledAt, status, expected, expectedKo, JSON.stringify(plan), failed.length ? failed[0].label : null);
}

function scheduleLive() {
  throw new Error('Live publishing is not implemented in this MVP. Use mode=dry_run. (Requires Meta Graph API integration — see README.)');
}

module.exports = { scheduleDryRun, scheduleLive };
