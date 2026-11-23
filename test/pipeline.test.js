'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { makeEnv, count, SEED, NOW } = require('./helpers');
const { importFile } = require('../src/ingest/importJson');
const { runDay } = require('../src/pipeline');
const { selectDaily, evaluateDate } = require('../src/selection/selectDaily');
const { loadClipAssets, loadCandidates } = require('../src/selection/candidates');
const { evaluateClip } = require('../src/rights/evaluate');
const { buildCopy } = require('../src/copy/templates');
const { probe } = require('../src/render/ffmpeg');
const { zonedToUtcIso } = require('../src/util/time');
const { fromStoredPath } = require('../src/config');

const byKey = (db, key) => loadCandidates(db).find((c) => c.candidate_key === key);
const assetByKey = (db, key) => db.prepare('SELECT id, candidate_id FROM clip_assets WHERE asset_key = ?').get(key);
const fullAsset = (db, key) => { const a = assetByKey(db, key); return loadClipAssets(db, a.candidate_id).find((x) => x.id === a.id); };

// ── 1. same song: live and cover are different candidates ─────────────────────────────
test('1. live and cover of the same song are stored as separate candidates', async () => {
  const { db } = await makeEnv();
  const rows = db.prepare(`SELECT pc.candidate_key, pc.performance_type, pc.performer_en, t.title_en, t.original_artist_en
                             FROM performance_candidates pc JOIN tracks t ON t.id = pc.track_id WHERE t.track_key = 'TR_STARLIGHT'`).all();
  const types = rows.map((r) => r.performance_type).sort();
  assert.ok(rows.length >= 2);
  assert.ok(types.includes('live') && types.includes('cover'));
  const cover = rows.find((r) => r.performance_type === 'cover');
  assert.equal(cover.performer_en, 'Haneul');          // actual performer
  assert.equal(cover.original_artist_en, 'LUMINA');    // original artist kept separately
  // one official video can hold several songs
  const multi = db.prepare(`SELECT COUNT(*) n FROM performance_candidates pc JOIN source_videos sv ON sv.id = pc.source_video_id WHERE sv.platform_video_id = 'TEST-SLS-0003'`).get().n;
  assert.equal(multi, 2);
});

test('1b. re-importing the same JSON does not duplicate rows (platform + video id dedupe)', async () => {
  const { db } = await makeEnv();
  const before = ['source_videos', 'performance_candidates', 'clip_assets', 'usage_permissions'].map((t) => count(db, t));
  importFile(db, SEED);
  const after = ['source_videos', 'performance_candidates', 'clip_assets', 'usage_permissions'].map((t) => count(db, t));
  assert.deepEqual(after, before);
  assert.throws(() => db.prepare(`INSERT INTO source_videos (channel_id, platform, platform_video_id, official_url, title, published_at)
                                  VALUES (1, 'youtube', 'TEST-SLS-0001', 'x', 'dup', '2026-01-01T00:00:00Z')`).run(), /UNIQUE/);
});

// ── 2. rights: permitted sample → clip; missing / expired / territory / segment → graphic ──
test('2. permitted sample is eligible; missing, expired, territory and segment cases are not', async () => {
  const { db, cfg, ffmpeg } = await makeEnv();
  const ctx = (date) => ({ cfg, publishAtUtc: zonedToUtcIso(date, '19:00', 'Asia/Seoul'), mode: 'dry_run' });
  const ok = evaluateClip(fullAsset(db, 'A001-lumina-band-sample'), ctx('2026-11-23'));
  if (ffmpeg) assert.equal(ok.eligible, true, ok.reasons.join('; '));
  assert.equal(ok.testOnly, true);

  const cases = {
    'A002-haneul-cover-expired': /expired/,
    'A003-orbit-kr-only': /territory KR/,
    'A004-sora-segment-mismatch': /permitted segment 30–60s does not cover intended 50–80s/,
    'A005-sora-cover-missing-music': /\[music\] permission missing/,
  };
  for (const [key, re] of Object.entries(cases)) {
    const r = evaluateClip(fullAsset(db, key), ctx('2026-11-15'));
    assert.equal(r.eligible, false, key);
    assert.ok(r.reasons.some((x) => re.test(x)), `${key}: ${r.reasons.join(' | ')}`);
  }
  // test assets and virtual permissions are refused on the live path
  const live = evaluateClip(fullAsset(db, 'A001-lumina-band-sample'), { ...ctx('2026-11-23'), mode: 'live' });
  assert.equal(live.eligible, false);
  assert.ok(live.reasons.some((x) => /Test asset/.test(x)));
  assert.ok(live.reasons.some((x) => /virtual test permission/.test(x)));
});

