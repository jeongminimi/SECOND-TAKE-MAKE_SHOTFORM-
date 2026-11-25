'use strict';
/**
 * Searching YouTube for the performance in a file, through the official Data API.
 *
 * No real key and no network: every call here is against a fixture response. That is deliberate — the
 * first call with a real key is the operator's to make (HANDOFF §0), and the API is paid for in quota.
 *
 * What the tests pin down is that it searches and nothing more: metadata only, one page, no choice
 * made for the operator, the key never echoed, and a clear answer when there is no key at all.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { makeEnv } = require('./helpers');
const { createApp } = require('../src/web/server');
const { searchYoutube, hasApiKey } = require('../src/ingest/youtubeSearch');

/** One page of search.list, shaped exactly as the API returns it. */
const FIXTURE = {
  kind: 'youtube#searchListResponse',
  items: [
    {
      id: { kind: 'youtube#video', videoId: '04GSqsX0S50' },
      snippet: {
        title: '[COVER] DK X SEUNGKWAN - Die With A Smile',
        channelTitle: 'SEVENTEEN',
        publishedAt: '2024-09-20T09:00:00Z',
        thumbnails: { medium: { url: 'https://i.ytimg.com/vi/04GSqsX0S50/mqdefault.jpg' } },
      },
    },
    {
      id: { kind: 'youtube#video', videoId: 'jpPBaNz7Nmk' },
      snippet: { title: 'Die With A Smile (Live)', channelTitle: 'Someone Else', publishedAt: '2025-01-02T00:00:00Z', thumbnails: {} },
    },
    { id: { kind: 'youtube#channel', channelId: 'UCxxxx' }, snippet: { title: 'A channel, not a video' } },
  ],
};

const fakeFetch = (captured) => async (url) => {
  captured.url = String(url);
  return { ok: true, json: async () => FIXTURE };
};
const cfgWithKey = { youtube: { apiKey: 'TEST-KEY-NOT-REAL', searchMaxResults: 5 } };

// ── 1: a search returns candidates, and only candidates ──────────────────────────────────────────
test('search: the API answer becomes a list of candidates the operator chooses from', async () => {
  const captured = {};
  const r = await searchYoutube('DK X SEUNGKWAN Die With A Smile', { cfg: cfgWithKey, fetchImpl: fakeFetch(captured) });

  assert.equal(r.items.length, 2, 'a channel in the results is not a video and is dropped');
  assert.deepEqual(r.items[0], {
    video_id: '04GSqsX0S50',
    url: 'https://www.youtube.com/watch?v=04GSqsX0S50',
    title: '[COVER] DK X SEUNGKWAN - Die With A Smile',
    channel_name: 'SEVENTEEN',
    published_at: '2024-09-20T09:00:00Z',
    thumbnail_url: 'https://i.ytimg.com/vi/04GSqsX0S50/mqdefault.jpg',
  });
  assert.equal(r.items[1].thumbnail_url, null, 'a missing thumbnail is missing, not a made-up URL');
  // nothing in the result says which one it is
  assert.ok(!Object.keys(r).includes('chosen') && !('best' in r.items[0]), 'the program picks none of them');
});

// ── 2: one page, videos only, the official endpoint ──────────────────────────────────────────────
test('search: it asks the official endpoint for exactly one page of videos', async () => {
  const captured = {};
  await searchYoutube('nova paper lantern', { cfg: cfgWithKey, fetchImpl: fakeFetch(captured) });
  const u = new URL(captured.url);
  assert.equal(u.origin + u.pathname, 'https://www.googleapis.com/youtube/v3/search');
  assert.equal(u.searchParams.get('type'), 'video');
  assert.equal(u.searchParams.get('part'), 'snippet', 'snippet only — no contentDetails, no statistics');
  assert.equal(u.searchParams.get('maxResults'), '5');
  assert.equal(u.searchParams.get('pageToken'), null, 'each extra page would cost another 100 units');
  assert.equal(u.searchParams.get('q'), 'nova paper lantern');
});

