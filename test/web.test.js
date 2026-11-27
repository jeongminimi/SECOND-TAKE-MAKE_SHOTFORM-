'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { makeEnv } = require('./helpers');
const { createApp } = require('../src/web/server');

test('6. local UI API: run a date, read candidate → score → rights → preview → caption → job, guide page', async (t) => {
  const { db, cfg, ffmpeg } = await makeEnv();
  if (!ffmpeg) return t.skip('FFmpeg not available');
  const server = http.createServer(createApp(cfg, db));
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const run = await (await fetch(`${base}/api/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date: '2026-11-23' }) })).json();
    assert.equal(run.ok, true);
    const day = await (await fetch(`${base}/api/day/2026-11-23`)).json();
    assert.equal(day.selection.status, 'selected');
    assert.equal(day.snapshot.length, 7);
    assert.equal(day.reel.output_format, 'licensed_clip');
    // v2.0 scores three things: version difference, English info, recent diversity.
    assert.deepEqual(day.selection.score_breakdown.items.map((i) => i.key), ['versionDifference', 'englishInfo', 'recentDiversity']);
    assert.match(day.reel.caption, /^LUMINA – Starlight Avenue \(Live Band Version\)/);
    assert.equal(day.jobs[0].status, 'simulated');
    const video = await fetch(base + day.reel.video_url);
    assert.equal(video.status, 200);
    assert.equal(video.headers.get('content-type'), 'video/mp4');
    const guide = await (await fetch(`${base}${day.reel.guide_page_path}`)).text();
    assert.match(guide, /t=134s/);
    assert.match(guide, /Watch the full official video from 2:14/);
    const again = await (await fetch(`${base}/api/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date: '2026-11-23' }) })).json();
    assert.equal(again.selectionReused, true);
    const home = await fetch(`${base}/`);
    assert.equal(home.status, 200);
  } finally {
    server.close();
  }
});

/**
 * The same API, built on the fallback server instead of Express.
 *
 * mini-express.js exists so the program runs with no npm install, and the first build really used it.
 * It only ever learns a method after server.js has already started using one, so without this the gap
 * shows up on a machine with no Express rather than here. Express is installed in CI, so the fallback
 * is passed in explicitly — that is the only way this path gets exercised.
 */
