'use strict';
/**
 * Hashtags describe the performance, not a genre.
 *
 * `#kpop` was added to every caption, which was wrong output the moment the account posted a stage by
 * a singer from anywhere else. What the program can state from stored data is what kind of
 * performance it is and who is in it; which scene it belongs to is the operator's to type.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv } = require('./helpers');
const { hashtags, extraTags, buildCopy } = require('../src/copy/templates');
const entry = require('../src/ingest/manualEntry');
const { loadCandidate } = require('../src/selection/candidates');

const base = {
  candidate_key: 'P900-x', performer_en: 'Gracie Abrams', title_en: "That's So True",
  performance_type: 'live', arrangement_tags: [], channel_name: 'Gracie Abrams',
  official_url: 'https://www.youtube.com/watch?v=04GSqsX0S50', watch_cues: [],
};

// ── 7: nothing about K-pop is assumed ────────────────────────────────────────────────────────────
test('hashtags: no caption carries a genre nobody stated', () => {
  for (const c of [
    base,
    { ...base, performance_type: 'cover', original_artist_en: 'Lady Gaga' },
    { ...base, arrangement_tags: ['acoustic'] },
  ]) {
    const tags = hashtags(c);
    assert.ok(!tags.some((t) => /kpop/i.test(t)), `a genre was assumed: ${tags.join(' ')}`);
  }

  assert.ok(hashtags(base).includes('#livemusic'), 'a live stage is tagged as live music');
  assert.ok(hashtags({ ...base, performance_type: 'cover' }).includes('#cover'), 'a cover is tagged as a cover');
});

// ── 8: what is built from stored names is unchanged ──────────────────────────────────────────────
test('hashtags: the performer, the original artist and the version still produce their tags', () => {
  const cover = { ...base, performer_en: 'DK X SEUNGKWAN', performance_type: 'cover', original_artist_en: 'Lady Gaga', arrangement_tags: ['acoustic'] };
  const tags = hashtags(cover);
  assert.deepEqual(tags, ['#cover', '#acousticversion', '#dkxseungkwan', '#ladygaga']);

  // a name that cannot be written as a hashtag is left out rather than mangled
  assert.deepEqual(hashtags({ ...base, performer_en: '세븐틴' }), ['#livemusic']);
});

// ── 9: the operator's own tags come last, exactly as meant ───────────────────────────────────────
test('hashtags: operator-typed tags are appended after the generated ones', () => {
  const tags = hashtags(base, { extra: ['#kpop', 'seventeen'] });
  assert.deepEqual(tags, ['#livemusic', '#gracieabrams', '#kpop', '#seventeen'], 'typed tags follow, in the order typed');

  assert.deepEqual(extraTags({ extra_hashtags: '#kpop, #seventeen  라이브' }), ['#kpop', '#seventeen', '라이브'],
    'spaces and commas both separate');
  assert.deepEqual(extraTags({}), [], 'nothing typed is nothing added');

  // a duplicate of a generated tag is not printed twice, and punctuation Instagram cannot carry goes
  assert.deepEqual(hashtags(base, { extra: ['#livemusic', '#best-stage!'] }), ['#livemusic', '#gracieabrams', '#beststage']);
});

test('hashtags: what the operator typed reaches the caption through the database', async () => {
  const { db, cfg } = await makeEnv({}, { seed: false });
  const ch = entry.saveChannel(db, { platform: 'youtube', external_id: 'UC-HT', name: 'Hashtag Official (TEST)', is_test: 1 }).row;
  const video = entry.saveVideo(db, {
    channel_id: ch.id, platform: 'youtube', platform_video_id: 'HT-0001',
    official_url: 'https://www.example.com/watch?v=HT-0001', title: 'NOVA – Paper Lantern (Live Band Version)',
    published_at: '2026-11-20T09:00:00Z',
  }).row;
  const track = entry.saveTrack(db, { track_key: 'TR_HT', original_artist_en: 'NOVA', title_en: 'Paper Lantern', name_evidence: 'TEST: official title' }).row;
  const cand = entry.saveCandidate(db, {
    candidate_key: 'P900-ht', source_video_id: video.id, track_id: track.id,
    performer_en: 'NOVA', performance_type: 'live', arrangement_tags: ['band'],
    version_evidence: 'TEST: "Live Band Version" stated in the official title',
    extra_hashtags: '#kpop #seventeen',
  }).row;
  assert.equal(cand.extra_hashtags, '#kpop #seventeen', 'stored on the candidate, so the next reel keeps it');

  const c = loadCandidate(db, cand.id);
  const copy = buildCopy(c, { format: 'original_graphic', account: cfg.account });
  assert.match(copy.caption, /#kpop/, 'the typed tag is in the caption');
  assert.match(copy.caption, /#livemusic/, 'alongside the generated ones');
  assert.ok(copy.caption.indexOf('#livemusic') < copy.caption.indexOf('#kpop'), 'generated first, typed after');
});
