'use strict';
const T = require('../util/terms');

/**
 * Hard exclusions. Returns a list of reasons; empty list = eligible.
 * `text` is the English the tests and logs read; `text_ko` tells the operator what to fix.
 */
function exclusions(c, ctx) {
  const out = [];
  const ex = (code, text, text_ko) => out.push({ code, text, text_ko });
  if (!c.is_active) ex('candidate_inactive', 'Candidate was deactivated by the operator', '이 후보를 꺼 두셨습니다. 등록 화면에서 다시 켜면 선곡 대상이 됩니다.');
  if (!c.video_active) ex('video_inactive', `Source video "${c.video_title}" is inactive`, `원본 영상 "${c.video_title}"이(가) 꺼져 있습니다. 2단계에서 다시 켜면 해결됩니다.`);
  if (!c.channel_active) ex('channel_inactive', `Source channel "${c.channel_name}" is inactive`, `공식 채널 "${c.channel_name}"이(가) 꺼져 있습니다. 1단계에서 다시 켜면 해결됩니다.`);
  if (Date.parse(c.published_at) >= Date.parse(ctx.endOfDayUtc)) {
    ex('not_yet_published', `Official video published ${c.published_at}, after operating date ${ctx.operatingDate}`,
      `공식 영상이 ${T.day(c.published_at)}에 올라와, 운영일 ${ctx.operatingDate}에는 아직 공개 전입니다. 그날 이후 날짜로 실행하면 선곡됩니다.`);
  }
  if (!c.track_id) ex('no_track', 'Song not identified', '어떤 곡인지 연결되어 있지 않습니다. 4단계에서 곡을 고르면 해결됩니다.');
  if (!c.performer_en) ex('no_official_performer_en', 'No official English performer name (will not auto-romanize)', '공식 영문 공연자명이 없습니다. 로마자 표기를 지어내지 않으므로, 공식 표기를 찾아 넣어야 해결됩니다.');
  if (c.track_id && !c.title_en) ex('no_official_title_en', 'No official English song title (will not auto-translate)', '공식 영문 곡명이 없습니다. 번역해서 쓰지 않으므로, 3단계에서 공식 표기를 넣어야 해결됩니다.');
  if (!c.performance_type) ex('no_version', 'Performance type (live/cover) unknown', '공연 유형(라이브/커버)이 비어 있습니다. 4단계에서 고르면 해결됩니다.');
  if (!c.version_evidence) ex('version_unverified', 'Version not confirmed by an official source', '원곡과 어떻게 다른지가 공식 출처로 확인되지 않았습니다. 4단계의 "버전 근거"를 채우면 해결됩니다.');
  if (ctx.livePublished.has(c.id)) ex('already_published', 'Already published (live) before', '이미 실제로 게시한 적이 있는 후보입니다. 같은 영상을 두 번 올리지 않습니다.');
  return out;
}

function versionTags(c) {
  const tags = [...c.arrangement_tags];
  if (c.performance_type === 'cover') tags.unshift('cover');
  return [...new Set(tags)];
}

/**
 * How far this performance is from the original recording — the whole point of the account, so it
 * carries half the score. Three steps rather than a yes/no, because a cover of someone else's song and
 * a band rearrangement of your own are not the same find.
 *
 * A performance with no `version_evidence` never reaches scoring (it is excluded outright), so the
 * check here is a belt, not the braces.
 */
function versionTier(c, cfg) {
  const { versionTiers, differentiatingVersionTags } = cfg.selection;
  if (!c.version_evidence) return { tier: 'live', points: 0, tags: [] };
  if (c.performance_type === 'cover') {
    return { tier: 'cover', points: versionTiers.cover, tags: versionTags(c).filter((t) => differentiatingVersionTags.includes(t)) };
  }
  const arranged = (c.arrangement_tags ?? []).filter((t) => t !== 'cover' && differentiatingVersionTags.includes(t));
  if (arranged.length) return { tier: 'arrangement', points: versionTiers.arrangement, tags: arranged };
  return { tier: 'live', points: versionTiers.live, tags: [] };
}

