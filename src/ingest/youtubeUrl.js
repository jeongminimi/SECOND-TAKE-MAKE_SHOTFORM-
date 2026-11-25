'use strict';
/**
 * Turning a pasted YouTube link into a head start on the five registration steps.
 *
 * Two rules shape everything here.
 *
 * Nothing is downloaded. The URL is a record of where the performance officially lives and a way to
 * ask YouTube's public oEmbed endpoint what it is called. The video file itself is something the
 * operator already has; this never fetches one.
 *
 * Nothing extracted here is a fact yet. A title is a string someone typed into an upload form: it is
 * a good guess at the performer and the song and it is routinely wrong. So every field this produces
 * is a SUGGESTION the operator confirms, and none of it fills in `name_evidence`, `version_evidence`
 * or anything else that asserts a source. Deciding that a title proves something is a person's job.
 */
const OEMBED = 'https://www.youtube.com/oembed';
const ID = /^[A-Za-z0-9_-]{11}$/;

/**
 * Pulls the 11-character video id out of the shapes YouTube hands people, dropping playlist, radio
 * and timestamp tails.
 * @returns {{videoId: string, url: string}}
 */
function parseYoutubeUrl(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error('유튜브 주소를 입력하세요.');
  let u;
  try { u = new URL(raw.startsWith('http') ? raw : `https://${raw}`); } catch { throw new Error(`주소 형식이 아닙니다: ${raw}`); }

  const host = u.hostname.replace(/^www\./, '').toLowerCase();
  const seg = u.pathname.split('/').filter(Boolean);
  let id = null;
  if (host === 'youtu.be') id = seg[0] ?? null;
  else if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
    if (seg[0] === 'watch') id = u.searchParams.get('v');
    else if (['shorts', 'live', 'embed', 'v'].includes(seg[0])) id = seg[1] ?? null;
  } else {
    throw new Error(`유튜브 주소가 아닙니다: ${u.hostname}`);
  }

  if (!id) throw new Error('주소에서 영상 번호를 찾지 못했습니다. youtube.com/watch?v=... 또는 youtu.be/... 형태여야 합니다.');
  if (!ID.test(id)) throw new Error(`영상 번호가 11자가 아닙니다: ${id}`);
  // Everything after the id — &list=, &start_radio=, &t= — belongs to how it was being watched, not to
  // which video it is. The stored link is the plain one.
  return { videoId: id, url: `https://www.youtube.com/watch?v=${id}` };
}

const TAG_WORDS = {
  acoustic: 'acoustic', unplugged: 'unplugged', band: 'band', orchestra: 'orchestra', orchestral: 'orchestra',
  piano: 'piano', jazz: 'jazz', 'a cappella': 'a_cappella', acappella: 'a_cappella', rearranged: 'rearranged',
};

/** Bracketed or parenthesised chunks at either end of the title, which is where version labels live. */
function marks(title) {
  return [...String(title).matchAll(/[[(（【]([^\])）】]{1,40})[\])）】]/g)].map((m) => m[1].trim());
}

/**
 * Reads what it can out of a video title. Everything returned is a guess for a person to confirm.
 * A field it cannot read confidently is left out rather than filled with an approximation.
 */
function suggestFromTitle(title) {
  const t = String(title ?? '').trim();
  const out = { arrangement_tags: [] };
  if (!t) return {};   // nothing to read — and an empty tag list is still a field the form would fill

  const chunks = marks(t);
  const lower = (s) => s.toLowerCase();

  // cover vs live: stated in a bracket, or by the word "covers" in the sentence
  const says = (word) => chunks.some((c) => lower(c).includes(word)) || new RegExp(`\\b${word}\\b`, 'i').test(t);
  if (says('cover') || /\bcovers\b/i.test(t)) out.performance_type = 'cover';
  else if (says('live') || says('performance')) out.performance_type = 'live';

  for (const c of chunks) {
    for (const [word, tag] of Object.entries(TAG_WORDS)) {
      if (lower(c).includes(word) && !out.arrangement_tags.includes(tag)) out.arrangement_tags.push(tag);
    }
  }

  // "[COVER] DK X SEUNGKWAN - Die With A Smile (Original Song : Lady Gaga, Bruno Mars)"
  //          └ performer ┘   └──── song ────┘  └──────── original artist ────────┘
  const body = t.replace(/^\s*[[(（【][^\])）】]*[\])）】]\s*/, '').trim();
  const dash = /\s+[-–—]\s+/.exec(body);
  if (dash) {
    const performer = body.slice(0, dash.index).trim();
    const rest = body.slice(dash.index + dash[0].length);
    const song = rest.split(/\s*[[(（【]/)[0].trim();
    if (performer) out.performer_en = performer;
    if (song) out.title_en = song;
  }

  const original = /(?:original\s*(?:song|artist|by)|원곡)\s*[:：]?\s*([^)\]）】]+)/i.exec(t);
  if (original) out.original_artist_en = original[1].trim().replace(/[.,;\s]+$/, '');

  if (!out.arrangement_tags.length) delete out.arrangement_tags;
  return out;
}

