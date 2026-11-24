'use strict';
const { tx, json } = require('../db');
const { zonedToUtcIso, endOfLocalDateUtc, addDays, assertDate } = require('../util/time');
const { loadCandidates, loadCandidate, loadClipAssets, livePublishedCandidateIds, confirmedSelectionsBetween } = require('./candidates');
const { exclusions, score, compareRanked } = require('./scoring');
const { bestClip } = require('../rights/evaluate');
const T = require('../util/terms');

function scheduledAtUtc(cfg, operatingDate) {
  return zonedToUtcIso(operatingDate, cfg.publish.localTime, cfg.timezone);
}

/** Pure evaluation of every candidate for a date (no writes). */
function evaluateDate(db, cfg, operatingDate, { mode = 'dry_run' } = {}) {
  assertDate(operatingDate);
  const publishAtUtc = scheduledAtUtc(cfg, operatingDate);
  const ctx = {
    cfg, operatingDate, mode, publishAtUtc,
    endOfDayUtc: endOfLocalDateUtc(operatingDate, cfg.timezone),
    livePublished: livePublishedCandidateIds(db),
    recentSelections: confirmedSelectionsBetween(db, addDays(operatingDate, -cfg.selection.diversityWindowDays), addDays(operatingDate, -1)),
  };

  const evaluated = loadCandidates(db).map((c) => {
    const ex = exclusions(c, ctx);
    const entry = { candidate: c, exclusions: ex, eligible: ex.length === 0 };
    if (entry.eligible) {
      entry.score = score(c, ctx);
      entry.clip = bestClip(loadClipAssets(db, c.id), { cfg, publishAtUtc, mode });
    }
    return entry;
  });

  const eligible = evaluated.filter((e) => e.eligible).sort(compareRanked);
  const withClip = eligible.filter((e) => e.clip.usable);
  let pick = null, format = null, formatReason = null, formatReasonKo = null;
  if (withClip.length) {
    pick = withClip[0];
    format = 'licensed_clip';
    const r = pick.clip.usable.result;
    formatReason = r.personalUseOnly
      ? `Personal-use clip ${r.assetKey}: rights NOT verified — dry-run render only, never for live publishing`
      : `Usable clip ${r.assetKey}: all required rights cover edit, Instagram, worldwide, schedule and segment` + (r.testOnly ? ' (TEST asset — dry-run only)' : '');
    formatReasonKo = r.personalUseOnly
      ? '개인 확인용 클립이라 권리를 확인하지 않고 공연 클립형으로 만듭니다. 실제 발행은 영구히 막히며, 공개 게시하면 안 됩니다.'
      : `권리 3종이 모두 확보된 클립이 있어 공연 클립형으로 만듭니다 (편집·Instagram 게시·전 세계·기간·구간 모두 충족).`
        + (r.testOnly ? ' 다만 테스트 소재라서 실제 발행은 막힙니다.' : '');
  } else if (eligible.length) {
    pick = eligible[0];
    format = 'original_graphic';
    const clipNotes = eligible.flatMap((e) => e.clip.results.map((x) => `${x.result.assetKey}: ${x.result.reasons[0]}`));
    formatReason = clipNotes.length
      ? `No eligible candidate has a usable clip (${clipNotes.join('; ')}) → original graphic`
      : 'No clip file registered for any eligible candidate → original graphic';
    formatReasonKo = clipNotes.length
      ? `쓸 수 있는 클립이 없어 자체 그래픽형으로 만듭니다. ${eligible.flatMap((e) => e.clip.results.map((x) => x.result.reasons_ko[0])).filter(Boolean).join(' / ')}`
      : '등록된 클립 파일이 없어 자체 그래픽형(무음 텍스트 영상)으로 만듭니다. 권리를 확보한 공연 클립을 등록하면 클립형으로 바뀝니다.';
    if (pick.clip.results.length) {
      formatReason = `Clip rejected for this candidate (${pick.clip.results.map((x) => `${x.result.assetKey}: ${x.result.reasons.join(' | ')}`).join('; ')}) → original graphic`;
      formatReasonKo = `이 후보의 클립을 쓸 수 없어 자체 그래픽형으로 만듭니다. ${pick.clip.results.map((x) => x.result.reasons_ko.join(' / ')).join(' / ')}`;
    }
  }

  const snapshot = evaluated.map((e) => ({
    candidate_id: e.candidate.id,
    candidate_key: e.candidate.candidate_key,
    performer_en: e.candidate.performer_en,
    performer_ko: e.candidate.performer_ko,
    title_en: e.candidate.title_en,
    title_ko: e.candidate.title_ko,
    performance_type: e.candidate.performance_type,
    arrangement_tags: e.candidate.arrangement_tags,
    published_at: e.candidate.published_at,
    eligible: e.eligible,
    exclusions: e.exclusions,
    score: e.score ?? null,
    clip: e.clip ? {
      usable_asset_key: e.clip.usable?.result.assetKey ?? null,
      assets: e.clip.results.map((x) => ({ asset_key: x.result.assetKey, eligible: x.result.eligible, testOnly: x.result.testOnly, personalUseOnly: x.result.personalUseOnly, reasons: x.result.reasons, reasons_ko: x.result.reasons_ko, checks: x.result.checks })),
    } : null,
    rank: e.eligible ? eligible.indexOf(e) + 1 : null,
  }));

  return { operatingDate, publishAtUtc, pick, format, formatReason, formatReasonKo, eligible, evaluated, snapshot };
}

