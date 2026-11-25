'use strict';
/**
 * What the video itself says about where the performance came from.
 *
 * The burnt-in line used to read 「개인 테스트용」 on anything made by the fast path — which is what a
 * post the operator actually publishes went out saying. It is a curation account, so the line is a
 * source credit instead.
 *
 * That is a change to a caption, not to a rule. These tests exist to prove the distinction holds:
 * `personal_use_only` is still recorded, live publishing is still refused, the exported folder still
 * warns, and the screen still shows the badge.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeEnv } = require('./helpers');
const entry = require('../src/ingest/manualEntry');
const { sourceCredit } = require('../src/copy/templates');
const { evaluateClip } = require('../src/rights/evaluate');
const { loadClipAssets } = require('../src/selection/candidates');
const { scheduleLive } = require('../src/publish/dryRun');
const { runDay } = require('../src/pipeline');
const { exportReel } = require('../src/export/exportReel');

const DATE = '2026-11-25';
const PUBLISHED = '2026-11-20T09:00:00Z';

function buildChain(db, { channelName = 'Credit Line Official (TEST)', url = 'https://www.example.com/watch?v=CREDIT-0001' } = {}) {
  const channel = entry.saveChannel(db, { platform: 'youtube', external_id: 'UC-CREDIT', name: channelName, is_test: 1 }).row;
  const video = entry.saveVideo(db, {
    channel_id: channel.id, platform: 'youtube', platform_video_id: 'CREDIT-0001',
    official_url: url, title: 'NOVA – Paper Lantern (Live Band Version)', published_at: PUBLISHED,
  }).row;
  const track = entry.saveTrack(db, {
    track_key: 'TR_CREDIT', original_artist_en: 'NOVA', title_en: 'Paper Lantern', title_ko: '종이 등',
    name_evidence: 'TEST: official English title in the channel video title',
  }).row;
  return entry.saveCandidate(db, {
    candidate_key: 'P900-credit', source_video_id: video.id, track_id: track.id,
    performer_en: 'NOVA', performance_type: 'live', arrangement_tags: ['band'],
    version_evidence: 'TEST: "Live Band Version" stated in the official title',
  }).row;
}

function attachClip(db, cfg, candidateId, { personal = 1 } = {}) {
  const source = path.join(cfg.resolved.testAssets, 'sample_live_clip.mp4');
  const { file_ref } = entry.storeClipFile(cfg, 'my-own-file.mp4', fs.readFileSync(source));
  return entry.saveClipAsset(db, cfg, {
    asset_key: `A900-credit-${personal}`, candidate_id: candidateId, file_ref,
    source_start_sec: 130, source_end_sec: 150, file_offset_sec: 4, personal_use_only: personal,
  }).row;
}

/** The text files drawtext rendered from — what is actually burnt into the picture. */
function drawnText(cfg, reelId) {
  const workDir = path.join(cfg.resolved.output, 'reels', DATE, `reel-${reelId}`);
  return fs.readdirSync(workDir).filter((f) => /^t\d+\.txt$/.test(f))
    .map((f) => fs.readFileSync(path.join(workDir, f), 'utf8')).join('\n');
}

// ── 10: a clip with a source credits it ──────────────────────────────────────────────────────────
test('credit: a clip with a source channel is credited to it in the video', async (t) => {
  const { db, cfg, ffmpeg } = await makeEnv({}, { seed: false });
  if (!ffmpeg) return t.skip('FFmpeg not available');
  const candidate = buildChain(db, { channelName: 'NOVA Official' });
  attachClip(db, cfg, candidate.id, { personal: 1 });

  const r = await runDay(db, cfg, DATE);
  assert.equal(r.reel.render_status, 'done', `render failed: ${r.reel.render_error}`);

  const drawn = drawnText(cfg, r.reel.id);
  assert.match(drawn, /Source: NOVA Official/, 'the burnt-in line names where it came from');
  assert.doesNotMatch(drawn, /개인 테스트용|배포 불가|권리 미확인/, 'and no longer calls a real post a test');
  assert.doesNotMatch(drawn, /used with permission/i, 'nor claims a permission that was never asked for');
});

