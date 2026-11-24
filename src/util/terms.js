/**
 * The one place that turns an internal value into the words the operator reads.
 *
 * Loaded two ways on purpose — `require()` on the server, `<script src="/terms.js">` in the browser —
 * so the운영 screen, the registration screen and the server can never drift into three different
 * vocabularies for the same value.
 *
 * Scope: this file translates *status values and labels*. It never touches the account's output
 * (reel title, caption, hashtags, text drawn into the video): those are the English product.
 *
 * An unknown value comes back unchanged rather than blank — a value we forgot to list should look
 * odd on screen, not silently disappear.
 */
(function (root, factory) {
  const T = factory();
  if (typeof module === 'object' && module.exports) module.exports = T;
  else root.TERMS = T;
}(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const MAPS = {
    // publish_jobs.status
    jobStatus: {
      simulated: '예행 완료', blocked: '막힘', queued: '대기 중', published: '게시됨',
      failed: '실패', pending_confirmation: '확인 필요',
    },
    // publish_jobs.mode
    mode: { dry_run: '예행 연습', live: '실제 발행' },
    // reels.render_status
    renderStatus: { done: '완료', pending: '대기', rendering: '만드는 중', failed: '실패' },
    // reels.output_format
    format: { licensed_clip: '공연 클립형', original_graphic: '자체 그래픽형' },
    // reels.template_id
    template: {
      'graphic-classic': '한 장 카드형', 'graphic-sequence': '3장면 전환형',
      // Clip templates differ only in how much of the frame the video takes and where the text sits.
      'clip-standard': '원본 비율 (여백 있음)', 'clip-large': '크게 (좌우 약간 잘림)',
      'clip-full': '꽉 채우기 (글씨가 영상 위에)', 'clip-minimal': '꽉 채우기 · 글씨 최소',
    },
    // usage_permissions.rights_category
    category: { footage: '영상 권리', music: '음악 권리', performance: '실연 권리' },
    // usage_permissions.status
    permissionStatus: { granted: '허락받음', pending: '요청 중', denied: '거절', revoked: '철회됨' },
    // segment_suggestions.status / .label / .analyzer
    suggestionStatus: { proposed: '검토 대기', approved: '승인됨', rejected: '거절됨', superseded: '대체됨' },
    // `peak` is loudness, not structure: loud is not the same as chorus, so the wording never says it is.
    section: { chorus: '후렴', verse: '절', bridge: '브릿지', intro: '도입부', outro: '마무리', solo: '솔로', inst: '연주', peak: '소리가 가장 큰 구간 (후렴일 가능성)' },
    analyzer: { allin1: '곡 구조 분석', fixture: '예시 데이터(실제 분석 아님)', loudness: '음량 분석 (구조 분석 아님)' },
    // daily_selections.status
    selectionStatus: { selected: '선곡됨', skipped: '건너뜀' },
    // performance_candidates.performance_type
    performanceType: { live: '라이브', cover: '커버' },
    // arrangement tags
    tag: {
      band: '밴드', acoustic: '어쿠스틱', orchestra: '오케스트라', unplugged: '언플러그드',
      rearranged: '재편곡', a_cappella: '아카펠라', jazz: '재즈', piano: '피아노', cover: '커버', live: '라이브',
    },
    // selection score keys
    score: { versionDifference: '버전의 차이', englishInfo: '영어 소개 정보', timeliness: '소개할 시점', recentDiversity: '최근 콘텐츠와의 차이' },
  };

  /** Dictionary lookup. An unlisted value is shown as it is, so nothing disappears quietly. */
  function ko(kind, value) {
    if (value === null || value === undefined || value === '') return '';
    const m = MAPS[kind];
    return (m && m[value]) || String(value);
  }

  /** Seconds → 0:50 / 1:02:03. Used wherever a raw second count would be shown. */
  function mmss(sec) {
    if (sec === null || sec === undefined || Number.isNaN(Number(sec))) return '';
    const total = Math.round(Number(sec));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }

  /** "30–60초" with the clock reading alongside, because 1800 seconds means nothing at a glance. */
  function range(from, to) {
    if (from === null || from === undefined || to === null || to === undefined) return '';
    return `${mmss(from)}–${mmss(to)}`;
  }

  /** evidence://contract.pdf → 증빙 파일: contract.pdf */
  function evidence(ref) {
    if (!ref) return '증빙 없음';
    const m = /^evidence:\/\/(.*)$/.exec(String(ref));
    return m ? `증빙 파일: ${m[1]}` : String(ref);
  }

  /** revision 2 → "2차 수정"; revision 1 is the first run and needs no label. */
  function revision(n) {
    return Number(n) > 1 ? `${n}차 수정` : '';
  }

  /** A date that is only ever shown, never parsed back: 2026-11-12T23:59:59Z → 2026-11-12 */
  function day(iso) {
    return iso ? String(iso).slice(0, 10) : '';
  }

  const territories = (list) => {
    const t = (list ?? []).map((x) => String(x).toUpperCase());
    if (!t.length) return '지정 안 됨';
    return t.includes('WORLDWIDE') ? '전 세계' : t.join(', ');
  };

  return { MAPS, ko, mmss, range, evidence, revision, day, territories };
}));
