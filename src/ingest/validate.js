'use strict';
/**
 * The one place that decides whether a record may be saved.
 * Both the JSON importer and the web forms call these, so a rule can never apply to one and not the other.
 *
 * Two levels, because "cannot be stored" and "will not be selected" are different problems:
 *  - block: the record is refused. A claim is stored only together with the source it came from,
 *           and a structural rule (a file that is really a URL, an evidence document inlined
 *           instead of referenced, a backwards time range) is never negotiable.
 *  - warn:  the record is stored but the selection step will exclude it, or score it lower.
 *           An operator registering a candidate over several sittings needs to be able to save a
 *           half-filled row; the warning says what is still missing and what it costs.
 *
 * Each issue carries an English `en` (thrown, matched by tests, written to logs) and a Korean `ko`
 * shown to the operator. `field` names the form input to highlight.
 */

const CATEGORY_KO = { footage: '영상', music: '음악', performance: '실연' };

const isBlank = (v) => v === null || v === undefined || String(v).trim() === '';
const has = (v) => !isBlank(v);

const block = (field, code, en, ko) => ({ level: 'block', field, code, en, ko });
const warn = (field, code, en, ko) => ({ level: 'warn', field, code, en, ko });

/** Official spellings are never invented; without a source they simply do not count as official. */
function validateTrack(t) {
  const out = [];
  if (isBlank(t.track_key ?? t.key)) out.push(block('track_key', 'track_key_required', 'track: track_key is required', '곡 식별자(track_key)를 입력하세요.'));
  if ((has(t.title_en) || has(t.original_artist_en)) && isBlank(t.name_evidence)) {
    out.push(warn('name_evidence', 'name_evidence_missing',
      'track: official English names without name_evidence do not count as official',
      '영문 곡명·아티스트명이 확인된 출처가 없습니다. 저장은 되지만 "영어 소개 정보" 점수(25점)를 받지 못합니다.'));
  }
  if (isBlank(t.title_en)) {
    out.push(warn('title_en', 'title_en_missing',
      'track: no official English title — candidates using this track are excluded',
      '공식 영문 곡명이 없습니다. 이 곡을 쓰는 후보는 선곡에서 제외됩니다. 번역이나 로마자 표기를 지어내지 않기 때문입니다.'));
  }
  return out;
}

function validateChannel(c) {
  const out = [];
  if (isBlank(c.platform)) out.push(block('platform', 'platform_required', 'channel: platform is required', '플랫폼을 고르세요 (예: youtube).'));
  if (isBlank(c.external_id)) out.push(block('external_id', 'external_id_required', 'channel: external_id is required', '공식 채널 ID를 입력하세요.'));
  if (isBlank(c.name)) out.push(block('name', 'name_required', 'channel: name is required', '채널 이름을 입력하세요.'));
  return out;
}

function validateVideo(v) {
  const out = [];
  for (const [f, label] of [['platform', '플랫폼'], ['platform_video_id', '영상 ID'], ['official_url', '공식 링크'], ['title', '영상 제목'], ['published_at', '공식 게시 시각']]) {
    if (isBlank(v[f])) out.push(block(f, `${f}_required`, `video: ${f} is required`, `${label}을(를) 입력하세요.`));
  }
  if (has(v.official_url) && !/^https?:\/\//i.test(v.official_url)) {
    out.push(block('official_url', 'official_url_invalid', 'video: official_url must be an http(s) URL', '공식 링크는 http:// 또는 https:// 로 시작해야 합니다.'));
  }
  if (has(v.published_at) && Number.isNaN(Date.parse(v.published_at))) {
    out.push(block('published_at', 'published_at_invalid', 'video: published_at must be an ISO-8601 UTC timestamp', '공식 게시 시각을 날짜·시각 형식으로 입력하세요.'));
  }
  return out;
}

/** Cues must carry evidence; a cue without a source is rejected at import, not silently dropped. */
function validateCues(cues, keyLabel = 'candidate') {
  const out = [];
  for (const [i, q] of (cues ?? []).entries()) {
    const at = `watch_cues[${i}]`;
    if (typeof q.at_sec !== 'number' || Number.isNaN(q.at_sec)) {
      out.push(block(at, 'cue_at_sec_required', `${keyLabel}: cue needs at_sec and text_en`, `시청 포인트 ${i + 1}번: 시점(초)을 숫자로 입력하세요.`));
    }
    if (isBlank(q.text_en)) {
      out.push(block(at, 'cue_text_required', `${keyLabel}: cue needs at_sec and text_en`, `시청 포인트 ${i + 1}번: 영어 설명을 입력하세요.`));
    }
    if (isBlank(q.evidence)) {
      out.push(block(at, 'cue_evidence_required', `${keyLabel}: cue at ${q.at_sec}s has no evidence`,
        `시청 포인트 ${i + 1}번: 근거가 없습니다. 공식 영상 설명·챕터처럼 그 시점이 확인되는 출처를 적어야 저장됩니다.`));
    }
  }
  return out;
}

