'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeEnv, count, SEED, NOW } = require('./helpers');
const { runDay } = require('../src/pipeline');
const { loadCandidates, loadClipAssets } = require('../src/selection/candidates');
const { buildCopy } = require('../src/copy/templates');
const { listTemplates, pickTemplate, timing } = require('../src/render/templateEngine');
const { renderReel } = require('../src/render/renderReel');
const { probe } = require('../src/render/ffmpeg');
const { fromStoredPath } = require('../src/config');
const { importData } = require('../src/ingest/importJson');
const { analyzeAssets, approveSuggestion, suggestSegment, getAnalysis } = require('../src/analysis/structure');

const cand = (db, key) => loadCandidates(db).find((c) => c.candidate_key === key);
const asset = (db, key) => { const a = db.prepare('SELECT id, candidate_id FROM clip_assets WHERE asset_key = ?').get(key); return loadClipAssets(db, a.candidate_id).find((x) => x.id === a.id); };

// ── templates (③) ────────────────────────────────────────────────────────────────────
test('templates: all JSON templates load and rotate deterministically by date', async () => {
  const { cfg } = await makeEnv();
  const ids = listTemplates().map((t) => t.id).sort();
  assert.deepEqual(ids, ['clip-full', 'clip-large', 'clip-minimal', 'clip-standard', 'graphic-classic', 'graphic-sequence']);
  const a = pickTemplate(cfg, 'original_graphic', '2026-11-15');
  const b = pickTemplate(cfg, 'original_graphic', '2026-11-16');
  assert.notEqual(a, b);                                            // consecutive days alternate
  assert.equal(pickTemplate(cfg, 'original_graphic', '2026-11-15'), a); // deterministic
  // The three new clip shapes exist to be chosen by hand. They are deliberately NOT in the rotation,
  // so an automatic run still produces the letterboxed shape it always did.
  assert.deepEqual(cfg.render.templates.licensed_clip, ['clip-standard']);
  assert.equal(pickTemplate(cfg, 'licensed_clip', '2026-11-23'), 'clip-standard');
  assert.equal(pickTemplate(cfg, 'licensed_clip', '2026-11-24'), 'clip-standard');
});

test('templates: both graphic templates render a valid 1080x1920 MP4', async (t) => {
  const { db, cfg, ffmpeg } = await makeEnv();
  if (!ffmpeg) return t.skip('FFmpeg not available');
  const c = cand(db, 'P003-orbit-bluehour-acoustic');
  const copy = buildCopy(c, { format: 'original_graphic', account: cfg.account });
  for (const [i, id] of ['graphic-classic', 'graphic-sequence'].entries()) {
    const out = await renderReel({ cfg, reel: { id: 900 + i, output_format: 'original_graphic' }, copy, operatingDate: '2000-01-01', templateId: id });
    const p = probe(cfg, fromStoredPath(cfg, out.outputPath));
    assert.equal(p.width, 1080); assert.equal(p.height, 1920);
    assert.equal(out.templateId, id);
    if (id === 'graphic-sequence') assert.ok(out.layout.drawn.some((e) => e.type === 'list'), 'cue list drawn in scene 3');
  }
});

