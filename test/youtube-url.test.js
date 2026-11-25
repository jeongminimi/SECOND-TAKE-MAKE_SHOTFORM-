'use strict';
/**
 * A pasted link as a head start on registration.
 *
 * The line these tests hold: a video title is a string someone typed into an upload form, so
 * everything read out of it is a suggestion. Nothing here may assert a source, fill in evidence, or
 * decide that a channel is official — and nothing here may write to the database.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { makeEnv, count } = require('./helpers');
const { parseYoutubeUrl, suggestFromTitle, fetchOembed, lookupYoutube } = require('../src/ingest/youtubeUrl');
const { createApp } = require('../src/web/server');

const ID = '04GSqsX0S50';

test('url: every shape YouTube hands out gives the same video, and the watching tail is dropped', () => {
  const forms = [
    `https://www.youtube.com/watch?v=${ID}`,
    `https://www.youtube.com/watch?v=${ID}&list=RD${ID}&start_radio=1`,
    `https://youtu.be/${ID}`,
    `https://youtu.be/${ID}?t=137`,
    `https://m.youtube.com/watch?v=${ID}&t=42s`,
    `youtube.com/watch?v=${ID}`,
  ];
  for (const f of forms) {
    const r = parseYoutubeUrl(f);
    assert.equal(r.videoId, ID, f);
    assert.equal(r.url, `https://www.youtube.com/watch?v=${ID}`, `${f}: the stored link carries no playlist or timestamp`);
  }
  assert.equal(parseYoutubeUrl('https://www.youtube.com/shorts/abcdefghijk').videoId, 'abcdefghijk');
  assert.equal(parseYoutubeUrl('https://www.youtube.com/live/ABCDEFGHIJK').videoId, 'ABCDEFGHIJK');
});

test('url: a link that is not a YouTube video is refused with a reason a person can act on', () => {
  const cases = [
    ['', /입력하세요/],
    ['   ', /입력하세요/],
    ['https://vimeo.com/12345', /유튜브 주소가 아닙니다/],
    ['https://www.youtube.com/watch?v=short', /11자/],
    ['https://www.youtube.com/', /영상 번호를 찾지 못했습니다/],
    ['https://www.youtube.com/@pledis17', /영상 번호를 찾지 못했습니다/],
  ];
  for (const [input, pattern] of cases) {
    assert.throws(() => parseYoutubeUrl(input), pattern, JSON.stringify(input));
  }
});

test('url: a title splits into performer, song and original artist — and stays empty when it does not', () => {
  const s = suggestFromTitle('[COVER] DK X SEUNGKWAN - Die With A Smile (Original Song : Lady Gaga, Bruno Mars)');
  assert.equal(s.performer_en, 'DK X SEUNGKWAN');
  assert.equal(s.title_en, 'Die With A Smile');
  assert.equal(s.original_artist_en, 'Lady Gaga, Bruno Mars');
  assert.equal(s.performance_type, 'cover');

  const live = suggestFromTitle('LUMINA – Starlight Avenue (Live Band Version)');
  assert.equal(live.performer_en, 'LUMINA');
  assert.equal(live.title_en, 'Starlight Avenue');
  assert.equal(live.performance_type, 'live');
  assert.deepEqual(live.arrangement_tags, ['band']);
  assert.ok(!('original_artist_en' in live), 'nothing in that title names an original artist');

  // nothing recognisable → nothing guessed
  for (const t of ['무제목 영상', '', '   ', 'vlog #12']) {
    const out = suggestFromTitle(t);
    assert.ok(!out.performer_en, `${t}: must not invent a performer`);
    assert.ok(!out.title_en, `${t}: must not invent a song`);
  }
});

test('url: nothing suggested ever counts as a source, and the channel is never assumed official', async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ title: '[COVER] A - B (Original Song : C)', author_name: 'SEVENTEEN', author_url: 'https://www.youtube.com/@pledis17', thumbnail_url: 'https://i.ytimg.com/x.jpg' }),
  });
  const r = await lookupYoutube(`https://youtu.be/${ID}`, { fetchImpl });

  for (const field of ['name_evidence', 'version_evidence', 'segment_evidence', 'why_watch_evidence', 'published_at', 'is_official']) {
    assert.ok(!(field in r.suggested), `${field} is a judgement, not something a title can fill in`);
    assert.ok(!(field in r), `${field} must not come back from a link lookup`);
  }
  assert.match(r.confirm, /공식 채널이 맞습니까/, 'the operator is asked, because the program cannot tell');
  assert.match(r.note, /확인 후 저장/);
  assert.equal(r.channel_name, 'SEVENTEEN', 'the name is reported as what YouTube says, not as proof');
});

test('url: a lookup that fails is an invitation to type it in, not an error', async () => {
  const dead = async () => { throw new Error('getaddrinfo ENOTFOUND'); };
  const r = await lookupYoutube(`https://youtu.be/${ID}`, { fetchImpl: dead });
  assert.equal(r.lookup_ok, false);
  assert.equal(r.video_id, ID, 'the link itself still parsed, so it can still be saved');
  assert.equal(r.normalized_url, `https://www.youtube.com/watch?v=${ID}`);
  assert.match(r.note, /직접 입력/);
  assert.deepEqual(r.suggested, {}, 'nothing is guessed when nothing was read');

  const missing = await fetchOembed('https://www.youtube.com/watch?v=x', { fetchImpl: async () => ({ ok: false, status: 404 }) });
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /찾지 못했습니다/);

  const slow = await fetchOembed('https://www.youtube.com/watch?v=x', {
    timeoutMs: 10,
    fetchImpl: (u, { signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))),
  });
  assert.equal(slow.ok, false);
  assert.match(slow.reason, /너무 느립니다/);
});

test('url: POST /api/entry/from-url reads only — the database is untouched', async () => {
  const { db, cfg } = await makeEnv();
  const before = ['source_channels', 'source_videos', 'tracks', 'performance_candidates', 'clip_assets', 'usage_permissions']
    .map((t) => [t, count(db, t)]);

  const server = http.createServer(createApp(cfg, db));
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (body) => {
    const r = await fetch(`${base}/api/entry/from-url`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  try {
    const bad = await post({ url: 'https://vimeo.com/1' });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /유튜브 주소가 아닙니다/);

    const ok = await post({ url: `https://www.youtube.com/watch?v=${ID}&list=RD${ID}` });
    assert.equal(ok.body.ok, true);
    assert.equal(ok.body.video_id, ID);
    assert.equal(ok.body.normalized_url, `https://www.youtube.com/watch?v=${ID}`);
    assert.ok('suggested' in ok.body);
    // Whether YouTube answered or not, the endpoint succeeds — the link alone is useful.
    assert.equal(typeof ok.body.lookup_ok, 'boolean');

    for (const [t, n] of before) assert.equal(count(db, t), n, `${t} must not change`);
  } finally {
    server.close();
  }
});