/**
 * What one candidate would become if it were selected on `operatingDate`.
 * The registration screen asks "what did I just create and what is still missing", not "does this win
 * today", so this deliberately ignores the other candidates. Reads only.
 */
function previewCandidate(db, cfg, candidateId, operatingDate) {
  assertDate(operatingDate);
  const c = loadCandidate(db, candidateId);
  if (!c) throw new Error(`candidate ${candidateId} not found`);
  const publishAtUtc = scheduledAtUtc(cfg, operatingDate);
  const ctx = {
    cfg, operatingDate, mode: 'dry_run', publishAtUtc,
    endOfDayUtc: endOfLocalDateUtc(operatingDate, cfg.timezone),
    livePublished: livePublishedCandidateIds(db),
    recentSelections: confirmedSelectionsBetween(db, addDays(operatingDate, -cfg.selection.diversityWindowDays), addDays(operatingDate, -1)),
  };
  const ex = exclusions(c, ctx);
  const clip = bestClip(loadClipAssets(db, c.id), { cfg, publishAtUtc, mode: 'dry_run' });
  const format = clip.usable ? 'licensed_clip' : 'original_graphic';
  const formatReason = clip.usable?.result.personalUseOnly
    ? `Personal-use clip ${clip.usable.result.assetKey}: rights NOT verified — dry-run render only, never for live publishing`
    : clip.usable
    ? `Usable clip ${clip.usable.result.assetKey}: every required right covers edit, Instagram, worldwide, schedule and segment`
      + (clip.usable.result.testOnly ? ' (TEST asset — dry-run only)' : '')
    : clip.results.length
      ? `Clip rejected (${clip.results.map((x) => `${x.result.assetKey}: ${x.result.reasons.join(' | ')}`).join('; ')}) → original graphic`
      : 'No clip file registered for this candidate → original graphic';
  const formatReasonKo = clip.usable?.result.personalUseOnly
    ? '개인 확인용 클립이라 권리를 확인하지 않고 공연 클립형으로 만들어집니다. 실제 발행은 영구히 막히며, 공개 게시하면 안 됩니다.'
    : clip.usable
    ? '권리 3종이 모두 확보되어 공연 클립형으로 만들어집니다.' + (clip.usable.result.testOnly ? ' 다만 테스트 소재라서 실제 발행은 막힙니다.' : '')
    : clip.results.length
      ? `클립을 쓸 수 없어 자체 그래픽형으로 만들어집니다. ${clip.results.map((x) => x.result.reasons_ko.join(' / ')).join(' / ')}`
      : '등록된 클립 파일이 없어 자체 그래픽형(무음 텍스트 영상)으로 만들어집니다. 권리를 확보한 공연 클립을 5단계에서 등록하면 클립형으로 바뀝니다.';
  return {
    candidate_id: c.id, candidate_key: c.candidate_key, operating_date: operatingDate, publish_at_utc: publishAtUtc,
    display_name: `${c.performer_en ?? '공연자 미입력'} – ${c.title_en ?? c.title_ko ?? '곡 미연결'}`,
    eligible: ex.length === 0,
    exclusions: ex,
    score: ex.length === 0 ? score(c, ctx) : null,
    format, format_reason: formatReason, format_reason_ko: formatReasonKo,
    clip: {
      usable_asset_key: clip.usable?.result.assetKey ?? null,
      assets: clip.results.map((x) => ({ asset_key: x.result.assetKey, eligible: x.result.eligible, testOnly: x.result.testOnly, personalUseOnly: x.result.personalUseOnly, reasons: x.result.reasons, reasons_ko: x.result.reasons_ko, checks: x.result.checks })),
    },
  };
}