test('templates: timed elements get enable windows and fades', () => {
  const m = timing({ show: [2.8, 5.5] }, 8);
  assert.equal(m.enable, 'between(t,2.8,5.5)');
  assert.match(m.alpha, /^if\(lt\(t,3\.15\)/);
  assert.equal(timing({}, 8).alpha, null);
});

// ── evidence-backed cues (②) ─────────────────────────────────────────────────────────
test('cues: shown in caption with timestamps; a cue without evidence is rejected at import', async () => {
  const { db, cfg } = await makeEnv();
  const copy = buildCopy(cand(db, 'P001-lumina-starlight-band'), { format: 'original_graphic', account: cfg.account });
  assert.match(copy.caption, /Moments to watch \(official video\):\n2:20 — The full band drops in\n2:29 — Guitar takes the hook/);
  assert.equal(copy.graphic.cues.length, 3);
  const none = buildCopy(cand(db, 'P002-haneul-starlight-acoustic-cover'), { format: 'original_graphic', account: cfg.account });
  assert.doesNotMatch(none.caption, /Moments to watch/);
  const base = JSON.parse(fs.readFileSync(SEED, 'utf8'));
  const bad = { ...base, candidates: base.candidates.map((c) => c.candidate_key.startsWith('P002') ? { ...c, watch_cues: [{ at_sec: 10, text_en: 'Big note' }] } : c) };
  assert.throws(() => importData(db, bad), /no evidence/);
});

// ── all-in-one segment suggestions (①) ───────────────────────────────────────────────
test('analysis: chorus suggested on downbeats inside the permitted range; rights gaps give no suggestion', async () => {
  const { db, cfg } = await makeEnv();
  const a1 = asset(db, 'A001-lumina-band-sample');
  const { analysis, analyzer } = getAnalysis(cfg, a1);
  assert.equal(analyzer, 'fixture');
  const s = suggestSegment(cfg, a1, analysis).suggestion;
  assert.equal(s.label, 'chorus');
  assert.ok(analysis.downbeats.includes(s.file_start_sec) && analysis.downbeats.includes(s.file_end_sec), 'cut on bar lines');
  assert.deepEqual([s.source_start_sec, s.source_end_sec], [154.5, 170.5]);
  assert.ok(s.source_start_sec >= 120 && s.source_end_sec <= 300, 'inside permitted 120–300');
  assert.ok(s.source_end_sec - s.source_start_sec <= cfg.render.maxClipDurationSec);

  const a4 = suggestSegment(cfg, asset(db, 'A004-sora-segment-mismatch'), analysis);
  assert.equal(a4.suggestion, null);
  assert.match(a4.reason, /fits inside permitted 30–60s/);
  const a5 = suggestSegment(cfg, asset(db, 'A005-sora-cover-missing-music'), analysis);
  assert.equal(a5.suggestion, null);
  assert.match(a5.reason, /\[music\] permission missing/);
});

test('analysis: fixtures are never used for real assets; a broken all-in-one install fails gracefully', async (t) => {
  const { db, cfg, ffmpeg } = await makeEnv();
  const real = { ...asset(db, 'A001-lumina-band-sample'), is_test_asset: 0 };

  // Example data stands in for an analysis only on TEST material. A real file never gets it.
  const noFallback = { ...cfg, analysis: { ...cfg.analysis, loudness: { enabled: false } } };
  assert.equal(getAnalysis(noFallback, real).analysis, null, 'no fixture, and nothing invented, for a real asset');

  const broken = { ...cfg, analysis: { ...cfg.analysis, allin1: { ...cfg.analysis.allin1, enabled: true, pythonPath: 'python-does-not-exist' } } };
  const r = getAnalysis(broken, real);
  assert.equal(r.analysis, null);
  assert.match(r.reason, /all-in-one failed/);

  // With the FFmpeg fallback on, a real file is measured rather than guessed at — and it is labelled
  // for what it is, so nobody reads it as a structure analysis.
  if (!ffmpeg) return t.skip('FFmpeg not available');
  const got = getAnalysis(cfg, real);
  assert.equal(got.analyzer, 'loudness', got.reason);
  assert.notEqual(got.analyzer, 'fixture');
  assert.equal(got.analysis.segments[0].label, 'peak');
});

test('analysis: approval changes the clip range, re-renders the SAME reel, and keeps rights checks', async (t) => {
  const { db, cfg, ffmpeg } = await makeEnv();
  if (!ffmpeg) return t.skip('FFmpeg not available');
  const first = await runDay(db, cfg, '2026-11-23', { now: NOW });
  assert.equal(first.reel.output_format, 'licensed_clip');
  const before = probe(cfg, fromStoredPath(cfg, first.reel.output_path)).duration;

  const results = analyzeAssets(db, cfg);
  assert.equal(count(db, 'segment_suggestions'), 3);
  analyzeAssets(db, cfg);                                  // re-analysis is idempotent
  assert.equal(count(db, 'segment_suggestions'), 3);
  // nothing changed before approval
  assert.equal(asset(db, 'A001-lumina-band-sample').source_start_sec, 134);

  const sug = results.find((r) => r.asset_key === 'A001-lumina-band-sample').suggestion;
  const ap = approveSuggestion(db, cfg, sug.id);
  assert.deepEqual(ap.reelsToRerender, [first.reel.id]);
  const a1 = asset(db, 'A001-lumina-band-sample');
  assert.deepEqual([a1.source_start_sec, a1.source_end_sec, a1.file_offset_sec], [154.5, 170.5, 24.5]);

  const again = await runDay(db, cfg, '2026-11-23', { now: NOW });
  assert.equal(again.reel.id, first.reel.id);
  assert.equal(again.rendered, true);
  assert.equal(again.reel.render_attempts, 2);
  const after = probe(cfg, fromStoredPath(cfg, again.reel.output_path)).duration;
  assert.ok(Math.abs(before - 22) < 0.2 && Math.abs(after - 16) < 0.2, `durations ${before} → ${after}`);
  assert.equal(again.job.id, first.job.id);
  assert.equal(again.job.status, 'simulated');
  assert.match(again.job.plan_json, /Rights re-checked/);
  // the analysed range is not an official timestamp: caption still points at the verified chapter (2:14)
  assert.match(again.reel.caption, /starts at 2:14/);
  assert.equal(count(db, 'reels'), 1);
  assert.equal(count(db, 'publish_jobs'), 1);

  // once a live job exists the clip can no longer be changed
  const s2 = db.prepare(`INSERT INTO segment_suggestions (clip_asset_id, analyzer, analysis_ref, label, suggested_start_sec, suggested_end_sec, file_start_sec)
                         VALUES (?, 'fixture', 'x', 'verse', 140, 150, 10) RETURNING id`).get(a1.id).id;
  db.prepare(`INSERT INTO publish_jobs (reel_id, platform, mode, scheduled_at, status) VALUES (?, 'instagram', 'live', '2026-11-23T10:00:00Z', 'queued')`).run(first.reel.id);
  assert.throws(() => approveSuggestion(db, cfg, s2), /live publish job/);
});
