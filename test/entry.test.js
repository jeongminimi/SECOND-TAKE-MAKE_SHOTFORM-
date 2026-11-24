'use strict';
/**
 * M1 — registering data from the screen instead of editing JSON.
 * The point of these tests is the boundary between "refuse" and "store with a warning":
 * a claim without its source is refused, a missing claim is stored and explained.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { makeEnv, count } = require('./helpers');
const entry = require('../src/ingest/manualEntry');
const { previewCandidate } = require('../src/selection/selectDaily');
const { runDay } = require('../src/pipeline');
const { createApp } = require('../src/web/server');

const DATE = '2026-11-25';
const PUBLISHED = '2026-11-20T09:00:00Z';

/** Builds channel → video → track → candidate the way the forms do, and returns their ids. */
function buildChain(db, over = {}) {
  const channel = entry.saveChannel(db, { platform: 'youtube', external_id: 'UC-TEST-ENTRY', name: 'Entry Test Official (TEST)', is_test: 1 }).row;
  const video = entry.saveVideo(db, {
    channel_id: channel.id, platform: 'youtube', platform_video_id: 'TEST-ENTRY-0001',
    official_url: 'https://www.example.com/watch?v=TEST-ENTRY-0001', title: 'NOVA – Paper Lantern (Live Band Version)',
    description: 'TEST fixture', published_at: PUBLISHED,
  }).row;
  const track = entry.saveTrack(db, {
    track_key: 'TR_PAPER_LANTERN', original_artist_en: 'NOVA', original_artist_ko: '노바',
    title_en: 'Paper Lantern', title_ko: '종이 등', name_evidence: 'TEST: official English title in the channel video title',
  }).row;
  const candidate = entry.saveCandidate(db, {
    candidate_key: 'P100-nova-paperlantern-band', source_video_id: video.id, track_id: track.id,
    performer_en: 'NOVA', performer_ko: '노바', program_name: 'Entry Test Sessions (TEST)',
    performance_type: 'live', arrangement_tags: ['band'],
    version_evidence: 'TEST: "Live Band Version" stated in the official title',
    ...over,
  }).row;
  return { channel, video, track, candidate };
}

/** Registers the self-made test clip through the upload path and grants all three rights. */
function attachLicensedClip(db, cfg, candidateId, { assetKey = 'A100-nova-band' } = {}) {
  const source = path.join(cfg.resolved.testAssets, 'sample_live_clip.mp4');
  const { file_ref } = entry.storeClipFile(cfg, 'nova-band.mp4', fs.readFileSync(source));
  const asset = entry.saveClipAsset(db, cfg, {
    asset_key: assetKey, candidate_id: candidateId, file_ref,
    source_start_sec: 130, source_end_sec: 150, file_offset_sec: 4, is_test_asset: 1,
  }).row;
  for (const cat of ['footage', 'music', 'performance']) {
    const { evidence_ref } = entry.storeEvidenceFile(cfg, `${assetKey}-${cat}.txt`, Buffer.from(`TEST permission document for ${cat}`));
    entry.savePermission(db, {
      clip_asset_id: asset.id, rights_category: cat, rights_holder: `Entry Test Holder (${cat}, TEST)`, status: 'granted',
      allows_edit: 1, allows_repost: 1, platforms: ['instagram'], territories: ['WORLDWIDE'],
      valid_from: '2026-11-01T00:00:00Z', valid_until: '2027-12-31T23:59:59Z',
      permitted_start_sec: 120, permitted_end_sec: 300, evidence_ref, is_test_permission: 1,
    });
  }
  return asset;
}

// ── a claim without its source is refused ────────────────────────────────────────────────────────
test('entry: a claim saved without its source is refused, and the refusal says which field in Korean', async () => {
  const { db } = await makeEnv({}, { seed: false });
  const { video, track } = buildChain(db);
  const base = { candidate_key: 'P101-refusals', source_video_id: video.id, track_id: track.id, performer_en: 'NOVA', performance_type: 'live' };

  // "왜 볼 만한가" is deliberately absent: it is the operator's own impression, which has no source to
  // cite and is no longer refused for lacking one. See test/entry-rules.test.js for that line.
  const cases = [
    ['version_evidence', { ...base, arrangement_tags: ['acoustic'] }],
    ['segment_evidence', { ...base, segment_start_sec: 40, segment_end_sec: 70 }],
    ['occasion_evidence', { ...base, occasion_note: 'Ten years since debut.' }],
    ['watch_cues[0]', { ...base, watch_cues: [{ at_sec: 42, text_en: 'The band takes over.' }] }],
  ];
  for (const [field, payload] of cases) {
    let err = null;
    try { entry.saveCandidate(db, payload); } catch (e) { err = e; }
    assert.ok(err, `${field}: should have been refused`);
    const blocked = err.issues.filter((i) => i.level === 'block');
    assert.ok(blocked.some((i) => i.field === field), `${field}: expected a block on that field, got ${blocked.map((i) => i.field)}`);
    assert.ok(blocked.every((i) => i.ko && i.ko !== i.en), `${field}: every blocking issue needs a Korean explanation`);
  }
  assert.equal(count(db, 'performance_candidates'), 1, 'no refused candidate may be stored');
});

