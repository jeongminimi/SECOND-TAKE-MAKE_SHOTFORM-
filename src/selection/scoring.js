'use strict';
const { localDateOf, daysBetween } = require('../util/time');
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

function score(c, ctx) {
  const { weights, timelinessWindowDays, diversityWindowDays, differentiatingVersionTags } = ctx.cfg.selection;
  const items = [];

  const diffTags = versionTags(c).filter((t) => differentiatingVersionTags.includes(t));
  const vOk = diffTags.length > 0 && Boolean(c.version_evidence);
  items.push({
    key: 'versionDifference', points: vOk ? weights.versionDifference : 0, max: weights.versionDifference,
    reason: vOk ? `Version difference confirmed (${diffTags.join(', ')}): ${c.version_evidence}` : 'No cover/arrangement difference confirmed by the source',
    reason_ko: vOk
      ? `원곡과 다른 점이 확인됨 (${diffTags.map((t) => T.ko('tag', t)).join(', ')}): ${c.version_evidence}`
      : '원곡과 어떻게 다른지가 출처로 확인되지 않았습니다. 편곡 태그와 "버전 근거"를 채우면 이 점수를 받습니다.',
  });

  const eOk = Boolean(c.performer_en && c.title_en && c.name_evidence);
  items.push({
    key: 'englishInfo', points: eOk ? weights.englishInfo : 0, max: weights.englishInfo,
    reason: eOk ? `Official English names available: ${c.performer_en} / ${c.title_en}` : 'Official English performer or song name missing',
    reason_ko: eOk
      ? `공식 영문 표기가 모두 있습니다: ${c.performer_en} / ${c.title_en}`
      : '공식 영문 공연자명·곡명 또는 그 근거가 없습니다. 3·4단계에서 채우면 이 점수를 받습니다.',
  });

  const pubLocal = localDateOf(c.published_at, ctx.cfg.timezone);
  const age = daysBetween(pubLocal, ctx.operatingDate);
  let tOk = age >= 0 && age <= timelinessWindowDays;
  let tReason = tOk ? `Officially released ${age} day(s) before (${pubLocal}, window ${timelinessWindowDays}d)` : `Released ${age} days ago (outside ${timelinessWindowDays}d window)`;
  let tReasonKo = tOk
    ? `공식 공개 ${age}일 뒤입니다 (${pubLocal}, 기준 ${timelinessWindowDays}일 이내)`
    : `공식 공개로부터 ${age}일 지났습니다 (${timelinessWindowDays}일 기준 밖). 지금 소개할 공식적인 이유가 있다면 4단계의 "지금 소개할 이유"와 근거를 넣으면 이 점수를 받습니다.`;
  if (!tOk && c.occasion_date && c.occasion_evidence) {
    const oAge = daysBetween(c.occasion_date, ctx.operatingDate);
    if (oAge >= 0 && oAge <= timelinessWindowDays) {
      tOk = true;
      tReason = `Official occasion ${c.occasion_date}: ${c.occasion_note}`;
      tReasonKo = `공식적으로 확인된 계기 ${c.occasion_date}: ${c.occasion_note}`;
    }
  }
  items.push({ key: 'timeliness', points: tOk ? weights.timeliness : 0, max: weights.timeliness, reason: tReason, reason_ko: tReasonKo });

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

module.exports = { exclusions, score, compareRanked, versionTags };
