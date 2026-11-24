'use strict';
/**
 * 9:16 MP4 rendering with FFmpeg, driven by JSON templates (templates/reels/*.json).
 *  - original_graphic: fully self-made graphic + silent audio track. No third-party video, image or audio.
 *  - licensed_clip:    the registered (lawfully obtained) file, trimmed to the approved segment, letterboxed into 9:16.
 * Text is written to text files and passed with textfile= + expansion=none, so captions are never parsed as filter syntax.
 */
const fs = require('node:fs');
const path = require('node:path');
const { resolveFont, run, probe, filterScriptFlag, ffmpegBin } = require('./ffmpeg');
const { toStoredPath, fromStoredPath } = require('../config');
const { loadTemplate, drawTemplate, FilterBuilder, wrap, textWidth, BG } = require('./templateEngine');

const ACCENTS = { cover: '0x2EC4B6', band: '0xFF5A3C', acoustic: '0xF2B134', piano: '0xF2B134', unplugged: '0xF2B134', orchestra: '0x9B7BFF', jazz: '0x6FA8FF', live: '0xE8E8EE' };

/** Cues that fall inside the clip, re-timed to clip time. */
function clipCues(cues, clipAsset) {
  return (cues ?? [])
    .filter((q) => q.at_sec >= clipAsset.source_start_sec && q.at_sec < clipAsset.source_end_sec)
    .map((q) => ({ ...q, t: Math.round((q.at_sec - clipAsset.source_start_sec) * 100) / 100 }));
}

/**
 * @returns {Promise<{outputPath, posterPath, probe, templateId, layout}>} paths are project-relative when inside the project
 */
async function renderReel({ cfg, reel, copy, clipAsset, operatingDate, templateId }) {
  const W = cfg.render.width, H = cfg.render.height, FPS = cfg.render.fps;
  const tplId = templateId ?? reel.template_id ?? (reel.output_format === 'licensed_clip' ? 'clip-standard' : 'graphic-classic');
  const tpl = loadTemplate(tplId);
  if (tpl.format !== reel.output_format) throw new Error(`Template ${tplId} is for ${tpl.format}, reel is ${reel.output_format}`);

  const workDir = path.join(cfg.resolved.output, 'reels', operatingDate, `reel-${reel.id}`);
  const relDir = toStoredPath(cfg, workDir);
  fs.mkdirSync(workDir, { recursive: true });
  const font = resolveFont(cfg);
  const fb = new FilterBuilder(workDir, font);
  const g = copy.graphic;
  const accent = ACCENTS[g.versionKey] ?? ACCENTS.live;
  const args = ['-hide_banner', '-loglevel', 'error', '-y'];
  let filter, dur, layout;

  if (reel.output_format === 'original_graphic') {
    dur = tpl.durationSec ?? cfg.render.graphicDurationSec;
    args.push('-f', 'lavfi', '-i', `color=c=${BG}:s=${W}x${H}:r=${FPS}:d=${dur}`);
    args.push('-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo');
    args.push('-f', 'lavfi', '-i', `color=c=${accent}:s=${W}x10:r=${FPS}:d=${dur}`);
    layout = drawTemplate(fb, tpl, g, { accent, duration: dur });
    const bar = tpl.progressBar ? `[base][2:v]overlay=x='-W+W*t/${dur}':y=${H - 10}:shortest=1,` : '[base]';
    filter = `[0:v]${fb.chain()}[base];\n${bar}format=yuv420p[v]`;
    args.push(filterScriptFlag(cfg), 'filter.txt', '-map', '[v]', '-map', '1:a', '-t', String(dur));
  } else {
    if (!clipAsset) throw new Error('licensed_clip reel without clip asset');
    const src = fromStoredPath(cfg, clipAsset.file_ref);
    if (!fs.existsSync(src)) throw new Error(`Clip file missing: ${clipAsset.file_ref}`);
    const info = probe(cfg, src);
    if (!info) throw new Error(`Cannot probe clip file ${clipAsset.file_ref}`);
    dur = Math.round((clipAsset.source_end_sec - clipAsset.source_start_sec) * 1000) / 1000;
    args.push('-ss', String(clipAsset.file_offset_sec), '-t', String(dur), '-i', src);
    args.push('-f', 'lavfi', '-i', `color=c=${BG}:s=${W}x${H}:r=${FPS}:d=${dur}`);
    if (!info.audio) args.push('-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo');
    // The credit line is the one thing a viewer of the file itself sees, so a personal-use render says so.
    const credit = clipAsset.personal_use_only
      ? '개인 테스트용 · 권리 미확인 · 배포 불가'
      : `Clip used with permission · ${clipAsset.permissions.map((p) => p.rights_holder).filter(Boolean).join(' / ')}`;
    const data = { ...g, credit: credit.length > 90 ? credit.slice(0, 87) + '...' : credit, clipCues: clipCues(g.cues, clipAsset) };
    layout = drawTemplate(fb, tpl, data, { accent, duration: dur });
    filter = `[0:v]scale=${W}:-2:force_original_aspect_ratio=decrease,setsar=1,fps=${FPS}[clip];\n` +
      `[1:v][clip]overlay=x=(W-w)/2:y=${tpl.video?.y ?? 650}:shortest=1,\n${fb.chain()},format=yuv420p[v]`;
    args.push(filterScriptFlag(cfg), 'filter.txt', '-map', '[v]', '-map', info.audio ? '0:a' : '2:a', '-t', String(dur));
  }
  fs.writeFileSync(path.join(workDir, 'filter.txt'), filter, 'utf8');
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', String(FPS),
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-movflags', '+faststart', 'reel.mp4');

  await run(ffmpegBin(cfg), args, { cwd: workDir });
  await run(ffmpegBin(cfg), ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(Math.min(1.5, dur - 0.5)), '-i', 'reel.mp4', '-frames:v', '1', 'poster.png'], { cwd: workDir });
  const p = probe(cfg, path.join(workDir, 'reel.mp4'));
  if (!p || p.width !== W || p.height !== H) throw new Error(`Rendered file is not ${W}x${H}: ${JSON.stringify(p)}`);
  return { outputPath: `${relDir}/reel.mp4`, posterPath: `${relDir}/poster.png`, probe: p, templateId: tplId, layout };
}

module.exports = { renderReel, clipCues, wrap, textWidth };