test('6b. the whole API also works on the built-in fallback server (no Express)', async (t) => {
  const { db, cfg, ffmpeg } = await makeEnv();
  if (!ffmpeg) return t.skip('FFmpeg not available');
  const mini = require('../src/web/mini-express');
  assert.equal(mini.isFallback, true, 'this must really be the fallback, not Express under another name');

  const server = http.createServer(createApp(cfg, db, mini));
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const json = async (p, opts) => (await fetch(base + p, opts)).json();
  try {
    const run = await json('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date: '2026-11-23' }) });
    assert.equal(run.ok, true, run.error);

    const ov = await json('/api/overview');
    assert.equal(ov.expressFallback, true, 'the screen is told which server it is talking to');
    assert.ok(ov.templates.length >= 4);

    const day = await json('/api/day/2026-11-23');
    assert.equal(day.reel.render_status, 'done');

    // the one that was broken: a binary response with a content type and an extra header
    const shot = await fetch(`${base}/api/reel/${day.reel.id}/crop-preview?template=clip-full&cropX=0.5&cropY=0.5&zoom=1.4`);
    const bytes = Buffer.from(await shot.arrayBuffer());
    assert.equal(shot.status, 200, bytes.toString('utf8').slice(0, 300));
    assert.equal(shot.headers.get('content-type'), 'image/jpeg', 'res.type("jpeg") must become a real media type');
    assert.equal(shot.headers.get('cache-control'), 'no-store', 'res.set must actually set a header');
    assert.equal(bytes[0], 0xFF);
    assert.equal(bytes[1], 0xD8);

    // static files, a video with a content type, and the registration API all still answer
    assert.equal((await fetch(`${base}/`)).status, 200);
    assert.equal((await fetch(base + day.reel.video_url)).headers.get('content-type'), 'video/mp4');
    assert.ok((await json('/api/entry/lists')).candidates.length > 0);

    const exported = await json('/api/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reelId: day.reel.id }) });
    assert.equal(exported.ok, true, exported.error);
  } finally {
    server.close();
  }
});

/**
 * The rebuilt screen is a rearrangement, not a rewrite of what the program can do.
 *
 * Two things are easy to lose when moving panels around: a route that nothing calls any more but
 * tests still rely on, and a word that is fine in the database and wrong on a screen a non-engineer
 * reads. Both are checked here rather than noticed later.
 */
test('6c. the rebuilt screen keeps every route, and shows no internal English on the page', async (t) => {
  const { db, cfg, ffmpeg } = await makeEnv();
  if (!ffmpeg) return t.skip('FFmpeg not available');
  const server = http.createServer(createApp(cfg, db));
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (p) => fetch(base + p);
  try {
    await (await fetch(`${base}/api/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date: '2026-11-23' }) })).json();
    const day = await (await get('/api/day/2026-11-23')).json();

    // every route the screen depends on, including the ones only the old layout used
    const routes = [
      '/api/overview', '/api/day/2026-11-23', '/api/candidates', '/api/entry/lists',
      '/api/entry/video-files', `/api/entry/preview/${day.selection.candidate_id}`,
      `/api/reel/${day.reel.id}/crop-preview`, '/guide', `/guide/${day.reel.id}`,
      '/', '/app.js', '/create.js', '/manage.js', '/terms.js', '/style.css',
      '/common.js', '/compose.js', '/edit.js',
    ];
    for (const r of routes) assert.equal((await get(r)).status, 200, `${r} must still answer`);

    for (const [p, body] of [
      ['/api/export', { reelId: day.reel.id }],
      ['/api/entry/from-url', { url: 'https://www.youtube.com/watch?v=04GSqsX0S50' }],
      ['/api/analyze', {}],
    ]) {
      const res = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal(res.status, 200, `${p} must still answer`);
    }

    // The page and its scripts are what the operator reads. Internal vocabulary belongs in the
    // database and in terms.js, not on screen.
    const INTERNAL = ['dry_run', 'render_status', 'ruleVersion', 'licensed_clip', 'original_graphic',
      'personal_use_only', 'is_test_asset', 'segment_evidence', 'expressFallback'];
    const page = await (await get('/')).text();
    for (const word of INTERNAL) assert.ok(!page.includes(word), `index.html shows "${word}" to the operator`);

    // ...and every internal value the screen receives has Korean to show instead of the raw value.
    // ko() hands back whatever it does not know, so "translated" means "came back different".
    const T = require('../src/util/terms');
    const translated = (kind, v) => v == null || T.ko(kind, v) !== v;
    const ov = await (await get('/api/overview')).json();
    assert.ok(translated('renderStatus', day.reel.render_status), `no Korean for render_status "${day.reel.render_status}"`);
    assert.ok(translated('format', day.reel.output_format), `no Korean for output_format "${day.reel.output_format}"`);
    assert.ok(translated('template', day.reel.template_id), `no Korean for template "${day.reel.template_id}"`);
    for (const j of day.jobs ?? []) {
      assert.ok(translated('jobStatus', j.status), `no Korean for job status "${j.status}"`);
      assert.ok(translated('mode', j.mode), `no Korean for mode "${j.mode}"`);
    }
    for (const tpl of ov.templates) {
      assert.ok(tpl.name && /[가-힣]/.test(tpl.name), `template ${tpl.id} has no Korean name for the picker`);
    }
    for (const s of ov.selections) {
      assert.ok(translated('selectionStatus', s.status), `no Korean for selection status "${s.status}"`);
    }

    // The page is the editor now: pick a file you already have, watch it inside the 9:16 frame, cut it.
    // index.html is only the shell — the panels beside the frame are built by edit.js — so each marker
    // is checked against the file it actually lives in.
    for (const marker of ['id="picker"', 'id="frame"', 'id="frameOuter"', 'id="transport"',
      'id="markIn"', 'id="markOut"', 'id="playSeg"', 'id="panel"',
      '/common.js', '/compose.js', '/edit.js']) {
      assert.ok(page.includes(marker), `the editor page is missing ${marker}`);
    }
    const editJs = await (await get('/edit.js')).text();
    for (const marker of ['<h3>글자', '<h3>모양</h3>', '<h3>영상 위치</h3>', '<h3>해시태그',
      '<h3>올릴 준비</h3>', '<h3>지난 작업</h3>', 'id="shotImg"', 'id="history"']) {
      assert.ok(editJs.includes(marker), `the editor's side panel is missing ${marker}`);
    }
    // The pipeline's own screens are still served — the routes above prove that — but the operator's
    // screen no longer loads them.
    for (const gone of ['id="runForm"', 'id="stepList"', 'id="managePanel"',
      '/app.js', '/create.js', '/manage.js']) {
      assert.ok(!page.includes(gone), `${gone} is the automatic pipeline's screen and should be off the page`);
    }
  } finally {
    server.close();
  }
});
