'use strict';
/**
 * How much of the 9:16 frame the clip fills, and where the text sits over it.
 *
 * A 16:9 clip at full width is 608px of 1920 — a third of the frame. That is the right answer when the
 * whole stage matters and the wrong one when a face does, so the operator picks per reel. These tests
 * hold two things: the old shape still renders exactly as it did, and the rights line survives every
 * new shape, including the one with almost no text on it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { makeEnv } = require('./helpers');
const { runDay } = require('../src/pipeline');
const { createApp } = require('../src/web/server');
const { videoBox, clipFilter } = require('../src/render/renderReel');
const { loadTemplate, listTemplates, drawTemplate, FilterBuilder } = require('../src/render/templateEngine');
const { loadConfig } = require('../src/config');

const cfg = loadConfig();
const CLIP_DATE = '2026-11-23';   // the seeded day that renders a licensed_clip

const filterOf = (id, reel = null) => clipFilter(cfg, videoBox(loadTemplate(id), reel), 'DRAWTEXT_CHAIN', 1);

// ── the shape that already existed must not move ─────────────────────────────────────────────────
test('video: clip-standard renders exactly as before — full width, original ratio, letterboxed at y=650', async (t) => {
  const f = filterOf('clip-standard');
  assert.match(f, /scale=1080:-2:force_original_aspect_ratio=decrease,setsar=1,fps=30/, 'unchanged scale');
  assert.match(f, /overlay=x=\(W-w\)\/2:y=650:shortest=1/, 'unchanged placement');
  assert.ok(!/crop=/.test(f), 'nothing is cropped');

  const { db, cfg: env, ffmpeg } = await makeEnv();
  if (!ffmpeg) return t.skip('FFmpeg not available');
  const r = await runDay(db, env, CLIP_DATE);
  assert.equal(r.reel.template_id, 'clip-standard', 'and it is still the default');
  assert.equal(r.reel.render_status, 'done', r.reel.render_error);
  const written = fs.readFileSync(path.join(env.resolved.output, 'reels', CLIP_DATE, `reel-${r.reel.id}`, 'filter.txt'), 'utf8');
  assert.match(written, /scale=1080:-2:force_original_aspect_ratio=decrease/);
  assert.match(written, /y=650/);

  // what that works out to on a 16:9 source: 1080 wide, 608 tall — a third of the 1920 frame
  const { probe } = require('../src/render/ffmpeg');
  const { fromStoredPath } = require('../src/config');
  const clip = db.prepare('SELECT file_ref FROM clip_assets WHERE id = ?').get(r.reel.clip_asset_id);
  const src = probe(env, fromStoredPath(env, clip.file_ref));
  assert.equal(Math.round(1080 / (src.width / src.height) / 2) * 2, 608, 'the letterboxed clip is 608px tall');
});

// ── the new shapes ───────────────────────────────────────────────────────────────────────────────
test('video: clip-full fills the frame and crops to 1080x1920 with no background layer', () => {
  const f = filterOf('clip-full');
  assert.match(f, /crop=1080:1920/, 'the frame is filled by cropping, not by stretching');
  assert.match(f, /scale=1080:1920:force_original_aspect_ratio=increase/);
  assert.ok(!/overlay=/.test(f), 'no background to overlay onto — the clip is the bottom layer');
  assert.ok(!/\[1:v\]/.test(f), 'and no background input is referenced');
  assert.match(f, /DRAWTEXT_CHAIN,format=yuv420p\[v\]/, 'text is drawn after the picture, so it lands on top');
});

test('video: clip-large keeps a box but fills it, cropping the sides', () => {
  const f = filterOf('clip-large');
  assert.match(f, /scale=1080:1200:force_original_aspect_ratio=increase/);
  assert.match(f, /crop=1080:1200/);
  assert.match(f, /overlay=x=\(W-w\)\/2:y=360:shortest=1/, 'it still sits in the frame at the template\'s y');
});

test('video: cropX 0, 0.5 and 1 each keep a different part of the picture', () => {
  const at = (v) => clipFilter(cfg, videoBox(loadTemplate('clip-full'), { crop_x: v }), 'C', 1);
  const [left, mid, right] = [at(0), at(0.5), at(1)];
  assert.match(left, /x=\(in_w-out_w\)\*0(?!\.)/);
  assert.match(mid, /x=\(in_w-out_w\)\*0\.5/);
  assert.match(right, /x=\(in_w-out_w\)\*1/);
  assert.equal(new Set([left, mid, right]).size, 3, 'three distinct filters');

  // out of range is clamped rather than passed to FFmpeg
  assert.equal(videoBox(loadTemplate('clip-full'), { crop_x: 5 }).cropX, 1);
  assert.equal(videoBox(loadTemplate('clip-full'), { crop_x: -2 }).cropX, 0);
  // the operator's stored choice wins over the template's default; NULL falls back to it
  assert.equal(videoBox({ video: { cropX: 0.25 } }, { crop_x: null }).cropX, 0.25);
  assert.equal(videoBox({ video: { cropX: 0.25 } }, { crop_x: 1 }).cropX, 1);
});

// ── drawing over the picture ─────────────────────────────────────────────────────────────────────
/** Renders a template's elements against stub data and returns the filter parts in order. */
function partsFor(tpl, over = {}) {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'tpl-'));
  const fb = new FilterBuilder(dir, 'C\\:/font.ttf');
  const data = {
    brand: 'SECOND TAKE', tag: 'COVER', headline: 'A headline', performerLine: 'A – B', koLine: '가 – 나',
    why: 'Because of the arrangement.', footer: 'Official source: X', credit: 'Clip used with permission · Y',
    cues: [], clipCues: [], ...over,
  };
  drawTemplate(fb, tpl, data, { accent: '0xFF5A3C', duration: 20 });
  return fb.parts;
}

