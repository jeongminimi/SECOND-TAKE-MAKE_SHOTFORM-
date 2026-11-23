'use strict';
/** Generates the self-made test clip that stands in for a licensed performance clip. No third-party media. */
const fs = require('node:fs');
const path = require('node:path');
const { run, ffmpegBin, resolveFont, filterScriptFlag, fv } = require('../render/ffmpeg');

async function ensureTestClip(cfg) {
  const dir = cfg.resolved.testAssets;
  const file = path.join(dir, 'sample_live_clip.mp4');
  if (fs.existsSync(file) && fs.statSync(file).size > 0) return { file, created: false };
  fs.mkdirSync(dir, { recursive: true });
  const font = resolveFont(cfg);
  fs.writeFileSync(path.join(dir, 'label.txt'), 'SELF-GENERATED TEST CLIP\nnot a real performance', 'utf8');
  const filter = `[0:v]drawtext=fontfile=${fv(font)}:textfile=label.txt:expansion=none:fontsize=54:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=18:x=(w-tw)/2:y=h*0.62:line_spacing=10,` +
    `drawtext=fontfile=${fv(font)}:text='%{pts\\:hms}':fontsize=40:fontcolor=yellow:x=40:y=40[v];` +
    `[1:a][2:a]amix=inputs=2:duration=shortest,volume=0.6[a]`;
  fs.writeFileSync(path.join(dir, 'filter.txt'), filter, 'utf8');
  await run(ffmpegBin(cfg), ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=60',
    '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=44100:duration=60',
    '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=44100:duration=60',
    filterScriptFlag(cfg), 'filter.txt', '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', 'sample_live_clip.mp4'], { cwd: dir });
  return { file, created: true };
}

module.exports = { ensureTestClip };