test('2b. pipeline: clip day renders licensed_clip, rejected-rights day falls back to original_graphic', { skip: false }, async (t) => {
  const { db, cfg, ffmpeg } = await makeEnv();
  if (!ffmpeg) return t.skip('FFmpeg not available');
  const g = await runDay(db, cfg, '2026-11-15', { now: NOW });
  assert.equal(g.reel.output_format, 'original_graphic');
  assert.equal(g.reel.clip_asset_id, null);
  assert.match(g.reel.format_reason, /expired/);
  const c = await runDay(db, cfg, '2026-11-23', { now: NOW });
  assert.equal(c.reel.output_format, 'licensed_clip');
  assert.equal(c.reel.clip_asset_id, assetByKey(db, 'A001-lumina-band-sample').id);
  assert.match(c.job.expected_status, /BLOCKED/); // test asset would be blocked when live
});

// ── 3. no valid candidate → skip with reason ─────────────────────────────────────────
test('3. a date with no eligible candidate is skipped and the reason is stored', async () => {
  const { db, cfg } = await makeEnv();
  const r = await runDay(db, cfg, '2026-09-26', { now: NOW });
  assert.equal(r.selection.status, 'skipped');
  assert.equal(r.selection.candidate_id, null);
  assert.match(r.selection.skip_reason, /no official English song title ×1/);
  assert.equal(r.reel, null);
  assert.equal(count(db, 'reels'), 0);
  assert.equal(count(db, 'publish_jobs'), 0);
  const snap = JSON.parse(db.prepare('SELECT evaluation_snapshot s FROM daily_selections').get().s);
  const unverified = snap.find((x) => x.candidate_key === 'P006-haneul-3am-unverified');
  assert.ok(unverified.exclusions.some((e) => e.code === 'no_official_title_en'));
});

// ── 4. English title / caption / official link / 9:16 output ───────────────────────
test('4. English title, caption, official link with verified timestamp only', async () => {
  const { db, cfg } = await makeEnv();
  const band = buildCopy(byKey(db, 'P001-lumina-starlight-band'), { format: 'original_graphic', account: cfg.account });
  assert.equal(band.title_en, 'The live band version of Starlight Avenue');
  assert.equal(band.caption.split('\n')[0], 'LUMINA – Starlight Avenue (Live Band Version)');
  assert.equal(band.caption.split('\n')[1], '루미나 – 별빛 거리');
  assert.equal(band.official_link, 'https://example.com/test-official/watch?v=TEST-SLS-0001&t=134s');
  assert.match(band.caption, /starts at 2:14/);

  const cover = buildCopy(byKey(db, 'P002-haneul-starlight-acoustic-cover'), { format: 'original_graphic', account: cfg.account });
  assert.equal(cover.title_en, 'An acoustic cover of Starlight Avenue');
  assert.equal(cover.caption.split('\n')[0], 'Haneul – Starlight Avenue (Acoustic Cover)');
  assert.match(cover.caption, /Originally by LUMINA \(루미나\)/);
  assert.equal(cover.official_link, 'https://example.com/test-official/watch?v=TEST-HAN-0001'); // no verified segment → no timestamp
  assert.doesNotMatch(cover.caption, /starts at/);
  assert.match(cover.caption, /No performance footage or audio is used/);

  // never auto-romanize / translate
  assert.throws(() => buildCopy(byKey(db, 'P006-haneul-3am-unverified'), { format: 'original_graphic', account: cfg.account }), /official English names/);
});

