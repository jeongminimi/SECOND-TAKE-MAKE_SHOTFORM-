'use strict';
/**
 * Clip segment suggestions from music-structure analysis (all-in-one).
 *
 * Rules:
 *  - Suggestions are always inside the PERMITTED range (intersection over every required rights category).
 *    If rights are incomplete there is no permitted range, so there is no suggestion — rights come first.
 *  - Start/end snap to downbeats (bar lines) so the cut never lands mid-bar.
 *  - A suggestion changes nothing until an operator approves it.
 *  - Analysis output is NEVER shown as an official timestamp in captions (only source-verified segments are).
 *
 * Analysis sources, in order: cache (storage/analysis) → run all-in-one if enabled → fixture (TEST assets only).
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tx } = require('../db');
const { fromStoredPath, toStoredPath } = require('../config');
const { loadClipAssets } = require('../selection/candidates');

const r3 = (x) => Math.round(x * 1000) / 1000;

function analysisFileName(asset) {
  return `${path.basename(asset.file_ref).replace(/\.[^.]+$/, '')}.allin1.json`;
}

function validateAnalysis(a, where) {
  if (!a || !Array.isArray(a.segments) || !Array.isArray(a.downbeats)) throw new Error(`Invalid analysis JSON (${where}): needs segments[] and downbeats[]`);
  for (const s of a.segments) if (!(s.end > s.start) || !s.label) throw new Error(`Invalid segment in ${where}: ${JSON.stringify(s)}`);
  return a;
}

/** Returns { analysis, analyzer, ref } or { analysis: null, reason }. */
function getAnalysis(cfg, asset) {
  const ac = cfg.analysis;
  const cacheDir = fromStoredPath(cfg, ac.cacheDir);
  const cached = path.join(cacheDir, analysisFileName(asset));
  if (fs.existsSync(cached)) {
    const a = validateAnalysis(JSON.parse(fs.readFileSync(cached, 'utf8')), cached);
    return { analysis: a, analyzer: a.analyzer ?? 'allin1', ref: toStoredPath(cfg, cached) };
  }
  if (ac.allin1.enabled) {
    const src = fromStoredPath(cfg, asset.file_ref);
    if (!fs.existsSync(src)) return { analysis: null, reason: `clip file missing: ${asset.file_ref}` };
    fs.mkdirSync(cacheDir, { recursive: true });
    const r = spawnSync(ac.allin1.pythonPath, [fromStoredPath(cfg, ac.allin1.script), src, cached],
      { encoding: 'utf8', timeout: (ac.allin1.timeoutSec ?? 900) * 1000, windowsHide: true });
    if (r.error || r.status !== 0 || !fs.existsSync(cached)) {
      const msg = r.error ? r.error.message : (r.stderr || r.stdout || '').trim().split('\n').slice(-3).join(' | ');
      return { analysis: null, reason: `all-in-one failed: ${msg}` };
    }
    const a = validateAnalysis(JSON.parse(fs.readFileSync(cached, 'utf8')), cached);
    return { analysis: a, analyzer: 'allin1', ref: toStoredPath(cfg, cached) };
  }
  if (asset.is_test_asset) {
    const fx = path.join(fromStoredPath(cfg, ac.fixtureDir), analysisFileName(asset));
    if (fs.existsSync(fx)) {
      return { analysis: validateAnalysis(JSON.parse(fs.readFileSync(fx, 'utf8')), fx), analyzer: 'fixture', ref: toStoredPath(cfg, fx) };
    }
  }
  // Last resort, and the only one that works today: loudness from the FFmpeg already installed.
  // Weaker than structure analysis, so it runs only when nothing better is available, and it is
  // cached like the rest so the operator can see exactly what the suggestion was based on.
  if (ac.loudness?.enabled) {
    const src = fromStoredPath(cfg, asset.file_ref);
    if (!fs.existsSync(src)) return { analysis: null, reason: `clip file missing: ${asset.file_ref}` };
    const { analyzeLoudness } = require('./loudness');
    const got = analyzeLoudness(cfg, src);
    if (!got.analysis) return { analysis: null, reason: got.reason };
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(cached, JSON.stringify(got.analysis, null, 2), 'utf8');
    return { analysis: validateAnalysis(got.analysis, 'loudness'), analyzer: 'loudness', ref: toStoredPath(cfg, cached) };
  }
  return { analysis: null, reason: 'no analysis available (all-in-one disabled and no cached result)' };
}

