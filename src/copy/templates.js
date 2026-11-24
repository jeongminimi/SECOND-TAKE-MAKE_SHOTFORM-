'use strict';
/**
 * Deterministic English-first copy. Uses only stored, source-backed fields:
 * no auto-romanization, no translated titles, no invented lyrics/anecdotes/timestamps.
 */
const { fmtTimestamp } = require('../util/time');
const { versionTags } = require('../selection/scoring');

const TAG_LABEL = {
  band: 'Band', acoustic: 'Acoustic', orchestra: 'Orchestral', unplugged: 'Unplugged', piano: 'Piano',
  jazz: 'Jazz', a_cappella: 'A Cappella', rearranged: 'Rearranged',
};
const TAG_PHRASE = { band: 'live band', orchestra: 'orchestral', a_cappella: 'a cappella' };

const article = (w) => (/^[aeiou]/i.test(w) ? 'An' : 'A');
const primaryTag = (c) => c.arrangement_tags.find((t) => TAG_LABEL[t]) ?? null;

function versionLabel(c) {
  const tag = primaryTag(c);
  if (c.performance_type === 'cover') return tag ? `${TAG_LABEL[tag]} Cover` : 'Cover';
  if (!tag) return 'Live';
  if (tag === 'band') return 'Live Band Version';
  return `${TAG_LABEL[tag]} Live Version`;
}

/** First-screen headline: one line that makes the version difference obvious. */
function headline(c) {
  const tag = primaryTag(c);
  const song = c.title_en;
  if (c.performance_type === 'cover') {
    if (tag) { const p = (TAG_PHRASE[tag] ?? tag.replace('_', ' ')); return `${article(p)} ${p} cover of ${song}`; }
    return `${c.performer_en} covers ${song}`;
  }
  if (tag) return `The ${TAG_PHRASE[tag] ?? tag.replace('_', ' ')} version of ${song}`;
  return `${song}, live`;
}

function isCoverOfOther(c) {
  return c.performance_type === 'cover' && c.original_artist_en && c.original_artist_en.toLowerCase() !== c.performer_en.toLowerCase();
}

function hasVerifiedSegment(c) {
  return c.segment_start_sec != null && Boolean(c.segment_evidence);
}

/** Official URL, with a timestamp only when the segment is verified (official chapter etc.). */
function officialLink(c) {
  if (!hasVerifiedSegment(c)) return c.official_url;
  try {
    const u = new URL(c.official_url);
    u.searchParams.set('t', `${c.segment_start_sec}s`); // YouTube-style ?t=134s (works for watch and youtu.be URLs)
    return u.toString();
  } catch { return c.official_url; }
}

/** One English line on why this version is worth watching. Evidence-backed text, else a factual fallback. */
function whyLine(c) {
  if (c.why_watch_en && c.why_watch_evidence) return { text: c.why_watch_en, source: 'evidence' };
  const v = versionLabel(c).toLowerCase();
  const where = c.program_name ? ` from ${c.program_name}` : '';
  return { text: `${article(v)} ${v} of ${c.title_en}${where}.`, source: 'template_fact' };
}

/** Evidence-backed moments in the official video (cues without evidence are never shown). */
function watchCues(c) {
  return (c.watch_cues ?? []).filter((q) => q.evidence && q.text_en)
    .sort((a, b) => a.at_sec - b.at_sec)
    .map((q) => ({ at_sec: q.at_sec, label: fmtTimestamp(q.at_sec), text: q.text_en }));
}

function hashtags(c) {
  const tags = ['kpop'];
  tags.push(c.performance_type === 'cover' ? 'kpopcover' : 'kpoplive');
  const t = primaryTag(c);
  if (t) tags.push(`${t.replace('_', '')}version`);
  const slug = (s) => (s && /^[\x20-\x7E]+$/.test(s) ? s.toLowerCase().replace(/[^a-z0-9]/g, '') : null);
  for (const s of [slug(c.performer_en), isCoverOfOther(c) ? slug(c.original_artist_en) : null]) if (s && !tags.includes(s)) tags.push(s);
  return tags.map((x) => `#${x}`);
}

function buildCopy(c, { format, clipAsset = null, account }) {
  if (!c.performer_en || !c.title_en) throw new Error(`Candidate ${c.candidate_key} lacks official English names — copy refused`);
  const label = versionLabel(c);
  const title = headline(c);
  const why = whyLine(c);
  const link = officialLink(c);
  const ts = hasVerifiedSegment(c) ? fmtTimestamp(c.segment_start_sec) : null;
  const cues = watchCues(c);

  const lines = [];
  lines.push(`${c.performer_en} – ${c.title_en} (${label})`);
  if (c.performer_ko || c.title_ko) lines.push(`${c.performer_ko ?? c.performer_en} – ${c.title_ko ?? c.title_en}`);
  if (isCoverOfOther(c)) lines.push(`Originally by ${c.original_artist_en}${c.original_artist_ko ? ` (${c.original_artist_ko})` : ''}`);
  lines.push(`${c.program_name ? `${c.program_name} · ` : ''}Official source: ${c.channel_name}`);
  lines.push('');
  lines.push(`Why watch: ${why.text}`);
  if (ts) lines.push(`▶ The song starts at ${ts} in the official video.`);
  if (cues.length) {
    lines.push('');
    lines.push('Moments to watch (official video):');
    for (const q of cues) lines.push(`${q.label} — ${q.text}`);
  }
  lines.push('');
  lines.push(`Full official video: ${link}`);
  lines.push('');
  if (format === 'licensed_clip' && clipAsset?.personal_use_only) {
    // No permission was asked for, so the caption must not claim one.
    lines.push('Personal test render — not licensed for distribution.');
  } else if (format === 'licensed_clip' && clipAsset) {
    const holders = clipAsset.permissions.map((p) => `${p.rights_category}: ${p.rights_holder ?? 'n/a'}`).join('; ');
    lines.push(`Clip used with permission (${holders}).`);
  } else {
    lines.push(`Original graphic by ${account.displayName}. No performance footage or audio is used — watch the full stage at the official link.`);
  }
  lines.push('');
  lines.push(hashtags(c).join(' '));
  const caption = lines.join('\n');
  if (caption.length > 2200) throw new Error(`Caption is ${caption.length} chars (Instagram limit 2200)`);

  return {
    title_en: title,
    caption,
    official_link: link,
    version_label: label,
    why_line: why,
    timestamp_label: ts,
    graphic: {
      brand: account.displayName,
      tag: label.toUpperCase(),
      headline: title,
      performerLine: `${c.performer_en} – ${c.title_en}`,
      koLine: c.performer_ko || c.title_ko ? `${c.performer_ko ?? c.performer_en} – ${c.title_ko ?? c.title_en}` : null,
      originalLine: isCoverOfOther(c) ? `Originally by ${c.original_artist_en}` : null,
      why: why.text,
      timestamp: ts ? `Song starts at ${ts} in the official video` : null,
      footer: `${c.program_name ?? c.channel_name} · Full official video in caption`,
      cues,
      sourceLine: `${c.program_name ? `${c.program_name} · ` : ''}Official source: ${c.channel_name}`,
      cta: 'Full official video → link in caption',
      versionKey: c.performance_type === 'cover' ? 'cover' : (primaryTag(c) ?? 'live'),
    },
  };
}

/** Optional AI copy variation hook — disabled by default. Must keep names/links verbatim; never called in tests. */
async function aiVariation(/* copy, cfg */) {
  return null;
}

module.exports = { buildCopy, versionLabel, headline, officialLink, whyLine, hashtags, watchCues, aiVariation, versionTags };