/** Every interpretive claim on a candidate needs the source it came from. */
function validateCandidate(c) {
  const out = [];
  if (isBlank(c.candidate_key)) out.push(block('candidate_key', 'candidate_key_required', 'candidate: candidate_key is required', '후보 식별자(candidate_key)를 입력하세요.'));

  if (has(c.performance_type) && !['live', 'cover'].includes(c.performance_type)) {
    out.push(block('performance_type', 'performance_type_invalid', `candidate ${c.candidate_key}: performance_type must be live or cover`, '공연 유형은 live 또는 cover 중 하나여야 합니다.'));
  }

  const tags = c.arrangement_tags ?? [];
  if (tags.length && isBlank(c.version_evidence)) {
    out.push(block('version_evidence', 'version_evidence_required',
      `candidate ${c.candidate_key}: arrangement tags claim a version difference with no version_evidence`,
      '편곡 태그(밴드·어쿠스틱 등)를 붙이려면 그 차이가 확인되는 출처를 "버전 근거"에 함께 적어야 합니다.'));
  }

  if (has(c.why_watch_en) && isBlank(c.why_watch_evidence)) {
    out.push(block('why_watch_evidence', 'why_watch_evidence_required',
      `candidate ${c.candidate_key}: why_watch_en needs why_watch_evidence`,
      '"왜 볼 만한가" 한 줄을 적으려면 근거를 함께 적어야 합니다. 근거를 못 찾겠으면 한 줄을 비워 두세요 — 사실만으로 만든 문장이 대신 쓰입니다.'));
  }

  const hasSegment = c.segment_start_sec != null || c.segment_end_sec != null;
  if (hasSegment && isBlank(c.segment_evidence)) {
    out.push(block('segment_evidence', 'segment_evidence_required',
      `candidate ${c.candidate_key}: recommended segment needs segment_evidence`,
      '추천 구간(타임스탬프)을 적으려면 공식 챕터처럼 그 시점이 확인되는 근거가 필요합니다. 근거가 없으면 비워 두세요 — 전체 영상으로 링크됩니다.'));
  }
  if (c.segment_start_sec != null && c.segment_end_sec != null && c.segment_end_sec <= c.segment_start_sec) {
    out.push(block('segment_end_sec', 'segment_range_invalid', `candidate ${c.candidate_key}: segment end must be after start`, '추천 구간의 끝은 시작보다 뒤여야 합니다.'));
  }

  if (has(c.occasion_note) && isBlank(c.occasion_evidence)) {
    out.push(block('occasion_evidence', 'occasion_evidence_required',
      `candidate ${c.candidate_key}: occasion_note needs occasion_evidence`,
      '"지금 소개할 이유"를 적으려면 공식적으로 확인된 근거가 필요합니다.'));
  }

  out.push(...validateCues(c.watch_cues, `candidate ${c.candidate_key}`));

  // Below this line: stored happily, but the selection step will not pick it.
  if (isBlank(c.performer_en)) {
    out.push(warn('performer_en', 'performer_en_missing', `candidate ${c.candidate_key}: no official English performer name — excluded from selection`,
      '공식 영문 공연자명이 없습니다. 저장은 되지만 선곡에서 제외됩니다.'));
  }
  if (isBlank(c.performance_type)) {
    out.push(warn('performance_type', 'performance_type_missing', `candidate ${c.candidate_key}: performance type unknown — excluded from selection`,
      '공연 유형(live/cover)이 비어 있습니다. 저장은 되지만 선곡에서 제외됩니다.'));
  }
  if (isBlank(c.version_evidence)) {
    out.push(warn('version_evidence', 'version_evidence_missing', `candidate ${c.candidate_key}: version not confirmed by source — excluded from selection`,
      '버전 근거가 없습니다. 저장은 되지만 선곡에서 제외됩니다. 이 계정의 핵심이 "다른 버전"이라 근거 없이는 소개하지 않습니다.'));
  }
  return dedupe(out);
}