const SKIP_LABEL = {
  not_yet_published: ['official video not yet published on this date', '공식 영상이 이 날짜에는 아직 공개 전'],
  no_official_title_en: ['no official English song title', '공식 영문 곡명 없음'],
  no_official_performer_en: ['no official English performer name', '공식 영문 공연자명 없음'],
  version_unverified: ['version not confirmed by source', '원곡과 다른 점이 출처로 확인되지 않음'],
  no_version: ['performance type unknown', '공연 유형(라이브/커버) 비어 있음'],
  no_track: ['song not identified', '곡이 연결되지 않음'],
  already_published: ['already published', '이미 게시한 적 있음'],
  channel_inactive: ['source channel inactive', '공식 채널이 꺼져 있음'],
  video_inactive: ['source video deactivated', '원본 영상이 꺼져 있음'],
  candidate_inactive: ['candidate deactivated', '후보가 꺼져 있음'],
};

/** Both languages are built from the same counts, so they can never disagree about what happened. */
function skipReasonFrom(ev) {
  if (!ev.evaluated.length) {
    return { en: 'No candidates registered.', ko: '등록된 후보가 하나도 없습니다. "데이터 등록" 탭의 1단계부터 채우면 선곡이 시작됩니다.' };
  }
  const counts = {};
  for (const e of ev.evaluated) for (const x of e.exclusions) counts[x.code] = (counts[x.code] ?? 0) + 1;
  const parts = Object.entries(counts).map(([c, n]) => `${SKIP_LABEL[c]?.[0] ?? c} ×${n}`);
  const partsKo = Object.entries(counts).map(([c, n]) => `${SKIP_LABEL[c]?.[1] ?? c} ${n}건`);
  return {
    en: `No eligible candidate for ${ev.operatingDate} (${ev.evaluated.length} checked): ${parts.join('; ')}. Nothing will be published.`,
    ko: `${ev.operatingDate}에 올릴 수 있는 후보가 없어 건너뜁니다. 후보 ${ev.evaluated.length}건을 확인했고, 빠진 이유는 ${partsKo.join(', ')}입니다. 위 항목을 채우면 그날 다시 실행했을 때 선곡됩니다.`,
  };
}

function selectionReason(ev) {
  const p = ev.pick;
  const breakdown = p.score.items.map((i) => `${i.key} ${i.points}/${i.max}`).join(', ');
  const runnerUp = ev.eligible.find((e) => e !== p);
  const lost = p.score.items.filter((i) => i.points < i.max);
  return {
    en: `Selected ${p.candidate.candidate_key} — ${p.candidate.performer_en} "${p.candidate.title_en}" — score ${p.score.total}/${p.score.max} (${breakdown}). `
      + `Format: ${ev.format}. ${ev.formatReason}.`
      + (runnerUp ? ` Next best: ${runnerUp.candidate.candidate_key} (${runnerUp.score.total}).` : ''),
    ko: `${p.candidate.performer_en} – ${p.candidate.title_en}을(를) ${p.score.total}점(만점 ${p.score.max})으로 골랐습니다. `
      + `${T.ko('format', ev.format)}으로 만듭니다.`
      + (lost.length ? ` 못 받은 점수: ${lost.map((i) => `${T.ko('score', i.key)} ${i.max - i.points}점`).join(', ')}.` : ' 모든 항목에서 만점입니다.')
      + (runnerUp ? ` 다음 순위는 ${runnerUp.candidate.performer_en} – ${runnerUp.candidate.title_en} (${runnerUp.score.total}점)였습니다.` : ''),
  };
}