test('4b. rendered MP4s are 1080x1920 H.264 with audio', async (t) => {
  const { db, cfg, ffmpeg } = await makeEnv();
  if (!ffmpeg) return t.skip('FFmpeg not available');
  for (const d of ['2026-11-15', '2026-11-23']) {
    const r = await runDay(db, cfg, d, { now: NOW });
    assert.equal(r.reel.render_status, 'done', r.reel.render_error);
    const p = probe(cfg, fromStoredPath(cfg, r.reel.output_path));
    assert.equal(p.width, 1080); assert.equal(p.height, 1920);
    assert.equal(p.codec, 'h264'); assert.equal(p.pix_fmt, 'yuv420p'); assert.equal(p.audio, 'aac');
    assert.ok(fs.existsSync(fromStoredPath(cfg, r.reel.poster_path)));
  }
});

// ── 5. idempotency ───────────────────────────────────────────────────────────────────
test('5. re-running the same date never duplicates selection, reel or dry-run job', async (t) => {
  const { db, cfg, ffmpeg } = await makeEnv();
  if (!ffmpeg) return t.skip('FFmpeg not available');
  const dates = ['2026-09-26', '2026-11-15', '2026-11-16', '2026-11-23'];
  const first = [];
  for (const d of dates) first.push(await runDay(db, cfg, d, { now: NOW }));
  const counts = ['daily_selections', 'reels', 'publish_jobs'].map((x) => count(db, x));
  for (const [i, d] of dates.entries()) {
    const again = await runDay(db, cfg, d, { now: NOW });
    assert.equal(again.selectionReused, true);
    assert.equal(again.selection.id, first[i].selection.id);
    if (first[i].reel) {
      assert.equal(again.reel.id, first[i].reel.id);
      assert.equal(again.rendered, false);
      assert.equal(again.job.id, first[i].job.id);
    }
  }
  assert.deepEqual(['daily_selections', 'reels', 'publish_jobs'].map((x) => count(db, x)), counts);
  assert.deepEqual(counts, [4, 3, 3]);
  // DB-level guards
  assert.throws(() => db.prepare(`INSERT INTO daily_selections (operating_date, status, skip_reason, rule_version) VALUES ('2026-11-23','skipped','x','v')`).run(), /UNIQUE/);
  const reel = db.prepare('SELECT * FROM reels LIMIT 1').get();
  assert.throws(() => db.prepare(`INSERT INTO publish_jobs (reel_id, platform, mode, scheduled_at, status) VALUES (?, 'instagram', 'dry_run', 'x', 'simulated')`).run(reel.id), /UNIQUE/);
  assert.throws(() => db.prepare(`INSERT INTO reels (selection_id, output_format, format_reason, title_en, caption, official_link) VALUES (?, 'original_graphic', 'x', 'x', 'x', 'x')`).run(reel.selection_id), /UNIQUE/);
  assert.throws(() => db.prepare(`INSERT INTO reels (selection_id, output_format, format_reason, title_en, caption, official_link) VALUES (9999, 'original_graphic', 'x', 'x', 'x', 'x')`).run(), /FOREIGN KEY/);
  assert.throws(() => db.prepare(`UPDATE publish_jobs SET external_media_id = 'fake' WHERE mode = 'dry_run'`).run(), /CHECK/); // no fake IDs in dry-run
});

test('5b. a failed render is resumed on the same reel row', async (t) => {
  const env = await makeEnv({ render: { ffmpegPath: 'ffmpeg-does-not-exist' } });
  const ok = await makeEnv();
  if (!ok.ffmpeg) return t.skip('FFmpeg not available');
  const r1 = await runDay(env.db, env.cfg, '2026-11-15', { now: NOW });
  assert.equal(r1.reel.render_status, 'failed');
  assert.match(r1.reel.render_error, /not found/);
  assert.equal(r1.job, null);
  const fixedCfg = { ...env.cfg, render: { ...env.cfg.render, ffmpegPath: 'ffmpeg' } };
  const r2 = await runDay(env.db, fixedCfg, '2026-11-15', { now: NOW });
  assert.equal(r2.reel.id, r1.reel.id);
  assert.equal(r2.reel.render_status, 'done');
  assert.equal(r2.reel.render_attempts, 2);
  assert.equal(count(env.db, 'reels'), 1);
  assert.equal(r2.job.status, 'simulated');
});

