'use strict';
/**
 * Where a file came from, read out of the file itself — so the operator does not search YouTube for a
 * link they already had when they downloaded it.
 *
 * The three places a download tool can leave it: the file name, a text file beside it, the container's
 * own metadata. None of it is treated as proof — the id found here goes through the same oEmbed lookup
 * a pasted link does, and the 「출처가 공식 채널이 맞습니다」 tick is still the operator's.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig } = require('../src/config');
const { sourceForFile, sourceFromName, idFromName, WHERE_KO } = require('../src/ingest/videoSource');
const { checkFfmpeg } = require('../src/render/ffmpeg');

const ID = 'dQw4w9WgXcQ';

function tmpdir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-source-'));
  test.after?.(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ── 1: the id in the file name ───────────────────────────────────────────────────────────────────
test('source: the shapes a download tool writes an id in are all read', () => {
  assert.equal(idFromName(`NOVA - Paper Lantern [${ID}].mp4`), ID, 'yt-dlp default');
  assert.equal(idFromName(`NOVA - Paper Lantern (${ID}).mkv`), ID, 'parentheses');
  assert.equal(idFromName(`NOVA - Paper Lantern ${ID}.mp4`), ID, 'a bare id at the end');

  // and nothing is read out of a name that does not carry one
  assert.equal(idFromName('[COVER] DK X SEUNGKWAN - Die With A Smile.mp4'), null);
  assert.equal(idFromName('Habit.mp4'), null);
  assert.equal(idFromName(''), null);
  assert.equal(idFromName('NOVA - Paper Lantern [tooshort].mp4'), null, 'eleven characters, not any bracket');
});

// ── 2: a text file beside the video ──────────────────────────────────────────────────────────────
test('source: an address in a text file next to the video is found', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'Paper Lantern.mp4'), 'not really a video');
  fs.writeFileSync(path.join(dir, 'Paper Lantern.txt'), `받은 날짜: 2026-11-20\nhttps://www.youtube.com/watch?v=${ID}\n`);

  const r = sourceFromName(dir, 'Paper Lantern.mp4');
  assert.equal(r.video_id, ID);
  assert.equal(r.url, `https://www.youtube.com/watch?v=${ID}`, 'the link is rebuilt from the id, not copied blindly');
  assert.equal(r.from, 'sidecar');
  assert.match(WHERE_KO[r.from], /텍스트 파일/, 'and the operator is told where it came from');

  // yt-dlp's own JSON works too
  const dir2 = tmpdir();
  fs.writeFileSync(path.join(dir2, 'A.mp4'), 'x');
  fs.writeFileSync(path.join(dir2, 'A.info.json'), JSON.stringify({ id: ID, webpage_url: `https://www.youtube.com/watch?v=${ID}` }));
  assert.equal(sourceFromName(dir2, 'A.mp4').video_id, ID);

  // a text file with no link in it is not a source
  const dir3 = tmpdir();
  fs.writeFileSync(path.join(dir3, 'B.mp4'), 'x');
  fs.writeFileSync(path.join(dir3, 'B.txt'), '세븐틴 무대. 나중에 쓸 것.');
  assert.equal(sourceFromName(dir3, 'B.mp4'), null);
});

// ── 3: the container's own metadata ──────────────────────────────────────────────────────────────
test('source: an address left in the video file itself is found', async (t) => {
  const cfg = loadConfig();
  if (!checkFfmpeg(cfg).ok) return t.skip('FFmpeg not available');
  const dir = tmpdir();
  const file = path.join(dir, 'metadata-only.mp4');
  // one black second, carrying the source page in `purl` — what -embed-metadata writes
  const { spawnSync } = require('node:child_process');
  // yt-dlp writes the source page into `purl`; this ffmpeg's mp4 muxer keeps `comment` and drops
  // `purl`, so the fixture writes both and either one counts.
  const made = spawnSync(cfg.render.ffmpegPath || 'ffmpeg', [
    '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:d=1',
    '-metadata', `purl=https://www.youtube.com/watch?v=${ID}`,
    '-metadata', `comment=https://www.youtube.com/watch?v=${ID}`, '-y', file,
  ], { encoding: 'utf8' });
  if (made.status !== 0) return t.skip(`could not build the fixture: ${made.stderr}`);

  const r = await sourceForFile(cfg, file);
  assert.equal(r.video_id, ID);
  assert.equal(r.from, 'metadata');
  assert.ok(['purl', 'comment'].includes(r.detail), `and which tag it was read from: ${r.detail}`);
});

// ── 4: the operator's real folder, as it is today ────────────────────────────────────────────────
test('source: a file with none of the three says so, rather than guessing', async () => {
  const cfg = loadConfig();
  const dir = tmpdir();
  const file = path.join(dir, 'Habit.mp4');
  fs.writeFileSync(file, 'x'); // not a video, so ffprobe fails — which must read as "nothing found"
  assert.equal(await sourceForFile(cfg, file), null, 'no id is invented for a file that carries none');
});
