'use strict';
/**
 * Personal test mode — the operator's own file, cut only to see how a template looks.
 *
 * The point of these tests is that the relaxation is one-directional: rights are not asked for, and in
 * exchange the clip can never reach the live path and never claims a permission it does not have.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeEnv } = require('./helpers');
const entry = require('../src/ingest/manualEntry');
const { evaluateClip } = require('../src/rights/evaluate');
const { loadClipAssets } = require('../src/selection/candidates');
const { previewCandidate } = require('../src/selection/selectDaily');
const { runDay } = require('../src/pipeline');
const { exportReel } = require('../src/export/exportReel');

const DATE = '2026-11-25';
const PUBLISHED = '2026-11-20T09:00:00Z';

/** channel → video → track → candidate, exactly as the five registration steps build them. */
function buildChain(db) {
  const channel = entry.saveChannel(db, { platform: 'youtube', external_id: 'UC-PERSONAL', name: 'Personal Mode Official (TEST)', is_test: 1 }).row;
  const video = entry.saveVideo(db, {
    channel_id: channel.id, platform: 'youtube', platform_video_id: 'PERSONAL-0001',
    official_url: 'https://www.example.com/watch?v=PERSONAL-0001', title: 'NOVA – Paper Lantern (Live Band Version)',
    published_at: PUBLISHED,
  }).row;
  const track = entry.saveTrack(db, {
    track_key: 'TR_PAPER_LANTERN', original_artist_en: 'NOVA', title_en: 'Paper Lantern', title_ko: '종이 등',
    name_evidence: 'TEST: official English title in the channel video title',
  }).row;
  const candidate = entry.saveCandidate(db, {
    candidate_key: 'P300-nova-paperlantern-band', source_video_id: video.id, track_id: track.id,
    performer_en: 'NOVA', performer_ko: '노바', program_name: 'Personal Mode Sessions (TEST)',
    performance_type: 'live', arrangement_tags: ['band'],
    version_evidence: 'TEST: "Live Band Version" stated in the official title',
  }).row;
  return { channel, video, track, candidate };
}

/** Registers the self-made test clip as personal-use-only, with NO permissions at all. */
function attachPersonalClip(db, cfg, candidateId, { start = 130, end = 150 } = {}) {
  const source = path.join(cfg.resolved.testAssets, 'sample_live_clip.mp4');
  const { file_ref } = entry.storeClipFile(cfg, 'my-own-file.mp4', fs.readFileSync(source));
  return entry.saveClipAsset(db, cfg, {
    asset_key: `A300-personal-${start}-${end}`, candidate_id: candidateId, file_ref,
    source_start_sec: start, source_end_sec: end, file_offset_sec: 4, personal_use_only: 1,
  }).row;
}

const evaluate = (db, cfg, candidateId, assetId, mode) => {
  const asset = loadClipAssets(db, candidateId).find((a) => a.id === assetId);
  return evaluateClip(asset, { cfg, publishAtUtc: '2026-11-25T12:00:00Z', mode });
};

// ── 1 + 3: it renders without a single permission, and the caption claims nothing ────────────────
test('personal: a clip with no permissions at all is rendered in a dry run, and the caption claims no licence', async (t) => {
  const { db, cfg, ffmpeg, dir } = await makeEnv({}, { seed: false });
  if (!ffmpeg) return t.skip('FFmpeg not available');
  const { candidate } = buildChain(db);
  attachPersonalClip(db, cfg, candidate.id);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM usage_permissions').get().n, 0, 'no rights were entered');

  const p = previewCandidate(db, cfg, candidate.id, DATE);
  assert.equal(p.format, 'licensed_clip', 'a personal-use clip skips the rights check and still becomes a clip reel');
  assert.equal(p.clip.assets[0].personalUseOnly, true, 'the screen is told this is a personal-use clip');
  assert.equal(p.clip.assets[0].testOnly, true, 'and that it must not be published');
  assert.match(p.format_reason_ko, /개인 확인용/, 'the operator is told why in Korean');

  const r = await runDay(db, cfg, DATE);
  assert.equal(r.selection.status, 'selected');
  assert.equal(r.reel.output_format, 'licensed_clip');
  assert.equal(r.reel.render_status, 'done', `render failed: ${r.reel.render_error}`);

  // 3. the caption must not claim a permission that was never asked for
  assert.ok(!/used with permission/i.test(r.reel.caption), `caption claims a licence: ${r.reel.caption}`);
  assert.match(r.reel.caption, /Personal test render — not licensed for distribution\./);

  // the warning is burned into the video too — checked on the text files drawtext rendered from
  const workDir = path.join(cfg.resolved.output, 'reels', DATE, `reel-${r.reel.id}`);
  const drawn = fs.readdirSync(workDir).filter((f) => /^t\d+\.txt$/.test(f))
    .map((f) => fs.readFileSync(path.join(workDir, f), 'utf8')).join('\n');
  assert.match(drawn, /개인 테스트용 · 권리 미확인 · 배포 불가/, 'the credit line in the video says it is unlicensed');

  // 7. and the exported folder warns before anything else is read
  const out = exportReel(db, cfg, { reelId: r.reel.id, dir: path.join(dir, 'export') });
  const readme = fs.readFileSync(path.join(out.dir, '읽어보기.txt'), 'utf8');
  assert.match(readme.split('\n')[0], /^⚠ 이 영상은 권리를 확인하지 않은 개인 확인용입니다\. 공개 게시하지 마세요\.$/);
});

// ── 2: the live path refuses it, always ──────────────────────────────────────────────────────────
test('personal: the same clip is refused on the live path', async (t) => {
  const { db, cfg, ffmpeg } = await makeEnv({}, { seed: false });
  if (!ffmpeg) return t.skip('FFmpeg not available');
  const { candidate } = buildChain(db);
  const asset = attachPersonalClip(db, cfg, candidate.id);

  const dry = evaluate(db, cfg, candidate.id, asset.id, 'dry_run');
  assert.equal(dry.eligible, true, 'the dry run lets it through');

  const live = evaluate(db, cfg, candidate.id, asset.id, 'live');
  assert.equal(live.eligible, false, 'the live path never does');
  assert.match(live.reasons.join(' | '), /Personal-use clip — never valid for live publishing/);
  assert.match(live.reasons_ko.join(' / '), /개인 확인용 클립입니다/);

  // and the dry run records that a real publish would have been blocked
  const r = await runDay(db, cfg, DATE);
  assert.match(r.job.expected_status, /BLOCKED/);
  const plan = JSON.parse(r.job.plan_json);
  assert.ok(plan.live_readiness.some((n) => /Personal-use clip/.test(n.en)), 'the live-readiness note names the reason');
});

// ── 4: the relaxation does not extend to the things that break rendering ─────────────────────────
test('personal: a segment longer than the reel limit is refused even for a personal-use clip', async (t) => {
  const { db, cfg, ffmpeg } = await makeEnv({}, { seed: false });
  if (!ffmpeg) return t.skip('FFmpeg not available');
  const { candidate } = buildChain(db);
  const long = attachPersonalClip(db, cfg, candidate.id, { start: 100, end: 100 + cfg.render.maxClipDurationSec + 5 });

  const r = evaluate(db, cfg, candidate.id, long.id, 'dry_run');
  assert.equal(r.eligible, false, 'length is a rendering limit, not a rights question');
  assert.match(r.reasons.join(' | '), /longer than the \d+s reel limit/);

  const p = previewCandidate(db, cfg, candidate.id, DATE);
  assert.equal(p.format, 'original_graphic', 'so the day falls back to the graphic format');
});
