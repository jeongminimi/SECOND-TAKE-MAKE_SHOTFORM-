'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const FONT_CANDIDATES = {
  win32: ['C:/Windows/Fonts/malgunbd.ttf', 'C:/Windows/Fonts/malgun.ttf', 'C:/Windows/Fonts/arialbd.ttf'],
  darwin: ['/System/Library/Fonts/AppleSDGothicNeo.ttc', '/Library/Fonts/Arial Unicode.ttf', '/System/Library/Fonts/Supplemental/Arial Bold.ttf'],
  linux: ['/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc', '/usr/share/fonts/noto-cjk/NotoSansCJK-Bold.ttc',
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'],
};

function resolveFont(cfg) {
  if (cfg.render.fontFile) {
    if (!fs.existsSync(cfg.render.fontFile)) throw new Error(`render.fontFile not found: ${cfg.render.fontFile}`);
    return cfg.render.fontFile;
  }
  const list = FONT_CANDIDATES[process.platform] ?? FONT_CANDIDATES.linux;
  const f = list.find((p) => fs.existsSync(p));
  if (!f) throw new Error(`No usable font found (tried ${list.join(', ')}). Set render.fontFile in config/local.json.`);
  return f;
}

/** Escapes a value for an ffmpeg filter option and quotes it for the filtergraph level. */
function fv(value) {
  const s = String(value).replace(/\\/g, '/');
  if (s.includes("'")) throw new Error(`Filter value may not contain a single quote: ${s}`);
  return `'${s.replace(/:/g, '\\:')}'`;
}

function ffmpegBin(cfg) { return cfg.render.ffmpegPath || 'ffmpeg'; }
function ffprobeBin(cfg) { return cfg.render.ffprobePath || 'ffprobe'; }

function checkFfmpeg(cfg) {
  const r = spawnSync(ffmpegBin(cfg), ['-hide_banner', '-version'], { encoding: 'utf8' });
  if (r.error) return { ok: false, error: `${ffmpegBin(cfg)}: ${r.error.code === 'ENOENT' ? 'not found on PATH' : r.error.message}` };
  if (r.status !== 0) return { ok: false, error: (r.stderr || '').slice(-400) };
  return { ok: true, version: r.stdout.split('\n')[0] };
}

const FILTER_FLAG = new Map();

/**
 * FFmpeg 8 removed -filter_complex_script; 7.0 added the generic "-/<option> <file>" form.
 * Picks the form the installed binary understands, so old and new builds both render.
 */
function filterScriptFlag(cfg) {
  const bin = ffmpegBin(cfg);
  if (FILTER_FLAG.has(bin)) return FILTER_FLAG.get(bin);
  const r = spawnSync(bin, ['-hide_banner', '-version'], { encoding: 'utf8' });
  const major = Number(/ffmpeg version n?(\d+)/.exec(r.stdout ?? '')?.[1]);
  const flag = Number.isFinite(major) && major >= 7 ? '-/filter_complex' : '-filter_complex_script';
  FILTER_FLAG.set(bin, flag);
  return flag;
}

function run(bin, args, { cwd, timeoutMs = 170000 } = {}) {
  return new Promise((resolve, reject) => {
    let stderr = '';
    let child;
    try { child = spawn(bin, args, { cwd, windowsHide: true }); } catch (e) { reject(e); return; }
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${bin} timed out after ${timeoutMs}ms`)); }, timeoutMs);
    child.stderr.on('data', (d) => { stderr += d; if (stderr.length > 20000) stderr = stderr.slice(-20000); });
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(`${bin}: ${e.code === 'ENOENT' ? 'not found on PATH' : e.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stderr });
      else reject(new Error(`${bin} exited with ${code}: ${stderr.split('\n').filter(Boolean).slice(-6).join(' | ')}`));
    });
  });
}

function probe(cfg, file) {
  const r = spawnSync(ffprobeBin(cfg), ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file], { encoding: 'utf8' });
  if (r.error || r.status !== 0) return null;
  const j = JSON.parse(r.stdout);
  const v = j.streams.find((s) => s.codec_type === 'video');
  const a = j.streams.find((s) => s.codec_type === 'audio');
  return {
    width: v?.width, height: v?.height, codec: v?.codec_name, pix_fmt: v?.pix_fmt, fps: v?.r_frame_rate,
    audio: a ? a.codec_name : null, duration: Number(j.format.duration), size: Number(j.format.size),
  };
}

module.exports = { resolveFont, fv, run, probe, checkFfmpeg, filterScriptFlag, ffmpegBin, ffprobeBin };