const TIER_REASON = {
  cover: (v, c) => [
    `Cover of another artist's song (${v.tags.join(', ')}): ${c.version_evidence}`,
    `다른 아티스트의 곡을 커버한 무대입니다${v.tags.length ? ` (${v.tags.map((t) => T.ko('tag', t)).join(', ')})` : ''}. 이 계정이 가장 찾는 형태입니다.`,
  ],
  arrangement: (v, c) => [
    `Rearranged live version (${v.tags.join(', ')}): ${c.version_evidence}`,
    `원곡과 편곡이 다른 라이브입니다 (${v.tags.map((t) => T.ko('tag', t)).join(', ')}). 커버만큼은 아니지만 원곡과 다르게 들립니다.`,
  ],
  live: () => [
    'Straight live rendition — no cover and no arrangement difference',
    '원곡과 같은 구성의 단순 라이브입니다. 커버나 편곡이 다른 무대가 이 계정의 취지에 더 맞습니다.',
  ],
};

function score(c, ctx) {
  const { weights, diversityWindowDays } = ctx.cfg.selection;
  const items = [];

  const v = versionTier(c, ctx.cfg);
  const [vReason, vReasonKo] = TIER_REASON[v.tier](v, c);
  items.push({
    key: 'versionDifference', tier: v.tier,
    points: Math.min(v.points, weights.versionDifference), max: weights.versionDifference,
    reason: vReason, reason_ko: vReasonKo,
  });

  const eOk = Boolean(c.performer_en && c.title_en && c.name_evidence);
  items.push({
    key: 'englishInfo', points: eOk ? weights.englishInfo : 0, max: weights.englishInfo,
    reason: eOk ? `Official English names available: ${c.performer_en} / ${c.title_en}` : 'Official English performer or song name missing',
    reason_ko: eOk
      ? `공식 영문 표기가 모두 있습니다: ${c.performer_en} / ${c.title_en}`
      : '공식 영문 공연자명·곡명 또는 그 근거가 없습니다. 3·4단계에서 채우면 이 점수를 받습니다.',
  });

  // v2.0 removed the "timeliness" item: a song worth hearing again is usually an old video, so paying
  // for recency pushed the best-fitting candidates down. occasion_note / occasion_date / occasion_evidence
  // are still stored and still usable as caption material — they just no longer earn points.

  const recent = ctx.recentSelections.filter((s) => s.performer_en && c.performer_en && s.performer_en.toLowerCase() === c.performer_en.toLowerCase());
  const dOk = recent.length === 0;
  items.push({
    key: 'recentDiversity', points: dOk ? weights.recentDiversity : 0, max: weights.recentDiversity,
    reason: dOk ? `${c.performer_en} not selected in the previous ${diversityWindowDays} days` : `${c.performer_en} already selected on ${recent.map((r) => r.operating_date).join(', ')}`,
    reason_ko: dOk
      ? `${c.performer_en}은(는) 최근 ${diversityWindowDays}일 안에 소개한 적이 없습니다`
      : `${c.performer_en}을(를) ${recent.map((r) => r.operating_date).join(', ')}에 이미 소개했습니다. 같은 공연자가 연달아 나오지 않도록 감점됩니다.`,
  });

  return { total: items.reduce((a, i) => a + i.points, 0), max: items.reduce((a, i) => a + i.max, 0), items };
}

/** Deterministic order: score desc → official publish date desc → candidate_key asc. */
function compareRanked(a, b) {
  if (b.score.total !== a.score.total) return b.score.total - a.score.total;
  const pa = Date.parse(a.candidate.published_at), pb = Date.parse(b.candidate.published_at);
  if (pb !== pa) return pb - pa;
  return a.candidate.candidate_key < b.candidate.candidate_key ? -1 : a.candidate.candidate_key > b.candidate.candidate_key ? 1 : 0;
}

module.exports = { exclusions, score, compareRanked, versionTags, versionTier };
