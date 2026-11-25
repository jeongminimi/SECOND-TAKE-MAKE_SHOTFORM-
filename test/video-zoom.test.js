'use strict';
/**
 * Aiming the crop before committing to a render.
 *
 * Filling a 9:16 frame with a 16:9 clip throws away two thirds of the width, and with the default
 * centre crop one of two people on a stage can end up outside the picture. So the operator gets zoom
 * and an up/down crop, and — because a render takes tens of seconds — a single frame to aim with.
 *
 * The invariant underneath all of it: at zoom 1.0 nothing about the old filter changes, so every reel
 * rendered before this existed re-renders exactly as it did.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { makeEnv } = require('./helpers');
const { runDay } = require('../src/pipeline');
const { createApp } = require('../src/web/server');
const { videoBox, clipFilter, defaultTemplate, ZOOM_MIN, ZOOM_MAX } = require('../src/render/renderReel');
const { loadTemplate } = require('../src/render/templateEngine');
const { loadConfig } = require('../src/config');

const cfg = loadConfig();
const filterOf = (id, reel = null) => clipFilter(cfg, videoBox(loadTemplate(id), reel), 'CHAIN', 1);

test('zoom: 1.0 produces exactly the filter that existed before zoom did', () => {
  // the strings the 4순위 tests pinned, character for character
  assert.match(filterOf('clip-large'), /scale=1080:1200:force_original_aspect_ratio=increase,setsar=1,fps=30/);
  assert.match(filterOf('clip-large'), /crop=1080:1200:x=\(in_w-out_w\)\*0\.5:y=\(in_h-out_h\)\/2/);
  assert.match(filterOf('clip-full'), /scale=1080:1920:force_original_aspect_ratio=increase/);
  assert.match(filterOf('clip-full'), /crop=1080:1920:x=\(in_w-out_w\)\*0\.5:y=\(in_h-out_h\)\/2/);

  // an explicit zoom of 1 is the same as no zoom at all
  assert.equal(filterOf('clip-full', { zoom: 1 }), filterOf('clip-full'));
  assert.equal(filterOf('clip-full', { zoom: 1, crop_y: 0.5 }), filterOf('clip-full'));

  // contain keeps the whole picture, so it has nothing to crop and zoom does not touch it
  assert.equal(filterOf('clip-standard', { zoom: 2 }), filterOf('clip-standard'));
  assert.match(filterOf('clip-standard'), /scale=1080:-2:force_original_aspect_ratio=decrease/);
});

test('zoom: a zoomed scale is the box times the zoom, and always even', () => {
  const f = filterOf('clip-large', { zoom: 1.4 });
  assert.match(f, /scale=1512:1680:/, '1080x1200 at 1.4');
  assert.match(f, /crop=1080:1200:/, 'the box it is cropped back to does not change');

  // libx264 refuses odd dimensions, so every zoom must round to even
  for (const z of [1.1, 1.15, 1.3, 1.7, 1.9, 2.3, 2.5]) {
    for (const id of ['clip-large', 'clip-full']) {
      const [, w, h] = /scale=(\d+):(\d+):/.exec(filterOf(id, { zoom: z }));
      assert.equal(Number(w) % 2, 0, `${id} @${z}: width ${w} is odd`);
      assert.equal(Number(h) % 2, 0, `${id} @${z}: height ${h} is odd`);
    }
  }
});

test('zoom: out-of-range values are clamped, not passed to FFmpeg', () => {
  assert.equal(videoBox(loadTemplate('clip-full'), { zoom: 0.5 }).zoom, ZOOM_MIN);
  assert.equal(videoBox(loadTemplate('clip-full'), { zoom: 3.0 }).zoom, ZOOM_MAX);
  assert.equal(videoBox(loadTemplate('clip-full'), { zoom: 'nonsense' }).zoom, 1);
  assert.equal(videoBox(loadTemplate('clip-full'), { crop_y: 9 }).cropY, 1);
  assert.equal(videoBox(loadTemplate('clip-full'), { crop_y: -4 }).cropY, 0);
});

test('zoom: NULL on the reel means "not chosen" — the template decides, then the plain default', () => {
  const tpl = { video: { fullBleed: true, zoom: 1.6, cropY: 0.2 } };
  assert.equal(videoBox(tpl, { zoom: null, crop_y: null }).zoom, 1.6, 'the template value survives');
  assert.equal(videoBox(tpl, { zoom: null, crop_y: null }).cropY, 0.2);
  assert.equal(videoBox(tpl, { zoom: 2.0 }).zoom, 2.0, 'and the operator overrides it');
  assert.equal(videoBox({ video: { fullBleed: true } }, null).zoom, 1, 'neither set → 1.0');

  // a request-level framing beats both, which is what the preview sends
  assert.equal(videoBox(tpl, { zoom: 2.0 }, { zoom: 1.2 }).zoom, 1.2);
});

test('zoom: the up/down crop only shows in the filter once it can do something', () => {
  assert.match(filterOf('clip-full', { zoom: 1.8, crop_y: 0 }), /y=\(in_h-out_h\)\*0/);
  assert.match(filterOf('clip-full', { zoom: 1.8, crop_y: 1 }), /y=\(in_h-out_h\)\*1/);
  const a = filterOf('clip-full', { zoom: 1.8, crop_y: 0 });
  const b = filterOf('clip-full', { zoom: 1.8, crop_y: 1 });
  assert.notEqual(a, b, 'top and bottom keep different parts of the picture');
});

test('zoom: the crop preview returns one JPEG and writes nothing to the database', async (t) => {
  const { db, cfg: env, ffmpeg } = await makeEnv();
  if (!ffmpeg) return t.skip('FFmpeg not available');
  const r = await runDay(db, env, '2026-11-23');
  assert.equal(r.reel.render_status, 'done');

  const before = db.prepare('SELECT * FROM reels WHERE id = ?').get(r.reel.id);
  const beforeCounts = ['reels', 'daily_selections', 'publish_jobs'].map((t2) => db.prepare(`SELECT COUNT(*) n FROM ${t2}`).get().n);

  const server = http.createServer(createApp(env, db));
  await new Promise((x) => server.listen(0, x));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/api/reel/${r.reel.id}/crop-preview?template=clip-full&cropX=0.3&cropY=0.5&zoom=1.4`);
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.equal(res.status, 200, bytes.toString('utf8').slice(0, 300));
    assert.match(res.headers.get('content-type') ?? '', /image\/jpeg/);
    assert.ok(bytes.length > 5000, `a 1080x1920 frame should not be ${bytes.length} bytes`);
    assert.equal(bytes[0], 0xFF, 'JPEG magic');
    assert.equal(bytes[1], 0xD8);

    // nothing moved: not the reel row, not the counts, not the rendered file
    const after = db.prepare('SELECT * FROM reels WHERE id = ?').get(r.reel.id);
    assert.deepEqual(after, before, 'the preview must not touch the reel');
    assert.deepEqual(['reels', 'daily_selections', 'publish_jobs'].map((t2) => db.prepare(`SELECT COUNT(*) n FROM ${t2}`).get().n), beforeCounts);

    const bad = await fetch(`${base}/api/reel/999999/crop-preview`);
    assert.equal(bad.status, 400);
  } finally {
    server.close();
  }
});

test('zoom: an automatic run now produces the larger shape', () => {
  assert.deepEqual(cfg.render.templates.licensed_clip, ['clip-large']);
  assert.equal(defaultTemplate(cfg, 'licensed_clip'), 'clip-large');
  // clip-standard is still there to choose by hand, it just is not what you get by default
  assert.doesNotThrow(() => loadTemplate('clip-standard'));
});
