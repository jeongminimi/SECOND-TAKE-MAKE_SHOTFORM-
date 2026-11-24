'use strict';
/**
 * First-pass segment suggestion from loudness alone, using the FFmpeg that is already installed.
 *
 * This is NOT music-structure analysis. It measures one RMS value per second and picks the window
 * that stays loudest. A loud passage is often the chorus and often is not — a long held note, a crowd
 * singing back, or a compressed outro all read the same. So the label is `peak`, never `chorus`, and
 * the screen calls it "소리가 가장 큰 구간 (후렴일 가능성)".
 *
 * It writes the same JSON shape all-in-one does, so nothing downstream changes: the suggestion still
 * has to fit inside the permitted rights window, and still changes nothing until an operator approves.
 * `downbeats` is empty because loudness says nothing about bar lines; suggestSegment handles that.
 */
const { spawnSync } = require('node:child_process');
const { ffmpegBin } = require('../render/ffmpeg');

const SILENT_DB = -120;

/**
 * One RMS reading per second. `asetnsamples` forces exactly one-second frames first, so a reading is
 * always a second of audio rather than however long the codec's frame happens to be.
 */
function rmsPerSecond(cfg, file) {
  const filter = 'aresample=44100,asetnsamples=n=44100:p=0,'
    + 'astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-';
  const r = spawnSync(ffmpegBin(cfg), ['-hide_banner', '-nostats', '-i', file, '-map', '0:a', '-af', filter, '-f', 'null', '-'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 300000, windowsHide: true });
  if (r.error) return { ok: false, reason: `ffmpeg could not be run: ${r.error.message}` };
  if (r.status !== 0) {
    const tail = (r.stderr ?? '').trim().split('\n').slice(-2).join(' | ');
    return { ok: false, reason: /does not contain any stream|Stream map/i.test(r.stderr ?? '') ? 'the clip file has no audio track' : `ffmpeg failed: ${tail}` };
  }
  const values = [];
  let t = null;
  for (const line of (r.stdout ?? '').split('\n')) {
    const pts = /pts_time:(-?[\d.]+)/.exec(line);
    if (pts) { t = Number(pts[1]); continue; }
    const rms = /lavfi\.astats\.Overall\.RMS_level=(-?[\d.]+|-?inf|nan)/.exec(line);
    if (rms && t != null) {
      const v = Number(rms[1]);
      values.push({ t, db: Number.isFinite(v) ? v : SILENT_DB });
      t = null;
    }
  }
  if (!values.length) return { ok: false, reason: 'ffmpeg reported no audio levels for this file' };
  return { ok: true, values };
}

/** dB readings → the mean level of a window, averaged as power rather than as decibels. */
function meanDb(slice) {
  const power = slice.reduce((a, x) => a + 10 ** (x.db / 10), 0) / slice.length;
  return power > 0 ? 10 * Math.log10(power) : SILENT_DB;
}

/**
 * @returns {{analysis: object}|{analysis: null, reason: string}} analysis in the all-in-one JSON shape
 */
function analyzeLoudness(cfg, file, { windowSec } = {}) {
  const span = Math.min(windowSec ?? cfg.render.defaultClipDurationSec ?? 25, cfg.render.maxClipDurationSec);
  const read = rmsPerSecond(cfg, file);
  if (!read.ok) return { analysis: null, reason: read.reason };

  const vals = read.values.sort((a, b) => a.t - b.t);
  const duration = vals[vals.length - 1].t + 1;
  const width = Math.min(span, vals.length);
  if (width < (cfg.analysis.minClipSec ?? 8)) {
    return { analysis: null, reason: `the clip file is only ${vals.length}s of audio, shorter than the ${cfg.analysis.minClipSec}s minimum` };
  }

  let best = { from: 0, db: -Infinity };
  for (let i = 0; i + width <= vals.length; i++) {
    const db = meanDb(vals.slice(i, i + width));
    if (db > best.db) best = { from: i, db };
  }
  const start = vals[best.from].t;
  const end = Math.min(duration, start + width);
  const overall = meanDb(vals);

  return {
    analysis: {
      analyzer: 'loudness',
      duration,
      bpm: null,
      downbeats: [],   // loudness says nothing about bar lines
      segments: [{ start, end, label: 'peak' }],
      measured: {
        windowSec: width,
        windowMeanDb: Math.round(best.db * 10) / 10,
        fileMeanDb: Math.round(overall * 10) / 10,
        rmsDbPerSec: vals.map((v) => Math.round(v.db * 10) / 10),
        note: 'RMS level per second from FFmpeg astats. Loudness only — this is not a music-structure analysis, '
          + 'and a loud passage is not necessarily the chorus.',
      },
    },
  };
}

module.exports = { analyzeLoudness, rmsPerSecond, meanDb };
