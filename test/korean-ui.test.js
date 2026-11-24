'use strict';
/**
 * M1.5 — the screen speaks Korean, the account still speaks English.
 *
 * These two tests guard the line between them. Every verdict the operator reads must exist in both
 * languages, and nothing the operator reads may leak into what the account publishes.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv } = require('./helpers');
const { runDay } = require('../src/pipeline');
const { evaluateDate, previewCandidate } = require('../src/selection/selectDaily');
const { loadCandidate, loadClipAssets } = require('../src/selection/candidates');
const { json } = require('../src/db');
const T = require('../src/util/terms');

const HANGUL = /[ㄱ-ㆎ가-힣]/;
const hasKo = (s) => HANGUL.test(String(s ?? ''));
const nonEmpty = (s) => typeof s === 'string' && s.trim() !== '';

test('ko: every verdict the operator reads exists in English and Korean', async (t) => {
  const { db, cfg, ffmpeg } = await makeEnv();
  if (!ffmpeg) return t.skip('FFmpeg not available');

  const picked = await runDay(db, cfg, '2026-11-23');  // licensed_clip
  const graphic = await runDay(db, cfg, '2026-11-15'); // original_graphic, clips rejected
  const skipped = await runDay(db, cfg, '2026-09-26'); // nothing eligible

  // 1. selection verdicts
  for (const r of [picked, graphic]) {
    assert.ok(nonEmpty(r.selection.reason), 'English selection reason is kept');
    assert.ok(nonEmpty(r.selection.reason_ko), `Korean selection reason missing for ${r.selection.operating_date}`);
    assert.ok(hasKo(r.selection.reason_ko), 'the Korean field really is Korean');
  }
  assert.ok(nonEmpty(skipped.selection.skip_reason), 'English skip reason is kept');
  assert.ok(hasKo(skipped.selection.skip_reason_ko), 'skipping is explained in Korean');
  assert.match(skipped.selection.skip_reason, /no official English song title ×1/, 'the English wording tests rely on is unchanged');

  // 2. format verdicts, stored on the reel
  for (const r of [picked, graphic]) {
    assert.ok(nonEmpty(r.reel.format_reason), 'English format reason is kept');
    assert.ok(hasKo(r.reel.format_reason_ko), `Korean format reason missing for ${r.selection.operating_date}`);
  }
  assert.match(graphic.reel.format_reason, /expired/, 'the English wording tests rely on is unchanged');

  // 3. dry-run verdicts
  for (const r of [picked, graphic]) {
    assert.ok(nonEmpty(r.job.expected_status), 'English expected status is kept');
    assert.ok(hasKo(r.job.expected_status_ko), 'the dry-run outcome is explained in Korean');
    const plan = json.parse(r.job.plan_json, {});
    for (const c of plan.checks) {
      assert.ok(nonEmpty(c.label), 'every dry-run check keeps its English label');
      assert.ok(hasKo(c.label_ko), `dry-run check without Korean: ${c.label}`);
    }
    for (const n of plan.live_readiness) {
      assert.ok(nonEmpty(n.en) && hasKo(n.ko), `live-readiness note without both languages: ${JSON.stringify(n)}`);
    }
  }

  // 4. rights verdicts — both the failures and the passes
  const ev = evaluateDate(db, cfg, '2026-11-15');
  const withClips = ev.snapshot.filter((s) => s.clip?.assets.length);
  assert.ok(withClips.length, 'the fixture has candidates with clips to judge');
  for (const s of withClips) {
    for (const a of s.clip.assets) {
      assert.equal(a.reasons.length, a.reasons_ko.length, `${a.asset_key}: one Korean reason per English reason`);
      for (const r of a.reasons_ko) assert.ok(hasKo(r), `${a.asset_key}: rejection reason not in Korean: ${r}`);
      for (const c of a.checks) assert.ok(hasKo(c.label_ko), `${a.asset_key}: rights check without Korean: ${c.label}`);
    }
  }

  // 5. exclusions and score items, as the candidate table shows them
  for (const s of ev.snapshot) {
    for (const x of s.exclusions) {
      assert.ok(nonEmpty(x.text) && hasKo(x.text_ko), `exclusion ${x.code} needs both languages`);
    }
    for (const i of s.score?.items ?? []) {
      assert.ok(nonEmpty(i.reason) && hasKo(i.reason_ko), `score item ${i.key} needs both languages`);
    }
  }

  // 6. the registration preview, which is the first verdict a new operator ever sees
  const prev = previewCandidate(db, cfg, picked.selection.candidate_id, '2026-11-23');
  assert.ok(nonEmpty(prev.format_reason) && hasKo(prev.format_reason_ko), 'the preview explains the format in both languages');
});

test('ko: the reel title and caption stay English — only official Korean names appear in them', async (t) => {
  const { db, cfg, ffmpeg } = await makeEnv();
  if (!ffmpeg) return t.skip('FFmpeg not available');

  for (const date of ['2026-11-15', '2026-11-16', '2026-11-23']) {
    const r = await runDay(db, cfg, date);
    const { title_en, caption } = r.reel;

    assert.ok(!hasKo(title_en), `${date}: the on-screen title must be English only — got "${title_en}"`);

    // The caption may carry official Korean names (루미나 – 별빛 거리). Nothing else Korean belongs there.
    const c = loadCandidate(db, r.selection.candidate_id);
    const allowed = [c.performer_ko, c.title_ko, c.original_artist_ko].filter(Boolean);
    let stripped = caption;
    for (const name of allowed) stripped = stripped.split(name).join('');
    assert.ok(!hasKo(stripped), `${date}: caption contains Korean that is not an official name — "${stripped.match(new RegExp(`.{0,25}${HANGUL.source}.{0,25}`))?.[0]}"`);

    // And no screen vocabulary may have leaked into the published text.
    for (const map of Object.values(T.MAPS)) {
      for (const word of Object.values(map)) {
        assert.ok(!caption.includes(word), `${date}: screen wording "${word}" leaked into the caption`);
        assert.ok(!title_en.includes(word), `${date}: screen wording "${word}" leaked into the title`);
      }
    }

    // Hashtags are part of the product, so they stay ASCII too.
    for (const tag of caption.match(/#\S+/g) ?? []) {
      assert.ok(!hasKo(tag), `${date}: hashtag must be English — got ${tag}`);
    }
  }
});