/**
 * Creates (or returns) the single selection for an operating date.
 * - Re-running without `reselect` never creates a new selection; it returns the stored one.
 * - `reselect` re-evaluates and UPDATES the same row (revision+1). Its reel and dry-run jobs are discarded.
 *   Refused if a live publish job exists for that reel.
 */
function selectDaily(db, cfg, operatingDate, { reselect = false, mode = 'dry_run' } = {}) {
  assertDate(operatingDate);
  return tx(db, () => {
    const existing = db.prepare('SELECT * FROM daily_selections WHERE operating_date = ?').get(operatingDate);
    if (existing && !reselect) return { selection: existing, reused: true };

    if (existing && reselect) {
      const live = db.prepare(`SELECT pj.status FROM publish_jobs pj JOIN reels r ON r.id = pj.reel_id
                                WHERE r.selection_id = ? AND pj.mode = 'live'`).get(existing.id);
      if (live) throw new Error(`Cannot reselect ${operatingDate}: a live publish job exists (status ${live.status}).`);
    }

    const ev = evaluateDate(db, cfg, operatingDate, { mode });
    const plan = ev.pick
      ? { format: ev.format, clip_asset_id: ev.pick.clip.usable?.result.assetId ?? null, format_reason: ev.formatReason, format_reason_ko: ev.formatReasonKo, publish_at_utc: ev.publishAtUtc }
      : null;
    const picked = ev.pick ? selectionReason(ev) : null;
    const skipped = ev.pick ? null : skipReasonFrom(ev);
    const fields = ev.pick
      ? { candidate_id: ev.pick.candidate.id, status: 'selected', score: ev.pick.score.total,
          score_breakdown: JSON.stringify({ items: ev.pick.score.items, plan }),
          reason: picked.en, reason_ko: picked.ko, skip_reason: null, skip_reason_ko: null }
      : { candidate_id: null, status: 'skipped', score: null, score_breakdown: null,
          reason: null, reason_ko: null, skip_reason: skipped.en, skip_reason_ko: skipped.ko };

    if (existing) {
      db.prepare('DELETE FROM reels WHERE selection_id = ?').run(existing.id); // cascades to dry-run publish jobs
      db.prepare(`UPDATE daily_selections SET candidate_id = ?, status = ?, score = ?, score_breakdown = ?, reason = ?, reason_ko = ?,
                    skip_reason = ?, skip_reason_ko = ?, rule_version = ?, evaluation_snapshot = ?, revision = revision + 1,
                    updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
                  WHERE id = ?`).run(fields.candidate_id, fields.status, fields.score, fields.score_breakdown, fields.reason, fields.reason_ko,
        fields.skip_reason, fields.skip_reason_ko, cfg.selection.ruleVersion, JSON.stringify(ev.snapshot), existing.id);
      return { selection: db.prepare('SELECT * FROM daily_selections WHERE id = ?').get(existing.id), reused: false, reselected: true };
    }
    const row = db.prepare(`INSERT INTO daily_selections (operating_date, candidate_id, status, score, score_breakdown, reason, reason_ko,
                              skip_reason, skip_reason_ko, rule_version, evaluation_snapshot)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`)
      .get(operatingDate, fields.candidate_id, fields.status, fields.score, fields.score_breakdown, fields.reason, fields.reason_ko,
        fields.skip_reason, fields.skip_reason_ko, cfg.selection.ruleVersion, JSON.stringify(ev.snapshot));
    return { selection: row, reused: false };
  });
}

function selectionPlan(selection) {
  return json.parse(selection.score_breakdown, {})?.plan ?? null;
}

module.exports = { selectDaily, evaluateDate, previewCandidate, scheduledAtUtc, selectionPlan };
