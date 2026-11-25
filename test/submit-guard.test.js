'use strict';
/**
 * 「등록하고 영상 만들기」 가 아무 반응 없이 실패하던 문제.
 *
 * Two things were true at once: the button unlocked in a state the server always refuses (an
 * arrangement tag with no source for it), and the refusal was written to #notice at the top of a page
 * whose button is at the bottom — while the line beside the button was actively cleared. So a press
 * looked like nothing at all.
 *
 * The rule is not the bug. These tests pin the server rule in place first, then check that the screen
 * refuses the same thing and that a refusal is readable where it happened.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { makeEnv } = require('./helpers');
const entry = require('../src/ingest/manualEntry');
const { createApp } = require('../src/web/server');
const { score } = require('../src/selection/scoring');
const { loadCandidate } = require('../src/selection/candidates');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'public', f), 'utf8');
const CREATE = read('create.js');

/** channel → video → track, so a candidate has something to hang on. */
function chain(db, { nameEvidence = 'TEST: official English title in the video title' } = {}) {
  const ch = entry.saveChannel(db, { platform: 'youtube', external_id: 'UC-GUARD', name: 'Guard Official (TEST)', is_test: 1 }).row;
  const video = entry.saveVideo(db, {
    channel_id: ch.id, platform: 'youtube', platform_video_id: 'GUARD-0001',
    official_url: 'https://www.example.com/watch?v=GUARD-0001', title: 'NOVA – Paper Lantern (Live Band Version)',
    published_at: '2026-11-20T09:00:00Z',
  }).row;
  const track = entry.saveTrack(db, {
    track_key: 'TR_GUARD', original_artist_en: 'NOVA', title_en: 'Paper Lantern', name_evidence: nameEvidence,
  }).row;
  return { video, track };
}

const candidateBody = (ids, over = {}) => ({
  source_video_id: ids.video.id, track_id: ids.track.id,
  performer_en: 'NOVA', performance_type: 'live', arrangement_tags: ['band'], ...over,
});