/**
 * Permitted source-time window = intersection of every required category's permitted range.
 *
 * A personal-use clip is the exception, and only because it has no permissions by design
 * (PERSONAL-TEST-MODE): it is the operator's own file and the live path refuses it outright. There is
 * no permitted range to stay inside, so the window is the whole file. Nothing that matters is loosened
 * — a suggestion changes nothing until approved, and an approved one still cannot be published.
 */
function permittedWindow(cfg, asset) {
  if (asset.personal_use_only) return { window: [-Infinity, Infinity], scope: 'personal' };
  let lo = -Infinity, hi = Infinity;
  for (const cat of cfg.rights.requiredCategories) {
    const p = asset.permissions.find((x) => x.rights_category === cat);
    if (!p) return { window: null, reason: `[${cat}] permission missing — fix rights before choosing a segment` };
    if (p.permitted_start_sec == null || p.permitted_end_sec == null) return { window: null, reason: `[${cat}] permitted segment not stated` };
    lo = Math.max(lo, p.permitted_start_sec);
    hi = Math.min(hi, p.permitted_end_sec);
  }
  if (!(hi > lo)) return { window: null, reason: 'permitted ranges of the rights categories do not overlap' };
  return { window: [lo, hi], scope: 'permitted' };
}

/**
 * Pure function: picks the best labelled section inside the permitted window, snapped to downbeats.
 * Times in `analysis` are file times; `base` converts file → source time (source = base + fileTime).
 */
function suggestSegment(cfg, asset, analysis) {
  const { window, reason, scope } = permittedWindow(cfg, asset);
  if (!window) return { suggestion: null, reason };
  const where = scope === 'personal'
    ? 'whole file (personal-use clip — rights not verified, never publishable)'
    : `inside permitted ${window[0]}–${window[1]}s`;
  const base = asset.source_start_sec - asset.file_offset_sec;
  const fileDur = analysis.duration ?? Math.max(...analysis.segments.map((s) => s.end));
  const w0 = Math.max(0, window[0] - base), w1 = Math.min(fileDur, window[1] - base);
  if (!(w1 > w0)) return { suggestion: null, reason: `the clip file does not overlap the permitted range ${window[0]}–${window[1]}s` };

  const { labelPriority, minClipSec } = cfg.analysis;
  const maxClip = cfg.render.maxClipDurationSec;
  const downs = [...analysis.downbeats].sort((a, b) => a - b);
  const EPS = 0.05;

  for (const label of labelPriority) {
    const segs = analysis.segments.filter((s) => s.label === label).sort((a, b) => a.start - b.start);
    for (const seg of segs) {
      const lo = Math.max(seg.start, w0), hi = Math.min(seg.end, w1);
      if (hi - lo < minClipSec) continue;
      const snapped = downs.find((d) => d >= lo - EPS && d < hi);
      const start = snapped ?? lo;
      const limit = Math.min(hi, start + maxClip);
      let end = [...downs].reverse().find((d) => d <= limit + EPS && d - start >= minClipSec);
      const aligned = end != null;
      if (end == null) end = limit;
      if (end - start < minClipSec) continue;
      // Said exactly: an analyzer with no bar-line data (loudness) must not claim a downbeat cut.
      const cutNote = downs.length === 0
        ? 'at the measured boundaries (no bar-line data)'
        : `${snapped != null ? 'start on downbeat' : 'start at section boundary'}, ${aligned ? 'end on downbeat' : 'end at range limit'}`;
      return {
        suggestion: {
          label, file_start_sec: r3(start), file_end_sec: r3(end),
          source_start_sec: r3(base + start), source_end_sec: r3(base + end), bpm: analysis.bpm ?? null,
          notes: `${label} ${r3(seg.start)}–${r3(seg.end)}s in file; cut ${cutNote}; ${where}`,
        },
      };
    }
  }
  return { suggestion: null, reason: `no ${labelPriority.join('/')} section of ≥${minClipSec}s fits ${where}` };
}

