'use strict';
/**
 * Exporting finished reels. The rule these tests exist for: exporting a second reel must not take the
 * first one away. Several reels are collected over days, and a folder that overwrites itself loses them.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { makeEnv } = require('./helpers');
const { runDay } = require('../src/pipeline');
const { exportReel, safeName } = require('../src/export/exportReel');
const { createApp } = require('../src/web/server');

test('export: each reel gets its own folder, and exporting one never removes another', async (t) => {
  const { db, cfg, ffmpeg } = await makeEnv();
  if (!ffmpeg) return t.skip('FFmpeg not available');

  const a = await runDay(db, cfg, '2026-11-15'); // original_graphic
  const b = await runDay(db, cfg, '2026-11-23'); // licensed_clip

  const first = exportReel(db, cfg, { reelId: a.reel.id });
  assert.equal(path.basename(path.dirname(first.dir)), '내보내기', 'exports live under output/내보내기');
  assert.ok(path.basename(first.dir).startsWith('2026-11-15_'), `folder is named by operating date + title: ${path.basename(first.dir)}`);

  const second = exportReel(db, cfg, { reelId: b.reel.id });
  assert.notEqual(second.dir, first.dir, 'a different reel lands in a different folder');
  assert.ok(fs.existsSync(first.dir), 'the earlier export is still there');
  assert.ok(fs.existsSync(path.join(first.dir, '읽어보기.txt')), 'and still complete');

  // the video is named after the headline, the other three keep their fixed names
  for (const r of [first, second]) {
    const names = fs.readdirSync(r.dir);
    const video = names.find((n) => n.endsWith('.mp4'));
    assert.ok(video, `${r.dir}: no video`);
    assert.equal(video, `${safeName(r.reel.title_en, `reel-${r.reel.id}`)}.mp4`);
    for (const fixed of ['첫화면.png', '인스타에_올릴_글.txt', '읽어보기.txt']) {
      assert.ok(names.includes(fixed), `${r.dir}: ${fixed} missing`);
    }
    assert.match(fs.readFileSync(path.join(r.dir, '읽어보기.txt'), 'utf8'), new RegExp(video.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      'the note names the video file as it was actually saved');
  }

  // re-exporting the same reel replaces only its own folder
  const again = exportReel(db, cfg, { reelId: a.reel.id });
  assert.equal(again.dir, first.dir);
  assert.ok(fs.existsSync(second.dir), 'the other reel survives a re-export');
});

test('export: a title Windows cannot use becomes a folder name it can', () => {
  assert.equal(safeName('A/B: "C" <D> | E?', 'fallback'), 'AB C D E');
  assert.equal(safeName('   ', 'reel-7'), 'reel-7', 'an empty title falls back to the reel id');
  assert.equal(safeName(null, 'reel-7'), 'reel-7');
  assert.equal(safeName('trailing dots...', 'x'), 'trailing dots', 'Windows rejects a trailing dot');
  assert.equal(safeName('a'.repeat(200), 'x').length, 80, 'a long title is cut, not refused');
  assert.ok(!/[\\/:*?"<>|]/.test(safeName('x\\y/z:*?"<>|', 'x')), 'no illegal character survives');
});

test('export: --to keeps using the exact folder it was given', async (t) => {
  const { db, cfg, ffmpeg, dir } = await makeEnv();
  if (!ffmpeg) return t.skip('FFmpeg not available');
  const r = await runDay(db, cfg, '2026-11-23');
  const target = path.join(dir, 'chosen-folder');
  const out = exportReel(db, cfg, { reelId: r.reel.id, dir: target });
  assert.equal(out.dir, target, 'an explicit path is used as-is, with no subfolder added');
  assert.ok(fs.readdirSync(target).some((n) => n.endsWith('.mp4')));
});

test('export: the button route exports a rendered reel and refuses one that is not rendered', async (t) => {
  const { db, cfg, ffmpeg } = await makeEnv();
  if (!ffmpeg) return t.skip('FFmpeg not available');
  const r = await runDay(db, cfg, '2026-11-23');
  const server = http.createServer(createApp(cfg, db));
  await new Promise((x) => server.listen(0, x));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (body) => {
    const res = await fetch(`${base}/api/export`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  try {
    const ok = await post({ reelId: r.reel.id });
    assert.equal(ok.body.ok, true, ok.body.error);
    assert.ok(fs.existsSync(ok.body.dir), 'the path the screen shows really exists');
    assert.ok(ok.body.files.some((f) => f.name.endsWith('.mp4') && f.bytes > 0));

    // a reel that has not been rendered is refused with a reason, not exported half-done
    db.prepare("UPDATE reels SET render_status = 'pending' WHERE id = ?").run(r.reel.id);
    const bad = await post({ reelId: r.reel.id });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /not rendered yet/);
  } finally {
    server.close();
  }
});
