'use strict';
const { localDateOf, daysBetween } = require('../util/time');

/** Hard exclusions. Returns a list of reasons; empty list = eligible. */
function exclusions(c, ctx) {
  const out = [];
  if (!c.channel_active) out.push({ code: 'channel_inactive', text: `Source channel "${c.channel_name}" is inactive` });
  if (Date.parse(c.published_at) >= Date.parse(ctx.endOfDayUtc)) out.push({ code: 'not_yet_published', text: `Official video published ${c.published_at}, after operating date ${ctx.operatingDate}` });
  if (!c.track_id) out.push({ code: 'no_track', text: 'Song not identified' });
  if (!c.performer_en) out.push({ code: 'no_official_performer_en', text: 'No official English performer name (will not auto-romanize)' });
  if (c.track_id && !c.title_en) out.push({ code: 'no_official_title_en', text: 'No official English song title (will not auto-translate)' });
  if (!c.performance_type) out.push({ code: 'no_version', text: 'Performance type (live/cover) unknown' });
  if (!c.version_evidence) out.push({ code: 'version_unverified', text: 'Version not confirmed by an official source' });
  if (ctx.livePublished.has(c.id)) out.push({ code: 'already_published', text: 'Already published (live) before' });
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
  });

  const eOk = Boolean(c.performer_en && c.title_en && c.name_evidence);
  items.push({
    key: 'englishInfo', points: eOk ? weights.englishInfo : 0, max: weights.englishInfo,
    reason: eOk ? `Official English names available: ${c.performer_en} / ${c.title_en}` : 'Official English performer or song name missing',
  });

  const pubLocal = localDateOf(c.published_at, ctx.cfg.timezone);
  const age = daysBetween(pubLocal, ctx.operatingDate);
  let tOk = age >= 0 && age <= timelinessWindowDays;
  let tReason = tOk ? `Officially released ${age} day(s) before (${pubLocal}, window ${timelinessWindowDays}d)` : `Released ${age} days ago (outside ${timelinessWindowDays}d window)`;
  if (!tOk && c.occasion_date && c.occasion_evidence) {
    const oAge = daysBetween(c.occasion_date, ctx.operatingDate);
    if (oAge >= 0 && oAge <= timelinessWindowDays) { tOk = true; tReason = `Official occasion ${c.occasion_date}: ${c.occasion_note}`; }
  }
  items.push({ key: 'timeliness', points: tOk ? weights.timeliness : 0, max: weights.timeliness, reason: tReason });

  const recent = ctx.recentSelections.filter((s) => s.performer_en && c.performer_en && s.performer_en.toLowerCase() === c.performer_en.toLowerCase());
  const dOk = recent.length === 0;
  items.push({
    key: 'recentDiversity', points: dOk ? weights.recentDiversity : 0, max: weights.recentDiversity,
    reason: dOk ? `${c.performer_en} not selected in the previous ${diversityWindowDays} days` : `${c.performer_en} already selected on ${recent.map((r) => r.operating_date).join(', ')}`,
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
