'use strict';
/**
 * Searching YouTube for the performance the operator already has a file of.
 *
 * This is the official YouTube Data API v3 (`search.list`) and nothing else: no scraping of result
 * pages, no unofficial endpoint. It reads metadata only — the API has no way to fetch a video file,
 * and taking one anyway is what the Developer Policies call unauthorized downloading. The file always
 * comes from the operator.
 *
 * Quota (checked 2026-11-25): `search.list` costs 100 units per call against a default 10,000 units a
 * day, i.e. about 100 searches a day, resetting at midnight Pacific Time. Each page of results costs
 * another 100, so only one page is ever asked for. Going beyond the default needs a compliance audit.
 *
 * What comes back is a list of candidates, never an answer: every field is from the API, the program
 * picks none of them, and the operator confirms which video it is. The same oEmbed confirmation and
 * the same 「출처가 공식 채널이 맞습니다」 tick still apply afterwards.
 */
const SEARCH_URL = 'https://www.googleapis.com/youtube/v3/search';

class NoApiKey extends Error {
  constructor() {
    super('YouTube Data API key is not configured');
    this.code = 'no_api_key';
    this.ko = '유튜브 검색에는 API 키가 필요합니다. config/local.json 에 {"youtube":{"apiKey":"..."}} 를 넣거나 '
      + 'YOUTUBE_API_KEY 환경변수를 설정하세요. 키가 없어도 「유튜브에서 검색 ↗」로 직접 찾을 수 있습니다.';
  }
}

/** config/local.json (git-ignored) first, then the environment. Never config/default.json. */
const apiKeyFor = (cfg) => cfg?.youtube?.apiKey || process.env.YOUTUBE_API_KEY || null;
const hasApiKey = (cfg) => Boolean(apiKeyFor(cfg));

const thumbOf = (s) => s?.thumbnails?.medium?.url ?? s?.thumbnails?.default?.url ?? null;

/**
 * @returns {Promise<{query: string, items: Array<{video_id, url, title, channel_name, published_at, thumbnail_url}>}>}
 */
async function searchYoutube(query, { cfg, fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const q = String(query ?? '').trim();
  if (!q) throw Object.assign(new Error('search query is empty'), { ko: '검색할 제목이 없습니다.' });
  const key = apiKeyFor(cfg);
  if (!key) throw new NoApiKey();

  const max = Math.min(10, Math.max(1, Number(cfg?.youtube?.searchMaxResults ?? 5)));
  const url = `${SEARCH_URL}?part=snippet&type=video&maxResults=${max}&q=${encodeURIComponent(q)}&key=${encodeURIComponent(key)}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(url, { signal: ctl.signal });
  } catch (e) {
    throw Object.assign(new Error(`youtube search failed: ${e.message}`), { ko: '유튜브 검색에 실패했습니다. 인터넷 연결을 확인하세요.' });
  } finally {
    clearTimeout(timer);
  }

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // The key itself is never echoed back to the screen or the log.
    const reason = body?.error?.errors?.[0]?.reason ?? body?.error?.status ?? String(res.status);
    // Google's own wording, minus the key — which only ever appears in the request, never in the body,
    // but is stripped anyway so a copied error message can never carry it.
    const detail = String(body?.error?.message ?? '').split(key).join('<키>');
    const deny = body?.error?.details?.find((d) => d?.reason)?.reason ?? null;
    const ko = {
      quotaExceeded: '오늘 쓸 수 있는 유튜브 검색 횟수(하루 약 100회)를 다 썼습니다. 태평양 시간 자정에 다시 채워집니다. 그때까지는 「제목으로 찾기」가 유튜브 탭을 엽니다.',
      forbidden: '이 키로는 유튜브 검색을 쓸 수 없습니다. 구글 클라우드 콘솔에서 ① 프로젝트에 「YouTube Data API v3」가 사용 설정(Enable)되어 있는지 ② 키의 「API 제한」에 YouTube Data API v3 가 포함되어 있는지 확인하세요.',
      accessNotConfigured: '이 프로젝트에 「YouTube Data API v3」가 사용 설정되어 있지 않습니다. 구글 클라우드 콘솔 → API 및 서비스 → 라이브러리에서 사용 설정하세요.',
      keyInvalid: 'API 키가 올바르지 않습니다. config/local.json 의 apiKey 를 다시 확인하세요(따옴표 안쪽만 키여야 합니다).',
      ipRefererBlocked: '키에 걸어 둔 사용 제한(IP·웹사이트) 때문에 이 PC에서 거부되었습니다. 콘솔에서 「애플리케이션 제한」을 확인하세요.',
    }[reason] ?? `유튜브 검색이 거부되었습니다 (${reason}). API 키와 사용 설정을 확인하세요.`;
    throw Object.assign(new Error(`youtube search refused: ${reason}${deny ? ` / ${deny}` : ''}`), {
      code: reason, ko: detail ? `${ko}\n구글이 준 사유: ${detail}` : ko,
    });
  }

  const items = (body.items ?? [])
    .filter((it) => it?.id?.videoId && it?.snippet)
    .map((it) => ({
      video_id: it.id.videoId,
      url: `https://www.youtube.com/watch?v=${it.id.videoId}`,
      title: it.snippet.title ?? null,
      channel_name: it.snippet.channelTitle ?? null,
      published_at: it.snippet.publishedAt ?? null,
      thumbnail_url: thumbOf(it.snippet),
    }));
  return { query: q, items };
}