async function withServer(fn) {
  const { db, cfg } = await makeEnv({}, { seed: false });
  const server = http.createServer(createApp(cfg, db));
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (p, body) => {
    const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  try { await fn({ db, cfg, post }); } finally { server.close(); }
}

// ── 1: the rule the button has to mirror ─────────────────────────────────────────────────────────
test('submit: an arrangement tag with no version_evidence is refused, with the reason in Korean', async () => {
  await withServer(async ({ db, post }) => {
    const ids = chain(db);
    const r = await post('/api/entry/candidate', candidateBody(ids));
    assert.equal(r.status, 400);
    assert.equal(r.body.ok, false);
    assert.equal(r.body.issues[0].code, 'version_evidence_required');
    assert.equal(r.body.issues[0].level, 'block');
    assert.match(r.body.issues[0].ko, /편곡 태그.*출처.*적어야 합니다/, 'the Korean reason says what to do');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM performance_candidates').get().n, 0, 'and nothing was saved');
  });
});

// ── 2: no tag, no claim, so no source is needed ──────────────────────────────────────────────────
test('submit: with no arrangement tag the same candidate saves', async () => {
  await withServer(async ({ db, post }) => {
    const ids = chain(db);
    const r = await post('/api/entry/candidate', candidateBody(ids, { arrangement_tags: [] }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.row.arrangement_tags, '[]');
  });
});

// ── 3: the tag with its source saves ─────────────────────────────────────────────────────────────
test('submit: a tag together with the source it was read from saves', async () => {
  await withServer(async ({ db, post }) => {
    const ids = chain(db);
    const r = await post('/api/entry/candidate', candidateBody(ids, {
      version_evidence: 'TEST: "Live Band Version" stated in the official title',
    }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.row.version_evidence, 'TEST: "Live Band Version" stated in the official title');
  });
});

// ── 4: a missing name_evidence costs selection points, it does not block ─────────────────────────
test('submit: without name_evidence the candidate still saves, and loses the English-info points', async () => {
  await withServer(async ({ db, cfg, post }) => {
    const ids = chain(db, { nameEvidence: null });
    const r = await post('/api/entry/candidate', candidateBody(ids, { arrangement_tags: [] }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok((r.body.issues ?? []).every((i) => i.level !== 'block'), 'no blocking issue was raised');

    const c = loadCandidate(db, r.body.row.id);
    const item = score(c, { cfg, recentSelections: [] }).items.find((i) => i.key === 'englishInfo');
    assert.equal(item.points, 0, 'official spellings with no source do not count as official');
  });
});

// ── 5 + 7: the button refuses what the server refuses ────────────────────────────────────────────
test('submit: the button condition includes the version-evidence rule, and only when a tag is on', () => {
  const fn = /function refreshSubmit\(\) \{[\s\S]*?\n\}/.exec(CREATE)[0];
  assert.match(fn, /tagsChecked\(\)\.length > 0 && !cEl\('cVersionEv'\)/, 'a tag without its source locks the button');
  assert.match(fn, /\[!taggedWithoutSource, '편곡 태그 근거', 'cVersionEv'\]/, 'and it is listed by name among what is missing');
  assert.doesNotMatch(fn, /\[cEl\('cNameEv'\)\?\.value/, 'name_evidence never locks the button — it does not block a save');
  assert.match(fn, /cNameEv.*자동 선곡에서는 빠집니다/, 'it warns instead');

  // ticking a tag has to re-run the check, or the rule would only apply after some other edit
  assert.match(CREATE, /e\.target\.matches\?\.\('\[data-ctag\]'\)[\s\S]{0,80}refreshSubmit\(\)/);
  assert.match(CREATE, /'cVersionEv', 'cNameEv'[^\]]*\]\.includes\(e\.target\.id\)/, 'and so does typing the source');
});

// ── 6 + 8: a refusal is readable beside the button it came from ──────────────────────────────────
test('submit: a failed save writes the reason beside the button instead of clearing it', () => {
  const fn = /async function submitAll\(\) \{[\s\S]*?\n\}/.exec(CREATE)[0];
  const tail = fn.slice(fn.indexOf('} catch (e) {'));
  assert.doesNotMatch(tail, /say\(''\)/, 'the line beside the button is no longer wiped on failure');
  assert.match(tail, /cstate\.result = \{[\s\S]*err: true/, 'the failure is what the line now shows');
  assert.match(tail, /notice\(msg, true\)/, 'and the top-of-page notice stays as well');
  // refreshSubmit() runs in the finally, so it must not overwrite what the attempt just said
  assert.match(CREATE, /if \(cstate\.result\) \{ st\.textContent = cstate\.result\.text; return; \}/);
  assert.match(read('style.css'), /\.upstate\.err \{/, 'and it is styled as an error, not as grey progress text');
});

// ── 9: the Korean reason the server gives is the one the operator reads ──────────────────────────
test('submit: the screen shows issues[].ko, and the English message only when there is none', () => {
  const fn = /async function submitAll\(\) \{[\s\S]*?\n\}/.exec(CREATE)[0];
  assert.match(fn, /\(e\.issues \?\? \[\]\)\.filter\(\(i\) => i\.level === 'block'\)\.map\(\(i\) => i\.ko\)/);
  assert.match(fn, /reasons\.length \? reasons\.join\('\\n'\) : e\.message/, 'e.message is the fallback, not the first choice');
  // and the reasons survive the step wrapper that renames the error
  assert.match(fn, /err\.issues = e\.issues \?\? null/);
  assert.match(read('app.js'), /err\.issues = j\.issues \?\? null/, 'api() keeps them off the floor');
});

// ── C: nothing is written until the step with the evidence rules would pass ──────────────────────
test('submit: the candidate is checked before the first save, so a refusal leaves no half chain', async () => {
  await withServer(async ({ db, post }) => {
    // the check route is the one the screen calls first: it validates and writes nothing
    const r = await post('/api/entry/check/candidate', { performer_en: 'NOVA', arrangement_tags: ['band'], version_evidence: null });
    assert.equal(r.status, 200);
    const stops = r.body.issues.filter((i) => i.level === 'block' && i.field !== 'candidate_key');
    assert.equal(stops.length, 1);
    assert.equal(stops[0].code, 'version_evidence_required');
    for (const t of ['source_channels', 'source_videos', 'tracks', 'performance_candidates']) {
      assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n, 0, `${t} was written by a check`);
    }
  });

  const fn = /async function submitAll\(\) \{[\s\S]*?\n\}/.exec(CREATE)[0];
  const pre = fn.indexOf('/api/entry/check/candidate');
  assert.ok(pre > 0 && pre < fn.indexOf('/api/entry/channel'), 'the check happens before the first save');
  assert.match(fn, /let saved = false/);
  assert.match(fn, /채널·영상·곡은 이미 저장됐습니다/, 'and a later failure says what is already in the database');
});

// ── D: a stage taken from somewhere is registered with where it came from ────────────────────────
test('submit: one of the three kinds of source is required, and no placeholder stands in for it', () => {
  // the three choices, each with its own field on screen
  for (const kind of ['youtube', 'other', 'none']) {
    assert.match(CREATE, new RegExp(`name="cSrcKind" value="${kind}"`), `the ${kind} choice is offered`);
  }
  const need = /function sourceNeed\(\) \{[\s\S]*?\n\}/.exec(CREATE)[0];
  assert.match(need, /kind === 'youtube'.*normalized_url \? null : '유튜브 주소 가져오기'/, 'a YouTube stage needs its link');
  assert.match(need, /kind === 'other'.*isUrl\(cEl\('cSrcUrl'\)\?\.value\) \? null : '출처 주소'/, 'another site needs that address');
  assert.match(need, /val\('cSrcNote'\) \? null : '출처 \(어디서 얻었는지\)'/, 'and a self-shot video needs the line');
  assert.match(/function refreshSubmit\(\) \{[\s\S]*?\n\}/.exec(CREATE)[0], /\[!sourceNeed\(\), sourceNeed\(\), srcField\]/,
    'whichever it is, the button stays locked until it is there');

  // the operator is told exactly what their own line becomes
  assert.match(CREATE, /여기 쓴 글이 영상에 Source: ___ 으로 그대로 나갑니다/);

  // and nothing invents one
  assert.doesNotMatch(CREATE, /\?\? *'출처 미상'/, "nothing falls back to the '출처 미상' placeholder any more");
  assert.match(CREATE, /if \(!chName\) throw new Error\('출처를 적어야 합니다/, 'a save with no source at all is refused');
});

test('submit: a stage from another site saves with that address as its official link', async () => {
  await withServer(async ({ db, post }) => {
    const ch = await post('/api/entry/channel', { platform: 'local', external_id: 'local-KBS', name: 'KBS Kpop' });
    assert.equal(ch.status, 200, JSON.stringify(ch.body));
    const v = await post('/api/entry/video', {
      channel_id: ch.body.row.id, platform: 'local', platform_video_id: null,
      official_url: 'https://www.kbs.co.kr/stage/12345', title: 'NOVA – Paper Lantern',
      published_at: '2026-11-20T00:00:00Z',
    });
    assert.equal(v.status, 200, JSON.stringify(v.body));
    assert.equal(v.body.row.official_url, 'https://www.kbs.co.kr/stage/12345', 'the page it was published on is kept verbatim');
    assert.ok(!(v.body.issues ?? []).some((i) => i.code === 'official_url_missing'), 'and it no longer counts as source-less');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM source_videos').get().n, 1);
  });
});

// ── pressing a locked button goes to what is empty ───────────────────────────────────────────────
test('submit: a press with something still empty moves to that field and puts the cursor in it', () => {
  // the button has to receive the click, so it is locked by class and not by the disabled attribute
  const fn = /function refreshSubmit\(\) \{[\s\S]*?\n\}/.exec(CREATE)[0];
  assert.match(fn, /btn\.disabled = false/, 'a disabled button would swallow the press');
  assert.match(fn, /btn\.classList\.toggle\('locked', need\.length > 0\)/, 'it still looks unavailable');
  assert.match(fn, /btn\.setAttribute\('aria-disabled'/, 'and says so to a screen reader');
  assert.match(read('style.css'), /\.btn\.locked \{/);

  // the press jumps instead of saving
  assert.match(CREATE, /if \(cstate\.missing\?\.length\) \{ jumpToMissing\(\); return; \}/);
  const jump = /function jumpToMissing\(\) \{[\s\S]*?\n\}/.exec(CREATE)[0];
  assert.match(jump, /scrollIntoView\(\{ behavior: 'smooth', block: 'center' \}\)/, 'the field is brought on screen');
  assert.match(jump, /el\.focus\(/, 'and the cursor is put in it');

  // first in screen order, not in the order the checks happen to be written
  assert.match(fn, /cstate\.missing = missing\.map\(\[, , id\]\) ?=> ?id\)?/.source ? /cstate\.missing = missing\.map/ : /cstate\.missing/);
  assert.match(fn, /\.sort\(inScreenOrder\)/);
  assert.match(fn, /DOCUMENT_POSITION_FOLLOWING/);

  // every empty field is outlined, so the one jumped to is not the only clue
  assert.match(CREATE, /function markMissing\(ids\)/);
  assert.match(read('style.css'), /\.fld\.missing input/);

  // each entry carries the field the label refers to, including the one the source kind decides
  assert.match(fn, /\[cEl\('cPerformer'\)\?\.value\.trim\(\), '공연자', 'cPerformer'\]/);
  assert.match(fn, /\[!taggedWithoutSource, '편곡 태그 근거', 'cVersionEv'\]/);
  assert.match(fn, /srcField = \{ youtube: 'ytUrl', other: 'cSrcUrl', none: 'cSrcNote' \}/);
});
