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
    const ko = reason === 'quotaExceeded'
      ? '오늘 쓸 수 있는 유튜브 검색 횟수(하루 약 100회)를 다 썼습니다. 태평양 시간 자정에 다시 채워집니다. 그때까지는 「유튜브에서 검색 ↗」로 직접 찾으세요.'
      : `유튜브 검색이 거부되었습니다 (${reason}). API 키와 사용 설정을 확인하세요.`;
    throw Object.assign(new Error(`youtube search refused: ${reason}`), { code: reason, ko });
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

module.exports = { searchYoutube, hasApiKey, apiKeyFor, NoApiKey, SEARCH_URL };