test('entry: a missing claim is stored with a warning that says it will not be selected', async () => {
  const { db } = await makeEnv({}, { seed: false });
  const { video, track } = buildChain(db);
  const r = entry.saveCandidate(db, {
    candidate_key: 'P102-incomplete', source_video_id: video.id, track_id: track.id, performance_type: 'live',
  });
  assert.ok(r.row.id, 'a half-filled candidate is still stored');
  const codes = r.warnings.map((w) => w.code);
  assert.ok(codes.includes('performer_en_missing'), `expected performer warning, got ${codes}`);
  assert.ok(codes.includes('version_evidence_missing'), `expected version warning, got ${codes}`);
  assert.ok(r.warnings.every((w) => w.ko), 'warnings are shown to the operator, so each needs Korean text');

  const preview = previewCandidate(db, require('../src/config').loadConfig(), r.row.id, DATE);
  assert.equal(preview.eligible, false);
  assert.ok(preview.exclusions.some((x) => x.code === 'no_official_performer_en'));
});

test('entry: an official link is not a clip file, and an evidence document is not an evidence pointer', async () => {
  const { db, cfg } = await makeEnv({}, { seed: false });
  const { candidate } = buildChain(db);
  assert.throws(() => entry.saveClipAsset(db, cfg, {
    asset_key: 'A101', candidate_id: candidate.id, file_ref: 'https://www.youtube.com/watch?v=abc', source_start_sec: 10, source_end_sec: 20,
  }), /not a URL/);

  const { file_ref } = entry.storeClipFile(cfg, 'ok.mp4', Buffer.from('not really a video, but a real file'));
  const asset = entry.saveClipAsset(db, cfg, { asset_key: 'A102', candidate_id: candidate.id, file_ref, source_start_sec: 10, source_end_sec: 20 }).row;
  assert.throws(() => entry.savePermission(db, {
    clip_asset_id: asset.id, rights_category: 'footage', status: 'granted', evidence_ref: 'C:/contracts/signed.pdf',
  }), /pointer/);
});