// ── 11: a clip with nothing to credit says nothing ───────────────────────────────────────────────
test('credit: with neither a channel nor a link there is no line at all', () => {
  assert.equal(sourceCredit({ channel_name: 'NOVA Official' }), 'Source: NOVA Official');
  assert.equal(sourceCredit({ channel_name: '  ', official_url: 'https://www.youtube.com/watch?v=04GSqsX0S50' }), 'Source: youtube.com',
    'with no channel name, the site it lives on');
  assert.equal(sourceCredit({ channel_name: null, official_url: '' }), null, 'nothing to credit — nothing is drawn');
  assert.equal(sourceCredit({}), null);
  assert.equal(sourceCredit({ official_url: 'not a url' }), null, 'and nothing is invented out of a broken one');
});

// ── 12: recorded rights are still named as rights ────────────────────────────────────────────────
test('credit: a clip with recorded permissions still says it was used with permission', async (t) => {
  const { db, cfg, ffmpeg } = await makeEnv({}, { seed: false });
  if (!ffmpeg) return t.skip('FFmpeg not available');
  const candidate = buildChain(db);
  const asset = attachClip(db, cfg, candidate.id, { personal: 0 });
  for (const category of ['footage', 'music', 'performance']) {
    entry.savePermission(db, {
      clip_asset_id: asset.id, rights_category: category, rights_holder: 'NOVA Entertainment',
      status: 'granted', allows_edit: 1, allows_repost: 1, platforms: ['instagram'], territories: ['WORLDWIDE'],
      valid_from: '2026-11-01T00:00:00Z', valid_until: '2027-10-31T23:59:59Z',
      permitted_start_sec: 120, permitted_end_sec: 300,
      evidence_ref: 'evidence://TEST-A900-permission', is_test_permission: 1,
    });
  }
  const r = await runDay(db, cfg, DATE);
  assert.equal(r.reel.render_status, 'done', `render failed: ${r.reel.render_error}`);
  assert.match(drawnText(cfg, r.reel.id), /Clip used with permission · NOVA Entertainment/, 'unchanged for a licensed clip');
});

// ── 13: the block is code, not a caption ─────────────────────────────────────────────────────────
test('credit: a personal-use clip is still refused on the live path, and still recorded as unchecked', async (t) => {
  const { db, cfg, ffmpeg } = await makeEnv({}, { seed: false });
  if (!ffmpeg) return t.skip('FFmpeg not available');
  const candidate = buildChain(db);
  const asset = attachClip(db, cfg, candidate.id, { personal: 1 });

  assert.equal(db.prepare('SELECT personal_use_only FROM clip_assets WHERE id = ?').get(asset.id).personal_use_only, 1,
    'the record that rights were not checked stays in the database');

  const loaded = loadClipAssets(db, candidate.id).find((a) => a.id === asset.id);
  const live = evaluateClip(loaded, { cfg, publishAtUtc: '2026-11-25T12:00:00Z', mode: 'live' });
  assert.equal(live.eligible, false, 'the live path never takes it');
  assert.match(live.reasons.join(' | '), /Personal-use clip — never valid for live publishing/);

  const dry = evaluateClip(loaded, { cfg, publishAtUtc: '2026-11-25T12:00:00Z', mode: 'dry_run' });
  assert.equal(dry.eligible, true, 'while the rehearsal still works');

  assert.throws(() => scheduleLive(), /not implemented|dry/i, 'and real publishing is not something this program does');

  const r = await runDay(db, cfg, DATE);
  assert.match(r.job.expected_status, /BLOCKED/, 'the rehearsal records that a real publish would have been stopped');
  assert.ok(!/used with permission/i.test(r.reel.caption), 'the caption claims no licence');
});

// ── 14: the warning the operator reads is untouched ──────────────────────────────────────────────
test('credit: the exported 읽어보기.txt still opens with the do-not-publish warning', async (t) => {
  const { db, cfg, ffmpeg, dir } = await makeEnv({}, { seed: false });
  if (!ffmpeg) return t.skip('FFmpeg not available');
  const candidate = buildChain(db);
  attachClip(db, cfg, candidate.id, { personal: 1 });

  const r = await runDay(db, cfg, DATE);
  const out = exportReel(db, cfg, { reelId: r.reel.id, dir: path.join(dir, 'export') });
  const readme = fs.readFileSync(path.join(out.dir, '읽어보기.txt'), 'utf8');
  assert.equal(readme.split('\n')[0], '⚠ 이 영상은 권리를 확인하지 않은 개인 확인용입니다. 공개 게시하지 마세요.',
    'the exported note still warns first, word for word');

  // and the screen still has a badge for it
  const screen = ['app.js', 'manage.js'].map((f) => fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'public', f), 'utf8')).join('\n');
  assert.match(screen, /권리 미확인 · 개인 확인용/, 'the operator still sees the state on screen');
});
