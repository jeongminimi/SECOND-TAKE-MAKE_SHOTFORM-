'use strict';
/**
 * Where the line between a judgement and a fact is drawn.
 *
 * "This stage is unreal" is the operator's view: it has no source and needs none, and this account
 * exists to carry it. "Originally by Lady Gaga" is a fact about someone else's work: get it wrong and
 * the account is not worth reading. These tests pin that line, because it is the one thing in the
 * project that must not drift as the input rules get easier to use.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeEnv } = require('./helpers');
const entry = require('../src/ingest/manualEntry');
const { buildCopy } = require('../src/copy/templates');
const { loadCandidate } = require('../src/selection/candidates');
const { parseTimecode } = require('../src/util/time');
const { runDay } = require('../src/pipeline');
const { loadConfig } = require('../src/config');

const PUBLISHED = '2026-11-20T09:00:00Z';

function buildChain(db, over = {}) {
  const channel = entry.saveChannel(db, { platform: 'youtube', external_id: 'UC-RULES', name: 'Rules Test Official (TEST)', is_test: 1 }).row;
  const video = entry.saveVideo(db, {
    channel_id: channel.id, platform: 'youtube', platform_video_id: 'RULES-0001',
    official_url: 'https://www.example.com/watch?v=RULES-0001', title: 'NOVA – Paper Lantern (Live Band Version)',
    published_at: PUBLISHED,
  }).row;
  const track = entry.saveTrack(db, {
    track_key: 'TR_PAPER_LANTERN', original_artist_en: 'NOVA', title_en: 'Paper Lantern',
    name_evidence: 'TEST: official English title in the channel video title',
  }).row;
  const candidate = entry.saveCandidate(db, {
    candidate_key: 'P500-rules', source_video_id: video.id, track_id: track.id,
    performer_en: 'NOVA', program_name: 'Rules Test Sessions (TEST)',
    performance_type: 'live', arrangement_tags: ['band'],
    version_evidence: 'TEST: "Live Band Version" stated in the official title',
    ...over,
  }).row;
  return { channel, video, track, candidate };
}

// ── a judgement needs no source ──────────────────────────────────────────────────────────────────
test('rules: "why watch" saves with no source, and the line the operator wrote reaches the caption', async () => {
  const { db, cfg } = await makeEnv({}, { seed: false });
  const line = 'Two voices so locked in, you stop hearing the original.';
  const { candidate } = buildChain(db, { why_watch_en: line });   // no why_watch_evidence at all

  assert.ok(candidate.id, 'an impression without a source is stored');
  assert.equal(candidate.why_watch_evidence, null);

  const c = loadCandidate(db, candidate.id);
  const copy = buildCopy(c, { format: 'original_graphic', account: cfg.account });
  assert.match(copy.caption, /Why watch: Two voices so locked in, you stop hearing the original\./,
    'the operator\'s own line is what goes out — not a generated fallback');
  assert.equal(copy.why_line.source, 'operator', 'and it is recorded as a judgement, not as sourced fact');
});

test('rules: a sourced "why watch" line is still marked as sourced', async () => {
  const { db, cfg } = await makeEnv({}, { seed: false });
  const { candidate } = buildChain(db, { why_watch_en: 'The arrangement drops the drums for the last chorus.', why_watch_evidence: 'TEST: stated in the official description' });
  const copy = buildCopy(loadCandidate(db, candidate.id), { format: 'original_graphic', account: cfg.account });
  assert.equal(copy.why_line.source, 'evidence');
});

// ── a fact still does ────────────────────────────────────────────────────────────────────────────
test('rules: facts still require a source — names, cover-or-live, and the timestamp', async () => {
  const { db } = await makeEnv({}, { seed: false });
  const { video, track } = buildChain(db);

  // version_evidence: claiming an arrangement difference
  assert.throws(() => entry.saveCandidate(db, {
    candidate_key: 'P501-noversion', source_video_id: video.id, track_id: track.id,
    performer_en: 'NOVA', performance_type: 'live', arrangement_tags: ['acoustic'],
  }), /version_evidence/, 'an arrangement claim without a source is refused');

  // segment_evidence: putting "▶ 1:23" in the caption
  assert.throws(() => entry.saveCandidate(db, {
    candidate_key: 'P502-noseg', source_video_id: video.id, track_id: track.id,
    performer_en: 'NOVA', performance_type: 'live', segment_start_sec: '1:23', segment_end_sec: '1:48',
  }), /segment_evidence/, 'a timestamp without a source is refused');

  // name_evidence: official English names are a claim about the artist
  const t = entry.saveTrack(db, { track_key: 'TR_NO_EVID', title_en: 'Some Title', original_artist_en: 'SOMEONE' });
  assert.ok(t.warnings.some((w) => w.code === 'name_evidence_missing'),
    'official names without a source are flagged, and the candidate is excluded from selection for it');
});

// ── timecodes ────────────────────────────────────────────────────────────────────────────────────
test('rules: a position can be typed as 1:23 or as seconds, and nonsense is refused', async () => {
  const { db, cfg } = await makeEnv({}, { seed: false });
  assert.equal(parseTimecode('1:23'), 83);
  assert.equal(parseTimecode('83'), 83);
  assert.equal(parseTimecode('1:02:03'), 3723);
  assert.equal(parseTimecode(''), null);
  assert.ok(Number.isNaN(parseTimecode('1:99')));

  const { candidate } = buildChain(db);
  const { file_ref } = entry.storeClipFile(cfg, 'range.mp4', Buffer.from('a real file, not a URL'));

  const typed = entry.saveClipAsset(db, cfg, {
    asset_key: 'A500-mmss', candidate_id: candidate.id, file_ref, source_start_sec: '1:23', source_end_sec: '1:48',
  }).row;
  assert.equal(typed.source_start_sec, 83, '1:23 is stored as 83 seconds');
  assert.equal(typed.source_end_sec, 108);

  assert.throws(() => entry.saveClipAsset(db, cfg, {
    asset_key: 'A501-bad', candidate_id: candidate.id, file_ref, source_start_sec: 'about a minute in', source_end_sec: '1:48',
  }), /not a time/, 'an unreadable time is refused instead of being stored as 0');
});

test('rules: step 5 records the moment and its source on the candidate, so the caption may show it', async () => {
  const { db, cfg } = await makeEnv({}, { seed: false });
  const { candidate } = buildChain(db);

  const r = entry.setCandidateSegment(db, {
    candidate_id: candidate.id, start_sec: '1:23', end_sec: '1:48',
    evidence: '유튜브 "가장 많이 본 구간" 그래프 기준',
  });
  assert.equal(r.row.segment_start_sec, 83);
  assert.match(r.row.segment_evidence, /가장 많이 본 구간/);

  const copy = buildCopy(loadCandidate(db, candidate.id), { format: 'original_graphic', account: loadConfig().account });
  assert.match(copy.caption, /▶ The song starts at 1:23 in the official video\./, 'the caption can now name the moment');
  assert.match(copy.official_link, /[?&]t=83s/, 'and the link points at it');

  // the source is required here too — a moment with no source is refused
  assert.throws(() => entry.setCandidateSegment(db, { candidate_id: candidate.id, start_sec: '2:00', evidence: null }), /segment_evidence/);
});

// ── changing a range re-renders without re-selecting ─────────────────────────────────────────────
test('rules: changing the clip range re-renders the same reel and leaves the selection record alone', async (t) => {
  const { db, cfg, ffmpeg } = await makeEnv();
  if (!ffmpeg) return t.skip('FFmpeg not available');
  const date = '2026-11-23';
  const first = await runDay(db, cfg, date);
  assert.equal(first.reel.render_status, 'done');
  const before = { reelId: first.reel.id, revision: first.selection.revision, score: first.selection.score, reason: first.selection.reason };

  const asset = db.prepare('SELECT * FROM clip_assets WHERE id = ?').get(first.reel.clip_asset_id);
  const saved = entry.saveClipAsset(db, cfg, {
    id: asset.id, asset_key: asset.asset_key, candidate_id: asset.candidate_id, file_ref: asset.file_ref,
    source_start_sec: asset.source_start_sec + 2, source_end_sec: asset.source_end_sec,
    file_offset_sec: asset.file_offset_sec + 2, is_test_asset: asset.is_test_asset,
  });
  assert.deepEqual(saved.rerunDates, [date], 'the day that used this clip is reported as needing a re-render');
  assert.equal(db.prepare('SELECT render_status FROM reels WHERE id = ?').get(before.reelId).render_status, 'pending');

  const after = await runDay(db, cfg, date);   // no reselect
  assert.equal(after.reel.id, before.reelId, 'the same reel row is rebuilt');
  assert.equal(after.reel.render_status, 'done');
  assert.equal(after.selection.revision, before.revision, 'the selection is not revised');
  assert.equal(after.selection.score, before.score);
  assert.equal(after.selection.reason, before.reason, 'and the record of why that day was picked is untouched');
});

// ── the official source link is stated, not just ticked ──────────────────────────────────────────
test('rules: the dry-run check names the official source address', async (t) => {
  const { db, cfg, ffmpeg } = await makeEnv();
  if (!ffmpeg) return t.skip('FFmpeg not available');
  const r = await runDay(db, cfg, '2026-11-23');
  const plan = JSON.parse(r.job.plan_json);
  const check = plan.checks.find((c) => /공식 출처 링크 있음/.test(c.label_ko ?? ''));
  assert.ok(check, `no official-source check found: ${plan.checks.map((c) => c.label_ko).join(' / ')}`);
  assert.ok(check.ok);
  assert.ok(check.label_ko.includes(r.reel.official_link), 'the address itself is shown, not only a tick');
});

// ── loudness analyzer ────────────────────────────────────────────────────────────────────────────
test('loudness: FFmpeg-only analysis suggests a segment and never calls it a chorus', async (t) => {
  const { db, cfg, ffmpeg } = await makeEnv({}, { seed: false });
  if (!ffmpeg) return t.skip('FFmpeg not available');
  const { analyzeLoudness } = require('../src/analysis/loudness');
  const { analyzeAssets } = require('../src/analysis/structure');
  const T = require('../src/util/terms');

  const source = path.join(cfg.resolved.testAssets, 'sample_live_clip.mp4');
  const got = analyzeLoudness(cfg, source);
  assert.ok(got.analysis, `no analysis: ${got.reason}`);
  assert.equal(got.analysis.segments[0].label, 'peak', 'the label states what was measured: loudness');
  assert.deepEqual(got.analysis.downbeats, [], 'loudness says nothing about bar lines');
  assert.equal(got.analysis.measured.rmsDbPerSec.length, got.analysis.duration, 'one reading per second');
  assert.ok(T.ko('section', 'peak').includes('가능성'), 'the screen wording is a maybe, not a claim');
  assert.ok(!T.ko('section', 'peak').startsWith('후렴'), 'and it is never presented as the chorus');

  // through the whole path: a personal-use clip has no permitted range, so the whole file is searched
  const { candidate } = buildChain(db);
  const { file_ref } = entry.storeClipFile(cfg, 'mine.mp4', fs.readFileSync(source));
  entry.saveClipAsset(db, cfg, {
    asset_key: 'A502-loud', candidate_id: candidate.id, file_ref,
    source_start_sec: 0, source_end_sec: 25, file_offset_sec: 0, personal_use_only: 1,
  });
  const [res] = analyzeAssets(db, cfg, { assetKey: 'A502-loud' });
  assert.equal(res.analyzer, 'loudness', res.reason);
  assert.equal(res.suggestion.label, 'peak');
  assert.equal(res.suggestion.status, 'proposed', 'a suggestion changes nothing until it is approved');
  assert.ok(!/downbeat/.test(res.suggestion.notes), `the note must not claim a downbeat cut: ${res.suggestion.notes}`);
  assert.match(res.suggestion.notes, /personal-use clip/);

  // and approving it still does not make the clip publishable
  const { evaluateClip } = require('../src/rights/evaluate');
  const { loadClipAssets } = require('../src/selection/candidates');
  const live = evaluateClip(loadClipAssets(db, candidate.id).find((a) => a.asset_key === 'A502-loud'),
    { cfg, publishAtUtc: '2026-11-25T12:00:00Z', mode: 'live' });
  assert.equal(live.eligible, false, 'a loudness suggestion never opens the live path');
});
