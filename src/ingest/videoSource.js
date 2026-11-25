'use strict';
/**
 * Where a file in storage/video came from, read out of the file itself.
 *
 * The operator puts the video there by hand, so the program has no idea what it was downloaded from —
 * and making them search YouTube again for a link they already had is the tedious part of registering
 * a performance. Most download tools can keep that link: in the file name, in a text file beside it,
 * or in the container's own metadata. This reads all three.
 *
 * It only ever READS. Nothing here downloads, moves or renames anything, and a video id found this way
 * is still only a suggestion — it is confirmed by looking the id up through oEmbed, exactly as a link
 * the operator pasted would be. A file name is not a source.
 *
 * Measured on the operator's own folder (2026-11-25): 29 files, 0 of them carry any of the three.
 * They were re-encoded on the way in, which strips metadata. So this helps the files that come next.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { ffprobeBin } = require('../render/ffmpeg');

/** A YouTube id is 11 characters of base64url. In brackets or parentheses, which is how tools write it. */
const ID_IN_NAME = /[[(]([A-Za-z0-9_-]{11})[\])]/;
/** A bare id at the end of a name, after a space or an underscore — yt-dlp's older default. */
const ID_AT_END = /[ _-]([A-Za-z0-9_-]{11})$/;
const ID_IN_URL = /(?:youtube\.com\/(?:watch\?(?:[^#]*&)?v=|shorts\/|live\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/;

const SIDECAR_EXT = ['.txt', '.url', '.webloc', '.info.json', '.json'];
/** Container tags that carry a URL. `purl` is the one ffmpeg writes for a source page. */
const URL_TAGS = ['purl', 'PURL', 'comment', 'description', 'synopsis', 'WWWAUDIOFILE'];

const idFrom = (s) => ID_IN_URL.exec(String(s ?? ''))?.[1] ?? null;
const urlFor = (id) => `https://www.youtube.com/watch?v=${id}`;

/** The id a file name carries, if it carries one. */
function idFromName(name) {
  const stem = String(name ?? '').replace(/\.[^.]+$/, '');
  return ID_IN_NAME.exec(stem)?.[1] ?? idFrom(stem) ?? ID_AT_END.exec(stem)?.[1] ?? null;
}

/**
 * A text file next to the video — `<name>.txt`, `.url`, `.info.json` — holding the address it came
 * from. Only the first YouTube link in it is read, and only the first 64 KB of it.
 */
function idFromSidecar(dir, name) {
  const stem = String(name ?? '').replace(/\.[^.]+$/, '');
  for (const ext of SIDECAR_EXT) {
    for (const candidate of [path.join(dir, stem + ext), path.join(dir, name + ext)]) {
      if (!fs.existsSync(candidate)) continue;
      let text = '';
      try {
        const fd = fs.openSync(candidate, 'r');
        const buf = Buffer.alloc(65536);
        const read = fs.readSync(fd, buf, 0, buf.length, 0);
        fs.closeSync(fd);
        text = buf.subarray(0, read).toString('utf8');
      } catch { continue; }
      const id = idFrom(text) ?? ID_IN_NAME.exec(text)?.[1] ?? null;
      if (id) return { video_id: id, url: urlFor(id), from: 'sidecar', detail: path.basename(candidate) };
    }
  }
  return null;
}

/** Everything that can be known without starting a process. Cheap enough to do for a whole folder. */
function sourceFromName(dir, name) {
  const id = idFromName(name);
  if (id) return { video_id: id, url: urlFor(id), from: 'filename', detail: name };
  return idFromSidecar(dir, name);
}

/**
 * The container's own metadata, which costs a process per file — so this is asked for one file at a
 * time, when the operator picks it, not for the whole folder.
 */
function sourceFromMetadata(cfg, file, { timeoutMs = 7000 } = {}) {
  return new Promise((resolve) => {
    const args = ['-v', 'error', '-show_entries', 'format_tags', '-of', 'json', file];
    execFile(ffprobeBin(cfg), args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      let tags = {};
      try { tags = JSON.parse(stdout)?.format?.tags ?? {}; } catch { return resolve(null); }
      for (const [key, value] of Object.entries(tags)) {
        if (!URL_TAGS.some((t) => t.toLowerCase() === key.toLowerCase())) continue;
        const id = idFrom(value);
        if (id) return resolve({ video_id: id, url: urlFor(id), from: 'metadata', detail: key });
      }
      resolve(null);
    });
  });
}

/** Name and sidecar first because they cost nothing; the container is read only if those say nothing. */
async function sourceForFile(cfg, file) {
  const cheap = sourceFromName(path.dirname(file), path.basename(file));
  if (cheap) return cheap;
  if (!fs.existsSync(file)) return null;
  return sourceFromMetadata(cfg, file);
}

const WHERE_KO = {
  filename: '파일 이름에 영상 번호가 있었습니다',
  sidecar: '파일 옆 텍스트 파일에 주소가 있었습니다',
  metadata: '영상 파일 안에 원본 주소가 남아 있었습니다',
};

module.exports = { sourceForFile, sourceFromName, sourceFromMetadata, idFromName, idFromSidecar, WHERE_KO };