/** Analyzes clip assets (all, or one asset_key) and stores new proposals. */
function analyzeAssets(db, cfg, { assetKey = null } = {}) {
  const rows = db.prepare(`SELECT id, candidate_id FROM clip_assets ${assetKey ? 'WHERE asset_key = ?' : ''} ORDER BY id`).all(...(assetKey ? [assetKey] : []));
  const out = [];
  for (const row of rows) {
    const asset = loadClipAssets(db, row.candidate_id).find((a) => a.id === row.id);
    const got = getAnalysis(cfg, asset);
    if (!got.analysis) { out.push({ asset_key: asset.asset_key, suggestion: null, reason: got.reason }); continue; }
    const { suggestion, reason } = suggestSegment(cfg, asset, got.analysis);
    if (!suggestion) { out.push({ asset_key: asset.asset_key, analyzer: got.analyzer, suggestion: null, reason }); continue; }
    const row2 = tx(db, () => {
      const ins = db.prepare(`INSERT OR IGNORE INTO segment_suggestions (clip_asset_id, analyzer, analysis_ref, label, suggested_start_sec, suggested_end_sec, file_start_sec, bpm, notes)
                              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(asset.id, got.analyzer, got.ref, suggestion.label, suggestion.source_start_sec, suggestion.source_end_sec, suggestion.file_start_sec, suggestion.bpm, suggestion.notes);
      const cur = db.prepare('SELECT * FROM segment_suggestions WHERE clip_asset_id = ? AND analyzer = ? AND suggested_start_sec = ? AND suggested_end_sec = ?')
        .get(asset.id, got.analyzer, suggestion.source_start_sec, suggestion.source_end_sec);
      db.prepare(`UPDATE segment_suggestions SET status = 'superseded' WHERE clip_asset_id = ? AND status = 'proposed' AND id <> ?`).run(asset.id, cur.id);
      return { ...cur, created: ins.changes > 0 };
    });
    out.push({ asset_key: asset.asset_key, analyzer: got.analyzer, suggestion: row2,
      alreadyApplied: asset.source_start_sec === row2.suggested_start_sec && asset.source_end_sec === row2.suggested_end_sec });
  }
  return out;
}

/**
 * Operator approval: the clip's intended range becomes the suggestion. Any not-yet-published reel using the clip
 * is marked pending so the next run of its date re-renders it on the same reel row (and re-checks rights).
 */
function approveSuggestion(db, cfg, suggestionId) {
  return tx(db, () => {
    const s = db.prepare('SELECT * FROM segment_suggestions WHERE id = ?').get(suggestionId);
    if (!s) throw new Error(`Suggestion ${suggestionId} not found`);
    if (s.status !== 'proposed') throw new Error(`Suggestion ${suggestionId} is ${s.status}, not proposed`);
    const live = db.prepare(`SELECT 1 FROM publish_jobs pj JOIN reels r ON r.id = pj.reel_id WHERE r.clip_asset_id = ? AND pj.mode = 'live'`).get(s.clip_asset_id);
    if (live) throw new Error('A live publish job already uses this clip; create a new clip asset instead of changing it');
    db.prepare('UPDATE clip_assets SET source_start_sec = ?, source_end_sec = ?, file_offset_sec = ? WHERE id = ?')
      .run(s.suggested_start_sec, s.suggested_end_sec, s.file_start_sec, s.clip_asset_id);
    db.prepare(`UPDATE segment_suggestions SET status = 'approved', decided_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`).run(s.id);
    db.prepare(`UPDATE segment_suggestions SET status = 'superseded' WHERE clip_asset_id = ? AND status = 'proposed'`).run(s.clip_asset_id);
    const reels = db.prepare(`UPDATE reels SET render_status = 'pending', updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
                               WHERE clip_asset_id = ? RETURNING id`).all(s.clip_asset_id).map((r) => r.id);
    return { suggestion: db.prepare('SELECT * FROM segment_suggestions WHERE id = ?').get(s.id), reelsToRerender: reels };
  });
}

function rejectSuggestion(db, suggestionId) {
  const r = db.prepare(`UPDATE segment_suggestions SET status = 'rejected', decided_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ? AND status = 'proposed'`).run(suggestionId);
  if (!r.changes) throw new Error(`Suggestion ${suggestionId} is not an open proposal`);
}

function suggestionsForCandidate(db, candidateId) {
  return db.prepare(`SELECT ss.*, ca.asset_key, ca.source_start_sec AS current_start_sec, ca.source_end_sec AS current_end_sec
                       FROM segment_suggestions ss JOIN clip_assets ca ON ca.id = ss.clip_asset_id
                      WHERE ca.candidate_id = ? ORDER BY ss.id DESC`).all(candidateId);
}

module.exports = { getAnalysis, permittedWindow, suggestSegment, analyzeAssets, approveSuggestion, rejectSuggestion, suggestionsForCandidate };