// ── 3: no key is a clear answer, not a crash ─────────────────────────────────────────────────────
test('search: without a key it says what to do, and the rest of the program is unaffected', async () => {
  assert.equal(hasApiKey({}), false);
  assert.equal(hasApiKey(cfgWithKey), true);

  const before = process.env.YOUTUBE_API_KEY;
  delete process.env.YOUTUBE_API_KEY;
  try {
    await assert.rejects(() => searchYoutube('anything', { cfg: {} }), (e) => {
      assert.equal(e.code, 'no_api_key');
      assert.match(e.ko, /config\/local\.json|YOUTUBE_API_KEY/, 'it names where the key goes');
      assert.match(e.ko, /유튜브에서 검색/, 'and that finding the link by hand still works');
      return true;
    });
  } finally {
    if (before !== undefined) process.env.YOUTUBE_API_KEY = before;
  }
});

// ── 4: a refused call is explained in Korean, without the key in it ──────────────────────────────
test('search: a quota refusal is explained, and the key is never echoed back', async () => {
  const refuse = async () => ({ ok: false, status: 403, json: async () => ({ error: { errors: [{ reason: 'quotaExceeded' }] } }) });
  await assert.rejects(() => searchYoutube('x', { cfg: cfgWithKey, fetchImpl: refuse }), (e) => {
    assert.equal(e.code, 'quotaExceeded');
    assert.match(e.ko, /하루 약 100회/, 'the operator is told the limit they hit');
    assert.match(e.ko, /자정/, 'and when it comes back');
    assert.ok(!e.message.includes('TEST-KEY-NOT-REAL') && !e.ko.includes('TEST-KEY-NOT-REAL'), 'the key stays out of the message');
    return true;
  });
});

// ── 5: the screen is told which of the two ways it can offer ─────────────────────────────────────
test('search: the file listing says whether in-page search is available at all', async () => {
  const { db, cfg } = await makeEnv({}, { seed: false });
  const server = http.createServer(createApp(cfg, db));
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const before = process.env.YOUTUBE_API_KEY;
  delete process.env.YOUTUBE_API_KEY;
  try {
    const list = await (await fetch(`${base}/api/entry/video-files`)).json();
    assert.equal(list.youtube_search, false, 'with no key the screen offers the search tab instead');

    const r = await fetch(`${base}/api/entry/youtube-search?q=test`);
    assert.equal(r.status, 501, 'not configured is not the same as a bad request');
    const body = await r.json();
    assert.equal(body.code, 'no_api_key');
    assert.match(body.error_ko, /API 키가 필요합니다/);
  } finally {
    if (before !== undefined) process.env.YOUTUBE_API_KEY = before;
    server.close();
  }
});

// ── 6: the screen never downloads, and never decides ─────────────────────────────────────────────
test('search: the screen offers candidates and waits — it does not fetch video files', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const create = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'public', 'create.js'), 'utf8');
  assert.match(create, /function useFound\(i\)/, 'a candidate becomes the address only when pressed');
  assert.match(create, /프로그램은 고르지 않습니다/, 'and the screen says so');
  assert.doesNotMatch(create, /googlevideo|yt-dlp|videoplayback/i, 'nothing here reaches for a video file');
  const search = fs.readFileSync(path.join(__dirname, '..', 'src', 'ingest', 'youtubeSearch.js'), 'utf8');
  assert.doesNotMatch(search, /googlevideo|videoplayback|ytdl|yt-dlp/i, 'and neither does the search itself');
  // the only two hosts it names: the official API it calls, and youtube.com for building a watch link
  assert.deepEqual([...new Set(search.match(/https:\/\/[\w.]+/g) ?? [])],
    ['https://www.googleapis.com', 'https://www.youtube.com'], 'no other host is contacted or linked');
  assert.match(search, /const SEARCH_URL = 'https:\/\/www\.googleapis\.com\/youtube\/v3\/search'/);
});
