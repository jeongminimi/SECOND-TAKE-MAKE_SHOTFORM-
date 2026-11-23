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
    assert.ok(day.selection.score_breakdown.items.length === 4);
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