test('video: shadow: true adds a drop shadow to the drawtext', () => {
  const withShadow = partsFor({ elements: [{ type: 'text', bind: 'headline', size: 60, y: 300, shadow: true }] });
  assert.match(withShadow[0], /:shadowcolor=black@0\.85:shadowx=3:shadowy=3/);

  const custom = partsFor({ elements: [{ type: 'text', bind: 'headline', size: 60, y: 300, shadow: { x: 6 } }] });
  assert.match(custom[0], /:shadowx=6:shadowy=3/, 'a partial override keeps the other defaults');

  const plain = partsFor({ elements: [{ type: 'text', bind: 'headline', size: 60, y: 300 }] });
  assert.ok(!/shadow/.test(plain[0]), 'and nothing is added when it was not asked for');
});

test('video: a scrim is drawn before the text that sits on it, and does not move the layout cursor', () => {
  const parts = partsFor({
    elements: [
      { type: 'scrim', y: 1400, h: 400, color: 'black', opacity: 0.45, from: 'bottom' },
      { type: 'text', bind: 'headline', size: 60, y: 1500 },
    ],
  });
  const firstText = parts.findIndex((p) => p.startsWith('drawtext'));
  const boxes = parts.filter((p) => p.startsWith('drawbox'));
  assert.ok(boxes.length >= 3, `a gradient scrim is drawn as several bands, got ${boxes.length}`);
  assert.ok(parts.indexOf(boxes[boxes.length - 1]) < firstText, 'every band comes before the text');
  assert.match(boxes[0], /drawbox=x=0:y=1400:w=1080:h=\d+:color=black@[\d.]+:t=fill/);

  // a flat scrim is a single band
  const flat = partsFor({ elements: [{ type: 'scrim', y: 0, h: 200, color: 'black', opacity: 0.5 }] });
  assert.equal(flat.length, 1);
  assert.match(flat[0], /color=black@0\.5/);

  // the cursor is untouched: a following `gap` element is positioned from the element before the scrim
  const seq = partsFor({
    elements: [
      { type: 'text', bind: 'brand', size: 40, y: 100 },
      { type: 'scrim', y: 1400, h: 400, color: 'black', opacity: 0.4 },
      { type: 'text', bind: 'headline', size: 40, gap: 0 },
    ],
  });
  const ys = seq.filter((p) => p.startsWith('drawtext')).map((p) => Number(/:y=(\d+)/.exec(p)[1]));
  assert.equal(ys[1], 148, `the text after the scrim follows the brand (100 + 48), got ${ys[1]}`);
});

