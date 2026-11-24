'use strict';
/**
 * Selection rules v2.0.
 *
 * The account's purpose settled: find songs worth hearing again as somebody else's performance. Two
 * things follow, and these tests hold them in place.
 *  - How far the performance is from the original is half the score, in three steps rather than yes/no.
 *  - Age earns nothing. A hidden gem is usually an old video, and the old scoring punished exactly that.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv } = require('./helpers');
const { score, versionTier } = require('../src/selection/scoring');
const { evaluateDate } = require('../src/selection/selectDaily');
const { loadCandidate } = require('../src/selection/candidates');
const { loadConfig } = require('../src/config');

const cfg = loadConfig();
const CTX = {
  cfg, operatingDate: '2026-11-25', mode: 'dry_run',
  livePublished: new Set(), recentSelections: [],
};

/** A candidate shaped the way loadCandidate returns one, with only what scoring reads. */
const cand = (over = {}) => ({
  id: 1, candidate_key: 'P-test', performer_en: 'NOVA', title_en: 'Paper Lantern',
  name_evidence: 'TEST: official title', version_evidence: 'TEST: stated in the official title',
  performance_type: 'live', arrangement_tags: [], published_at: '2020-01-01T00:00:00Z',
  ...over,
});

test('v2.0: a cover scores higher than a rearranged version, and a straight live rendition earns nothing', () => {
  const cover = score(cand({ performance_type: 'cover' }), CTX);
  const arranged = score(cand({ arrangement_tags: ['band'] }), CTX);
  const straight = score(cand(), CTX);

  const v = (s) => s.items.find((i) => i.key === 'versionDifference');
  assert.equal(v(cover).points, 50);
  assert.equal(v(arranged).points, 35);
  assert.equal(v(straight).points, 0);
  assert.ok(v(cover).points > v(arranged).points, 'a cover of another artist beats a rearrangement');
  assert.ok(v(arranged).points > v(straight).points, 'a rearrangement beats a straight rendition');

  assert.equal(v(cover).tier, 'cover');
  assert.equal(v(arranged).tier, 'arrangement');
  assert.equal(v(straight).tier, 'live');

  // the operator is told which step it landed on, in Korean
  assert.match(v(cover).reason_ko, /커버한 무대입니다/);
  assert.match(v(arranged).reason_ko, /편곡이 다른 라이브입니다/);
  assert.match(v(straight).reason_ko, /단순 라이브입니다/);
  for (const s of [cover, arranged, straight]) {
    for (const i of s.items) assert.ok(i.reason && i.reason_ko, `${i.key} needs both languages`);
  }
});

test('v2.0: a cover that is also rearranged stays on the top step', () => {
  const both = versionTier(cand({ performance_type: 'cover', arrangement_tags: ['acoustic'] }), cfg);
  assert.equal(both.tier, 'cover');
  assert.equal(both.points, 50, 'it does not add up, and it does not fall to the arrangement step');
});

test('v2.0: age earns nothing — an old video is not penalised for being old', () => {
  const old = score(cand({ performance_type: 'cover', published_at: '2017-03-01T00:00:00Z' }), CTX);
  const fresh = score(cand({ performance_type: 'cover', published_at: '2026-11-24T00:00:00Z' }), CTX);
  assert.equal(old.total, fresh.total, 'a 2017 video and yesterday\'s video score the same');

  assert.ok(!old.items.some((i) => i.key === 'timeliness'), 'the timeliness item is gone, not just zeroed');
  assert.ok(!('timeliness' in cfg.selection.weights), 'and so is its weight');

  // the occasion fields survive the removal: no longer scored, still stored for the caption
  for (const col of ['occasion_note', 'occasion_date', 'occasion_evidence']) {
    assert.ok(col in cand({ occasion_note: null, occasion_date: null, occasion_evidence: null }), `${col} must still exist`);
  }
});

test('v2.0: the three remaining items add up to exactly 100', () => {
  const s = score(cand({ performance_type: 'cover' }), CTX);
  assert.equal(s.max, 100);
  assert.equal(s.total, 100, 'a sourced cover with official English names and no recent repeat is full marks');
  assert.deepEqual(s.items.map((i) => [i.key, i.max]), [['versionDifference', 50], ['englishInfo', 30], ['recentDiversity', 20]]);
  assert.equal(Object.values(cfg.selection.weights).reduce((a, b) => a + b, 0), 100);
  assert.equal(cfg.selection.ruleVersion, 'v2.0');
});

test('v2.0: the seed data ranks covers above rearrangements, and nothing loses points for age', async () => {
  const { db } = await makeEnv();
  const ev = evaluateDate(db, loadConfig(), '2026-11-15');
  const ranked = ev.eligible.map((e) => ({
    key: e.candidate.candidate_key,
    total: e.score.total,
    tier: e.score.items.find((i) => i.key === 'versionDifference').tier,
  }));
  assert.ok(ranked.length >= 3, 'the fixture has enough eligible candidates to rank');
  for (let i = 1; i < ranked.length; i++) {
    assert.ok(ranked[i - 1].total >= ranked[i].total, 'ranking is by score, descending');
  }
  assert.equal(ranked[0].tier, 'cover', `a cover leads the ranking, got ${ranked[0].tier} (${ranked[0].key})`);
  assert.ok(ranked.some((r) => r.tier === 'arrangement' && r.total === 85), 'and a rearranged version sits at 85');
  assert.ok(ranked.every((r) => r.total <= 100));
});

test('v2.0: past selections keep the rule version they were made under', async () => {
  const { db } = await makeEnv();
  db.prepare(`INSERT INTO daily_selections (operating_date, status, skip_reason, rule_version)
              VALUES ('2026-01-01', 'skipped', 'TEST old record', 'v1.0')`).run();
  evaluateDate(db, loadConfig(), '2026-11-15');
  const old = db.prepare("SELECT rule_version FROM daily_selections WHERE operating_date = '2026-01-01'").get();
  assert.equal(old.rule_version, 'v1.0', 'a record of why a past day was picked is never rewritten');
});
