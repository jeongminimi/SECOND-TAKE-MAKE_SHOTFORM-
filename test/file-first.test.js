'use strict';
/**
 * Starting from the file, which is how the work actually starts.
 *
 * The operator already has the performance on disk. Its file name is usually the video's title with
 * whatever Windows refuses replaced — so it can be read, and reading it saves retyping. What must
 * hold is that reading is never promotion to fact: a name that does not parse produces nothing, and
 * a video with no link is registered as having no link rather than one that was made up.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { makeEnv, count } = require('./helpers');
const entry = require('../src/ingest/manualEntry');
const { suggestFromFilename, plainTitle, findVideoFile } = require('../src/ingest/youtubeUrl');
const { createApp } = require('../src/web/server');

const PUBLISHED = '2026-11-20T09:00:00Z';

async function envWithVideos(files) {
  const env = await makeEnv({}, { seed: false });
  const dir = path.join(env.dir, 'videofolder');
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
  env.cfg.resolved.video = dir;
  return env;
}

// ── 1: the extension and the substituted punctuation are undone before anything is read ──────────
test('file-first: a file name is read back as the title it was made from', () => {
  assert.equal(plainTitle('[COVER] JOSHUA - double take (원곡 ： dhruv).mp4'), '[COVER] JOSHUA - double take (원곡 : dhruv)');
  assert.equal(plainTitle('[M⧸V] SEVENTEEN - Home.mkv'), '[M/V] SEVENTEEN - Home', 'the big solidus stands in for a slash');
  assert.equal(plainTitle('[4K] Blueming ｜ IU Palette.webm'), '[4K] Blueming | IU Palette');
  assert.equal(plainTitle('Say ＂hello＂.mov'), 'Say "hello"');
  assert.equal(plainTitle('no extension here'), 'no extension here', 'a name without one is left alone');

  // the extension is gone, so it never leaks into a suggested song title
  const s = suggestFromFilename('NOVA - Paper Lantern.mp4');
  assert.equal(s.title_en, 'Paper Lantern');
});

// ── 2: the shape the operator's own folder is full of ────────────────────────────────────────────
test('file-first: [COVER] A - B (Original Song : C) gives all four values', () => {
  const s = suggestFromFilename('[COVER] DK X SEUNGKWAN - Die With A Smile (Original Song ： Lady Gaga, Bruno Mars).mp4');
  assert.deepEqual(s, {
    performance_type: 'cover',
    performer_en: 'DK X SEUNGKWAN',
    title_en: 'Die With A Smile',
    original_artist_en: 'Lady Gaga, Bruno Mars',
  });

  // the Korean wording for the same thing reads the same way
  const ko = suggestFromFilename('[COVER] 도겸 - HAPPY (원곡 ： DAY6).mp4');
  assert.equal(ko.performance_type, 'cover');
  assert.equal(ko.original_artist_en, 'DAY6');

  // a plain live title is read as live, with no original artist invented
  const live = suggestFromFilename('Gracie Abrams - That\'s So True (Apple Music Live 2025).mp4');
  assert.equal(live.performance_type, 'live');
  assert.equal(live.performer_en, 'Gracie Abrams');
  assert.equal(live.original_artist_en, undefined, 'nothing says who wrote it, so nothing is claimed');
});

// ── 3: nothing is invented ───────────────────────────────────────────────────────────────────────
test('file-first: a name that does not parse suggests nothing at all', () => {
  for (const name of [
    "WONWOO X MINGYU 'Bittersweet (feat. LeeHi)' Official MV.mp4",   // no separator to split on
    'SEVENTEEN (세븐틴) \'MAESTRO\' Official MV.mp4',
    '같은 꿈, 같은 맘, 같은 밤.mp4',
    'Habit.mp4',
    'IMG_4821.mov',
    '.mp4',
    '',
  ]) {
    assert.deepEqual(suggestFromFilename(name), {}, `${name} must not produce a guess`);
  }
});

// ── 4: the list the screen reads carries it, and reading changes nothing ─────────────────────────
test('file-first: GET /api/entry/video-files carries suggested, and writes nothing', async () => {
  const { db, cfg } = await envWithVideos({
    '[COVER] JOSHUA - double take (원곡 ： dhruv).mp4': 'x',
    'Habit.mp4': 'x',
    'notes.txt': 'x',
  });
  const tables = ['source_channels', 'source_videos', 'tracks', 'performance_candidates', 'clip_assets', 'reels'];
  const before = tables.map((t) => [t, count(db, t)]);

  const server = http.createServer(createApp(cfg, db));
  await new Promise((r) => server.listen(0, r));
  try {
    const r = await (await fetch(`http://127.0.0.1:${server.address().port}/api/entry/video-files`)).json();
    assert.equal(r.ok, true);
    const byName = Object.fromEntries(r.files.map((f) => [f.name, f]));
    assert.equal(byName['[COVER] JOSHUA - double take (원곡 ： dhruv).mp4'].suggested.performer_en, 'JOSHUA');
    assert.equal(byName['[COVER] JOSHUA - double take (원곡 ： dhruv).mp4'].suggested.performance_type, 'cover');
    assert.deepEqual(byName['Habit.mp4'].suggested, {}, 'present but empty — the screen fills nothing in');
    for (const f of r.files) assert.ok(f.suggested && typeof f.suggested === 'object', `${f.name} must carry a suggested object`);

    for (const [t, n] of before) assert.equal(count(db, t), n, `${t} must not change`);
  } finally {
    server.close();
  }
});

// ── 5: a video with no link is storable, and says so ─────────────────────────────────────────────
test('file-first: a video registered with no link saves, with official_url left empty', async () => {
  const { db } = await makeEnv({}, { seed: false });
  const ch = entry.saveChannel(db, { platform: 'local', external_id: 'local-my-folder', name: 'My Folder (TEST)', is_test: 1 }).row;

  const saved = entry.saveVideo(db, {
    channel_id: ch.id, platform: 'local', platform_video_id: null, official_url: '',
    title: 'NOVA – Paper Lantern', published_at: PUBLISHED,
  });
  assert.equal(saved.row.official_url, '', 'no URL was invented');
  assert.ok(saved.warnings.some((w) => w.code === 'official_url_missing'), 'and the operator is told the record has no source link');
  assert.match(saved.warnings.find((w) => w.code === 'official_url_missing').ko, /출처 링크가 없습니다/);

  // a second link-less video must be its own row — not an overwrite of the first
  const second = entry.saveVideo(db, {
    channel_id: ch.id, platform: 'local', platform_video_id: null, official_url: '',
    title: 'NOVA – Second Stage', published_at: PUBLISHED,
  });
  assert.notEqual(second.row.id, saved.row.id, 'two link-less videos are two videos');
  assert.notEqual(second.row.platform_video_id, saved.row.platform_video_id, 'their dedupe keys differ');
  assert.equal(count(db, 'source_videos'), 2);

  // the published date is still required: it decides which day a performance is eligible for
  assert.throws(() => entry.saveVideo(db, {
    channel_id: ch.id, platform: 'local', official_url: '', title: 'No date', published_at: null,
  }), /published_at/);

  // and a link that IS given still has to be a real one
  assert.throws(() => entry.saveVideo(db, {
    channel_id: ch.id, platform: 'local', official_url: 'nova.example', title: 'Bad link', published_at: PUBLISHED,
  }), /official_url/);
});

// ── 6: the link wins over the file name, but never over the operator ─────────────────────────────
test('file-first: a lookup overwrites what a file name guessed, not what a person typed', () => {
  // The screen marks a guessed field and clears the mark when it is edited; this is that rule,
  // checked on the data it applies to rather than through a browser.
  const fromFile = suggestFromFilename('[M⧸V] SEVENTEEN(세븐틴) - Home.mp4');
  assert.equal(fromFile.performer_en, 'SEVENTEEN(세븐틴)');

  const apply = (form, suggestion) => {
    const out = { ...form };
    for (const [k, v] of Object.entries(suggestion)) {
      if (!v) continue;
      if (out[k]?.touched) continue;                 // typed by the operator — left alone
      out[k] = { value: v, touched: false };
    }
    return out;
  };
  const form = apply({}, fromFile);
  form.performer_en = { value: 'SEVENTEEN', touched: true };   // the operator fixes it

  const afterLookup = apply(form, { performer_en: 'SEVENTEEN (세븐틴)', title_en: 'Home (Official MV)' });
  assert.equal(afterLookup.performer_en.value, 'SEVENTEEN', 'the typed value survived the lookup');
  assert.equal(afterLookup.title_en.value, 'Home (Official MV)', 'the still-guessed value was replaced by the official title');
});

// ── 9-2: the side path — the link's video is looked for in the operator's own folder ─────────────
test('file-first: a pasted link finds its file by video id, then by title, and otherwise says so', async () => {
  const { cfg } = await envWithVideos({
    'Gracie Abrams - Thats So True [04GSqsX0S50].mp4': 'x',
    '[COVER] 도겸 - Lost Stars (원곡 ： Adam Levine).mp4': 'x',
  });
  const files = entry.listVideoFiles(cfg);

  const byId = findVideoFile(files, { videoId: '04GSqsX0S50', title: 'something else entirely' });
  assert.equal(byId.by, 'id', 'the id in the file name is proof and is tried first');

  const byTitle = findVideoFile(files, { videoId: 'ZZZZZZZZZZZ', title: '[COVER] 도겸 - Lost Stars (원곡 : Adam Levine)' });
  assert.equal(byTitle.by, 'title', 'otherwise the title, with the substituted punctuation undone');
  assert.match(byTitle.file.name, /Lost Stars/);

  assert.equal(findVideoFile(files, { videoId: 'ZZZZZZZZZZZ', title: 'A Stage Nobody Has' }), null,
    'not there is not there — nothing is fetched to make it so');
  assert.equal(findVideoFile([], { videoId: '04GSqsX0S50' }), null, 'an empty folder matches nothing');
});