// ── uploads stay out of the database ─────────────────────────────────────────────────────────────
test('entry: uploads are stored on disk; the database keeps only a project path and an evidence pointer', async () => {
  const { cfg } = await makeEnv({}, { seed: false });
  const clip = entry.storeClipFile(cfg, 'My Clip.mp4', Buffer.from('clip bytes'));
  const { fromStoredPath } = require('../src/config');
  assert.ok(fromStoredPath(cfg, clip.file_ref).startsWith(cfg.resolved.clips), 'the clip lands in the configured clips folder');
  assert.ok(fs.existsSync(fromStoredPath(cfg, clip.file_ref)), 'and the path recorded in the database really resolves to it');

  const ev = entry.storeEvidenceFile(cfg, 'contract.pdf', Buffer.from('%PDF- fake'));
  assert.match(ev.evidence_ref, /^evidence:\/\//, 'only a pointer goes into the database');
  assert.ok(fs.existsSync(path.join(cfg.resolved.evidence, 'contract.pdf')), 'the document itself stays in storage/evidence');

  // A name that tries to climb out of the folder is flattened, not honoured.
  const climb = entry.storeEvidenceFile(cfg, '../../escaped.txt', Buffer.from('x'));
  assert.ok(fs.existsSync(path.join(cfg.resolved.evidence, path.basename(climb.evidence_ref))), 'stored inside the evidence folder');
  assert.ok(!fs.existsSync(path.join(cfg.resolved.root, '..', 'escaped.txt')), 'never written outside the project');

  // A second upload of the same name does not overwrite the first.
  const again = entry.storeEvidenceFile(cfg, 'contract.pdf', Buffer.from('%PDF- second'));
  assert.notEqual(again.evidence_ref, ev.evidence_ref);
});

// ── deactivating ─────────────────────────────────────────────────────────────────────────────────
test('entry: deactivating a candidate, its video or its channel keeps the row but stops it being selected', async () => {
  const { db, cfg } = await makeEnv({}, { seed: false });
  const { channel, video, candidate } = buildChain(db);
  const codeFor = () => previewCandidate(db, cfg, candidate.id, DATE).exclusions.map((x) => x.code);

  assert.deepEqual(codeFor(), [], 'a complete candidate starts eligible');
  for (const [kind, row, code] of [['candidate', candidate, 'candidate_inactive'], ['video', video, 'video_inactive'], ['channel', channel, 'channel_inactive']]) {
    entry.setActive(db, kind, row.id, false);
    assert.ok(codeFor().includes(code), `${kind} deactivated → ${code}`);
    entry.setActive(db, kind, row.id, true);
    assert.ok(!codeFor().includes(code), `${kind} reactivated → eligible again`);
  }
  assert.equal(count(db, 'performance_candidates'), 1, 'deactivating never deletes');
});

// ── the format preview the registration screen shows ─────────────────────────────────────────────
test('entry: the preview says graphic until all three rights are covered, then clip', async () => {
  const { db, cfg, ffmpeg } = await makeEnv({}, { seed: false });
  const { candidate } = buildChain(db);

  let p = previewCandidate(db, cfg, candidate.id, DATE);
  assert.equal(p.format, 'original_graphic');
  assert.match(p.format_reason, /No clip file registered/);
  assert.equal(p.score.total, 100, 'a fully evidenced candidate scores full marks');

  if (!ffmpeg) return; // the clip file itself is generated by FFmpeg
  const source = path.join(cfg.resolved.testAssets, 'sample_live_clip.mp4');
  const { file_ref } = entry.storeClipFile(cfg, 'nova.mp4', fs.readFileSync(source));
  const asset = entry.saveClipAsset(db, cfg, {
    asset_key: 'A103-nova', candidate_id: candidate.id, file_ref, source_start_sec: 130, source_end_sec: 150, file_offset_sec: 4, is_test_asset: 1,
  }).row;

  p = previewCandidate(db, cfg, candidate.id, DATE);
  assert.equal(p.format, 'original_graphic', 'a file without permissions is not a licence');
  assert.ok(p.clip.assets[0].reasons.some((r) => /permission missing/.test(r)));

  for (const cat of ['footage', 'music']) {
    entry.savePermission(db, {
      clip_asset_id: asset.id, rights_category: cat, rights_holder: 'TEST', status: 'granted', allows_edit: 1, allows_repost: 1,
      platforms: ['instagram'], territories: ['WORLDWIDE'], valid_from: '2026-11-01T00:00:00Z', valid_until: '2027-12-31T23:59:59Z',
      permitted_start_sec: 120, permitted_end_sec: 300, evidence_ref: `evidence://TEST-${cat}`, is_test_permission: 1,
    });
  }
  p = previewCandidate(db, cfg, candidate.id, DATE);
  assert.equal(p.format, 'original_graphic', 'two of three rights is still not enough');

  entry.savePermission(db, {
    clip_asset_id: asset.id, rights_category: 'performance', rights_holder: 'TEST', status: 'granted', allows_edit: 1, allows_repost: 1,
    platforms: ['instagram'], territories: ['WORLDWIDE'], valid_from: '2026-11-01T00:00:00Z', valid_until: '2027-12-31T23:59:59Z',
    permitted_start_sec: 120, permitted_end_sec: 300, evidence_ref: 'evidence://TEST-performance', is_test_permission: 1,
  });
  p = previewCandidate(db, cfg, candidate.id, DATE);
  assert.equal(p.format, 'licensed_clip');
  assert.equal(p.clip.usable_asset_key, 'A103-nova');
});

// ── M1 completion criterion ──────────────────────────────────────────────────────────────────────
test('M1: a candidate registered only through the API is selected and rendered — no JSON file edited', async (t) => {
  const { db, cfg, ffmpeg } = await makeEnv({}, { seed: false });
  if (!ffmpeg) return t.skip('FFmpeg not available');
  const server = http.createServer(createApp(cfg, db));
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (p, body) => {
    const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  try {
    const ch = await post('/api/entry/channel', { platform: 'youtube', external_id: 'UC-API-ONLY', name: 'API Only Official (TEST)', is_test: 1 });
    assert.equal(ch.body.ok, true);
    const vid = await post('/api/entry/video', {
      channel_id: ch.body.row.id, platform: 'youtube', platform_video_id: 'API-ONLY-1',
      official_url: 'https://www.example.com/watch?v=API-ONLY-1', title: 'VERA – Lantern Street (Acoustic Version)', published_at: PUBLISHED,
    });
    const tr = await post('/api/entry/track', {
      track_key: 'TR_LANTERN_STREET', original_artist_en: 'VERA', original_artist_ko: '베라',
      title_en: 'Lantern Street', title_ko: '등불 거리', name_evidence: 'TEST: official title in the video title',
    });

    // A claim without its source is rejected by the API too, with a field-level Korean reason.
    const bad = await post('/api/entry/candidate', {
      candidate_key: 'P200-bad', source_video_id: vid.body.row.id, track_id: tr.body.row.id,
      performer_en: 'VERA', performance_type: 'live', arrangement_tags: ['acoustic'],
    });
    assert.equal(bad.status, 400);
    assert.ok(bad.body.issues.some((i) => i.field === 'version_evidence' && i.ko));

    const cand = await post('/api/entry/candidate', {
      candidate_key: 'P200-vera-lanternstreet-acoustic', source_video_id: vid.body.row.id, track_id: tr.body.row.id,
      performer_en: 'VERA', performer_ko: '베라', program_name: 'API Only Sessions (TEST)',
      performance_type: 'live', arrangement_tags: ['acoustic'],
      version_evidence: 'TEST: "Acoustic Version" stated in the official title',
      watch_cues: [{ at_sec: 138, text_en: 'The guitar drops out for the last chorus.', evidence: 'TEST: official chapter list' }],
    });
    assert.equal(cand.body.ok, true);

    // Upload the self-made test clip through the raw-body upload route.
    const bytes = fs.readFileSync(path.join(cfg.resolved.testAssets, 'sample_live_clip.mp4'));
    const up = await fetch(`${base}/api/entry/upload/clip?name=vera.mp4`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes,
    }).then((r) => r.json());
    assert.equal(up.ok, true, `upload failed: ${up.error}`);

    const asset = await post('/api/entry/clip-asset', {
      asset_key: 'A200-vera', candidate_id: cand.body.row.id, file_ref: up.file_ref,
      source_start_sec: 130, source_end_sec: 150, file_offset_sec: 4, is_test_asset: 1,
    });
    assert.equal(asset.body.ok, true);
    for (const cat of ['footage', 'music', 'performance']) {
      const ev = await fetch(`${base}/api/entry/upload/evidence?name=${cat}.txt`, {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.from(`TEST ${cat} permission`),
      }).then((r) => r.json());
      const perm = await post('/api/entry/permission', {
        clip_asset_id: asset.body.row.id, rights_category: cat, rights_holder: `TEST ${cat}`, status: 'granted',
        allows_edit: 1, allows_repost: 1, platforms: ['instagram'], territories: ['WORLDWIDE'],
        valid_from: '2026-11-01T00:00:00Z', valid_until: '2027-12-31T23:59:59Z',
        permitted_start_sec: 120, permitted_end_sec: 300, evidence_ref: ev.evidence_ref, is_test_permission: 1,
      });
      assert.equal(perm.body.ok, true, `permission ${cat}: ${perm.body.error}`);
    }

    const prev = await fetch(`${base}/api/entry/preview/${cand.body.row.id}?date=${DATE}`).then((r) => r.json());
    assert.equal(prev.preview.format, 'licensed_clip');
    assert.equal(prev.preview.eligible, true);

    // …and the pipeline picks exactly this candidate and renders a real file.
    const run = await post('/api/run', { date: DATE });
    assert.equal(run.body.ok, true);
    const day = await fetch(`${base}/api/day/${DATE}`).then((r) => r.json());
    assert.equal(day.selection.status, 'selected');
    assert.equal(day.candidate.candidate_key, 'P200-vera-lanternstreet-acoustic');
    assert.equal(day.reel.output_format, 'licensed_clip');
    assert.equal(day.reel.render_status, 'done');
    assert.match(day.reel.caption, /^VERA – Lantern Street \(Acoustic Live Version\)/);
    const video = await fetch(base + day.reel.video_url);
    assert.equal(video.status, 200);
    assert.equal(video.headers.get('content-type'), 'video/mp4');
  } finally {
    server.close();
  }
});

test('entry: deactivating the only candidate makes the day skip, with the reason recorded', async () => {
  const { db, cfg } = await makeEnv({}, { seed: false });
  const { candidate } = buildChain(db);
  attachLicensedClip(db, cfg, candidate.id);
  entry.setActive(db, 'candidate', candidate.id, false);
  const r = await runDay(db, cfg, DATE);
  assert.equal(r.selection.status, 'skipped');
  assert.match(r.selection.skip_reason, /candidate deactivated/);
});