test('5c. explicit reselect updates the same selection row (revision+1)', async (t) => {
  const { db, cfg, ffmpeg } = await makeEnv();
  if (!ffmpeg) return t.skip('FFmpeg not available');
  const a = await runDay(db, cfg, '2026-11-15', { now: NOW });
  const b = await runDay(db, cfg, '2026-11-15', { reselect: true, now: NOW });
  assert.equal(b.selection.id, a.selection.id);
  assert.equal(b.selection.revision, 2);
  assert.equal(count(db, 'daily_selections'), 1);
  assert.equal(count(db, 'reels'), 1);
  assert.equal(count(db, 'publish_jobs'), 1);
});

// ── selection rules ─────────────────────────────────────────────────────────────────
test('selection: scores, deterministic tie-break, 7-day diversity, dry-run is not "published"', async (t) => {
  const { db, cfg, ffmpeg } = await makeEnv();
  const ev = evaluateDate(db, cfg, '2026-11-15');
  const top = ev.eligible.slice(0, 4).map((e) => [e.candidate.candidate_key, e.score.total]);
  // four candidates tie at 100 → newest official publish date wins (P002, 2026-11-10)
  assert.deepEqual(top.map((x) => x[1]), [100, 100, 100, 100]);
  assert.equal(top[0][0], 'P002-haneul-starlight-acoustic-cover');
  assert.equal(ev.format, 'original_graphic');
  const plain = ev.eligible.find((e) => e.candidate.candidate_key === 'P007-lumina-starlight-stage');
  assert.equal(plain.score.items.find((i) => i.key === 'versionDifference').points, 0);

  if (!ffmpeg) return t.skip('FFmpeg not available');
  await runDay(db, cfg, '2026-11-15', { now: NOW });
  const next = selectDaily(db, cfg, '2026-11-16');
  const snap = JSON.parse(next.selection.evaluation_snapshot);
  const haneul = snap.find((s) => s.candidate_key === 'P002-haneul-starlight-acoustic-cover');
  assert.equal(haneul.score.items.find((i) => i.key === 'recentDiversity').points, 0);
  assert.equal(db.prepare('SELECT pc.candidate_key k FROM daily_selections ds JOIN performance_candidates pc ON pc.id = ds.candidate_id WHERE operating_date = ?').get('2026-11-16').k, 'P003-orbit-bluehour-acoustic');
  // dry-run job exists for P002 but P002 is still eligible (dry-run ≠ published)
  assert.equal(haneul.eligible, true);
});

test('time: operating date is Asia/Seoul, schedule stored in UTC', () => {
  assert.equal(zonedToUtcIso('2026-11-23', '19:00', 'Asia/Seoul'), '2026-11-23T10:00:00Z');
  assert.equal(zonedToUtcIso('2026-11-23', '07:30', 'Asia/Seoul'), '2026-11-22T22:30:00Z');
});

test('live mode is refused in this MVP (no real publishing)', async () => {
  const { db, cfg } = await makeEnv();
  await assert.rejects(runDay(db, cfg, '2026-11-23', { mode: 'live' }), /not implemented/);
  assert.equal(count(db, 'publish_jobs'), 0);
});

test('secrets: evidence must be a pointer, official URL cannot stand in for a file, logs redact tokens', async () => {
  const { db } = await makeEnv();
  const { redact } = require('../src/util/log');
  const base = JSON.parse(fs.readFileSync(SEED, 'utf8'));
  const bad1 = { ...base, clip_assets: [{ ...base.clip_assets[0], permissions: [{ ...base.clip_assets[0].permissions[0], evidence_ref: 'C:/contracts/signed.pdf' }] }] };
  assert.throws(() => require('../src/ingest/importJson').importData(db, bad1), /pointer/);
  const bad2 = { ...base, clip_assets: [{ ...base.clip_assets[0], file_ref: 'https://www.youtube.com/watch?v=x' }] };
  assert.throws(() => require('../src/ingest/importJson').importData(db, bad2), /not a URL/);
  assert.equal(redact('access_token=EAAB1234567890abcdefghijklmnop'), 'access_token=[REDACTED]');
});