/** `PT4M13S` → 253. Null when YouTube gives something this cannot read (live streams have no length). */
function parseIsoDuration(iso) {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(String(iso ?? '').trim());
  if (!m) return null;
  const [d, h, min, s] = m.slice(1).map((v) => Number(v ?? 0) || 0);
  const total = (d * 86400) + (h * 3600) + (min * 60) + s;
  // YouTube answers `P0D` for a live stream, which is not a length of zero — it is no length at all.
  return total > 0 ? total : null;
}

const VIDEOS_URL = 'https://www.googleapis.com/youtube/v3/videos';

/**
 * The facts about one video that oEmbed does not carry: its length, its view count and the date it was
 * published. `videos.list` costs 1 unit — a hundredth of a search — so this is cheap enough to ask on
 * every lookup.
 *
 * The published date matters most: it decides which operating day a candidate can be selected for, and
 * until now it had to be typed in by hand because oEmbed has no field for it. It is still shown as
 * 「자동으로 채움」 and the operator confirms it.
 */
async function videoDetails(videoId, { cfg, fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const id = String(videoId ?? '').trim();
  if (!/^[A-Za-z0-9_-]{11}$/.test(id)) throw Object.assign(new Error('not a video id'), { ko: '영상 번호가 올바르지 않습니다.' });
  const key = apiKeyFor(cfg);
  if (!key) throw new NoApiKey();

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(`${VIDEOS_URL}?part=snippet,contentDetails,statistics&id=${encodeURIComponent(id)}&key=${encodeURIComponent(key)}`,
      { signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const reason = body?.error?.errors?.[0]?.reason ?? String(res.status);
    throw Object.assign(new Error(`youtube videos.list refused: ${reason}`), { code: reason, ko: '영상 정보를 가져오지 못했습니다.' });
  }
  const v = (body.items ?? [])[0];
  if (!v) return null; // deleted, private or region-blocked: nothing is invented in its place
  return {
    video_id: id,
    title: v.snippet?.title ?? null,
    channel_name: v.snippet?.channelTitle ?? null,
    channel_id: v.snippet?.channelId ?? null,
    published_at: v.snippet?.publishedAt ?? null,
    duration_sec: parseIsoDuration(v.contentDetails?.duration),
    view_count: v.statistics?.viewCount != null ? Number(v.statistics.viewCount) : null,
    like_count: v.statistics?.likeCount != null ? Number(v.statistics.likeCount) : null,
    live: v.snippet?.liveBroadcastContent && v.snippet.liveBroadcastContent !== 'none' ? v.snippet.liveBroadcastContent : null,
  };
}

module.exports = { searchYoutube, videoDetails, parseIsoDuration, hasApiKey, apiKeyFor, NoApiKey, SEARCH_URL, VIDEOS_URL };