const VIDEO_EXT_RE = /\.(mp4|mov|mkv|webm|m4v|avi)$/i;
/**
 * Characters a download tool put in the name because Windows refuses the real ones. NFKC undoes the
 * full-width substitutions (`：` `｜` `＂`); the solidus look-alikes have no compatibility mapping, so
 * they are listed. Everything here is a stand-in for punctuation the original title actually had.
 */
const LOOKALIKES = { '⧸': '/', '∕': '/', '⁄': '/', '＼': '\\', '﹖': '?', '﹗': '!', '˸': ':' };

/**
 * The title as it was before a file name had to be made out of it.
 * Used both for reading a file name and for comparing one against a title YouTube reports.
 */
function plainTitle(name) {
  return String(name ?? '')
    .replace(VIDEO_EXT_RE, '')
    .normalize('NFKC')
    .replace(/[⧸∕⁄＼﹖﹗˸]/g, (c) => LOOKALIKES[c] ?? c)
    .trim();
}

/**
 * The same reading applied to a file the operator already has. A file name is a weaker source than an
 * official title — it was mangled to be storable — so this is a suggestion like any other, and a name
 * it cannot read produces an empty object rather than a guess.
 */
function suggestFromFilename(name) {
  return suggestFromTitle(plainTitle(name));
}

/** Loose comparison key: what is left of a title once nothing but its letters and digits matter. */
const compareKey = (s) => plainTitle(s).toLowerCase().replace(/[^a-z0-9가-힣]+/g, '');

/**
 * Finds the operator's own copy of a video they pasted a link to. The id is proof; the title is a
 * guess, so it is only tried when no file name carries the id, and only as containment either way.
 * @returns {{file: object, by: 'id'|'title'} | null}
 */
function findVideoFile(files, { videoId = null, title = null } = {}) {
  const list = Array.isArray(files) ? files : [];
  if (videoId) {
    const hit = list.find((f) => String(f?.name ?? '').includes(videoId));
    if (hit) return { file: hit, by: 'id' };
  }
  const key = title ? compareKey(title) : '';
  if (key.length >= 4) {
    const hit = list.find((f) => {
      const n = compareKey(f?.name);
      return n && (n.includes(key) || key.includes(n));
    });
    if (hit) return { file: hit, by: 'title' };
  }
  return null;
}

/**
 * Asks YouTube's public oEmbed endpoint what this video is called. No API key, no account, nothing
 * downloaded but a small JSON document.
 *
 * It cannot tell us the publish date, the duration or the description — `published_at` is required
 * and must be typed by the operator rather than guessed, because a wrong date silently changes which
 * day a performance is eligible for.
 *
 * A failure here is not an error for the caller: this is a convenience, and the five steps still work
 * by hand. `ok: false` means "type it in yourself".
 */
async function fetchOembed(url, { timeoutMs = 5000, fetchImpl = fetch } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(`${OEMBED}?url=${encodeURIComponent(url)}&format=json`, { signal: ctl.signal });
    if (!r.ok) return { ok: false, reason: r.status === 404 ? '유튜브에서 이 영상을 찾지 못했습니다 (비공개이거나 삭제된 영상일 수 있습니다).' : `유튜브 응답 오류 ${r.status}` };
    const j = await r.json();
    return { ok: true, title: j.title ?? null, channel_name: j.author_name ?? null, channel_url: j.author_url ?? null, thumbnail_url: j.thumbnail_url ?? null };
  } catch (e) {
    return { ok: false, reason: e.name === 'AbortError' ? '유튜브 응답이 너무 느립니다.' : `유튜브에 연결하지 못했습니다: ${e.message}` };
  } finally {
    clearTimeout(timer);
  }
}

const NOTE_OK = '자동으로 채운 값입니다. 확인 후 저장하세요. 공식 영문 표기와 버전의 근거는 직접 확인해 넣어야 합니다.';
const NOTE_MANUAL = '제목을 자동으로 가져오지 못했습니다. 주소는 저장할 수 있으니 나머지는 직접 입력하세요.';

/** Everything the registration screen can learn from a link, with nothing asserted as fact. */
async function lookupYoutube(input, opts = {}) {
  const { videoId, url } = parseYoutubeUrl(input);
  const meta = await fetchOembed(url, opts);
  const base = { video_id: videoId, normalized_url: url, platform: 'youtube' };
  if (!meta.ok) {
    return { ...base, title: null, channel_name: null, channel_url: null, thumbnail_url: null,
      suggested: {}, lookup_ok: false, reason: meta.reason, note: NOTE_MANUAL };
  }
  return {
    ...base,
    title: meta.title, channel_name: meta.channel_name, channel_url: meta.channel_url,
    thumbnail_url: meta.thumbnail_url ?? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    suggested: suggestFromTitle(meta.title),
    lookup_ok: true,
    // The channel being called "SEVENTEEN" is not proof that it is the official SEVENTEEN channel.
    confirm: '이 채널이 공식 채널이 맞습니까? 프로그램은 확인할 수 없습니다.',
    note: NOTE_OK,
  };
}

module.exports = {
  parseYoutubeUrl, suggestFromTitle, suggestFromFilename, plainTitle, findVideoFile,
  fetchOembed, lookupYoutube, thumbnailFor: (id) => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
};