// ── the rights line survives every shape ─────────────────────────────────────────────────────────
test('video: every clip template still draws the source and the rights line', () => {
  const clips = listTemplates().filter((t) => t.format === 'licensed_clip');
  assert.ok(clips.length >= 4, `expected the four clip shapes, got ${clips.map((t) => t.id)}`);
  for (const tpl of clips) {
    const binds = tpl.elements.map((e) => e.bind);
    assert.ok(binds.includes('credit'), `${tpl.id}: the rights line (credit) must be drawn`);
    assert.ok(binds.includes('footer'), `${tpl.id}: the official source (footer) must be drawn`);
    assert.ok(tpl.name && /[가-힣]/.test(tpl.name), `${tpl.id}: the operator reads this name, so it is Korean`);
    assert.ok(tpl.description && /[가-힣]/.test(tpl.description), `${tpl.id}: and its description`);

    // on a full-bleed shape the text lands on the picture, so it needs a scrim and shadows
    if (tpl.video?.fullBleed) {
      assert.ok(tpl.elements.some((e) => e.type === 'scrim'), `${tpl.id}: text over video needs a scrim`);
      for (const e of tpl.elements.filter((x) => x.type === 'text')) {
        assert.ok(e.shadow, `${tpl.id}: text over video needs shadow: true (${e.bind ?? e.value})`);
      }
    }
    const parts = partsFor(tpl);
    assert.ok(parts.some((p) => /t\d+\.txt/.test(p)), `${tpl.id}: nothing was drawn`);
  }
});

// ── the route ────────────────────────────────────────────────────────────────────────────────────
test('video: re-shaping a reel rebuilds the same row, and a wrong template is refused', async (t) => {
  const { db, cfg: env, ffmpeg } = await makeEnv();
  if (!ffmpeg) return t.skip('FFmpeg not available');
  const first = await runDay(db, env, CLIP_DATE);
  assert.equal(first.reel.render_status, 'done');

  const server = http.createServer(createApp(env, db));
  await new Promise((x) => server.listen(0, x));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (body) => {
    const res = await fetch(`${base}/api/reel/${first.reel.id}/template`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  try {
    const missing = await post({ template_id: 'clip-does-not-exist' });
    assert.equal(missing.status, 400);
    assert.match(missing.body.error, /not a template/);

    const wrongFormat = await post({ template_id: 'graphic-classic' });
    assert.equal(wrongFormat.status, 400);
    assert.match(wrongFormat.body.error, /is for original_graphic/);

    // the refusals changed nothing
    const untouched = db.prepare('SELECT template_id, render_status FROM reels WHERE id = ?').get(first.reel.id);
    assert.equal(untouched.template_id, 'clip-standard');
    assert.equal(untouched.render_status, 'done');

    const ok = await post({ template_id: 'clip-full', cropX: 1 });
    assert.equal(ok.body.ok, true, ok.body.error);
    assert.equal(ok.body.reel_id, first.reel.id, 'the same reel row is rebuilt, not a new one');
    assert.equal(ok.body.template_id, 'clip-full');
    assert.equal(ok.body.crop_x, 1);
    assert.equal(ok.body.render_status, 'done', ok.body.render_error);

    const row = db.prepare('SELECT * FROM reels WHERE id = ?').get(first.reel.id);
    assert.equal(row.crop_x, 1, 'the framing is stored on the reel');
    const probe = require('../src/render/ffmpeg').probe(env, require('../src/config').fromStoredPath(env, row.output_path));
    assert.equal(probe.width, 1080);
    assert.equal(probe.height, 1920);

    // the selection record is untouched: same day, same revision, same score
    const sel = db.prepare('SELECT * FROM daily_selections WHERE operating_date = ?').get(CLIP_DATE);
    assert.equal(sel.revision, first.selection.revision, 'the day was not selected again');
    assert.equal(sel.score, first.selection.score);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM reels').get().n, 1, 'and no extra reel was created');
  } finally {
    server.close();
  }
});