function validateClipAsset(a) {
  const out = [];
  if (isBlank(a.asset_key)) out.push(block('asset_key', 'asset_key_required', 'clip asset: asset_key is required', '클립 식별자(asset_key)를 입력하세요.'));
  if (isBlank(a.file_ref)) {
    out.push(block('file_ref', 'file_ref_required', `clip asset ${a.asset_key}: file_ref is required`, '클립 파일을 올리세요. 공식 링크만으로는 파일을 확보한 것으로 보지 않습니다.'));
  } else if (/^https?:/i.test(a.file_ref)) {
    out.push(block('file_ref', 'file_ref_is_url',
      `clip asset ${a.asset_key}: file_ref must be a local file, not a URL — an official link is not a file`,
      '클립 자리에 링크를 넣을 수 없습니다. 공식 링크는 파일이 아니며, 링크를 찾은 것이 이용 허락을 받은 것도 아닙니다.'));
  }
  if (a.source_start_sec == null || a.source_end_sec == null) {
    out.push(block('source_start_sec', 'source_range_required', `clip asset ${a.asset_key}: source range is required`, '원본에서 사용할 구간의 시작·끝(초)을 입력하세요.'));
  } else if (a.source_end_sec <= a.source_start_sec) {
    out.push(block('source_end_sec', 'source_range_invalid', `clip asset ${a.asset_key}: source_end_sec must be after source_start_sec`, '사용 구간의 끝은 시작보다 뒤여야 합니다.'));
  }
  return out;
}

/** Evidence originals never enter the database; only a pointer to the stored document does. */
function validatePermission(p, assetKey = 'clip asset') {
  const out = [];
  const cat = CATEGORY_KO[p.rights_category] ?? p.rights_category ?? '권리';
  if (isBlank(p.rights_category)) {
    out.push(block('rights_category', 'rights_category_required', `permission ${assetKey}: rights_category is required`, '권리 종류(영상·음악·실연)를 고르세요.'));
  }
  if (!['granted', 'pending', 'denied', 'revoked'].includes(p.status)) {
    out.push(block('status', 'status_invalid', `permission ${assetKey}/${p.rights_category}: status must be granted, pending, denied or revoked`, `[${cat}] 허락 상태를 고르세요.`));
  }
  if (has(p.evidence_ref) && !/^evidence:\/\//.test(p.evidence_ref)) {
    out.push(block('evidence_ref', 'evidence_not_pointer',
      `permission ${assetKey}/${p.rights_category}: evidence_ref must be a pointer (evidence://...), not the document itself`,
      `[${cat}] 증빙은 참조값(evidence://...)으로만 저장합니다. 문서 원본이나 그 경로를 직접 넣을 수 없습니다.`));
  }
  for (const [f, label] of [['valid_from', '시작일'], ['valid_until', '종료일']]) {
    if (has(p[f]) && Number.isNaN(Date.parse(p[f]))) {
      out.push(block(f, `${f}_invalid`, `permission ${assetKey}/${p.rights_category}: ${f} must be a timestamp`, `[${cat}] 허락 ${label}을 날짜 형식으로 입력하세요.`));
    }
  }
  if (p.permitted_start_sec != null && p.permitted_end_sec != null && p.permitted_end_sec <= p.permitted_start_sec) {
    out.push(block('permitted_end_sec', 'permitted_range_invalid', `permission ${assetKey}/${p.rights_category}: permitted end must be after start`, `[${cat}] 허락 구간의 끝은 시작보다 뒤여야 합니다.`));
  }
  if (isBlank(p.evidence_ref) && p.status === 'granted') {
    out.push(warn('evidence_ref', 'evidence_missing', `permission ${assetKey}/${p.rights_category}: granted without an evidence reference — clip stays unusable`,
      `[${cat}] 허락받았다고 표시했지만 증빙이 없습니다. 저장은 되지만 이 클립은 쓸 수 없는 상태로 남습니다.`));
  }
  return dedupe(out);
}

const blocking = (issues) => issues.filter((i) => i.level === 'block');

/** A field that is already blocked does not also need its softer warning; one message per input. */
function dedupe(issues) {
  const blocked = new Set(blocking(issues).map((i) => i.field));
  return issues.filter((i) => i.level === 'block' || !blocked.has(i.field));
}

/** Throws on blocking issues only, keeping the English text (and the substrings tests match). */
function assertValid(issues) {
  const bad = blocking(issues);
  if (bad.length) {
    const e = new Error(bad.map((i) => i.en).join('; '));
    e.issues = issues;
    throw e;
  }
}

module.exports = {
  validateChannel, validateVideo, validateTrack, validateCandidate, validateCues, validateClipAsset, validatePermission,
  assertValid, blocking, CATEGORY_KO,
};
