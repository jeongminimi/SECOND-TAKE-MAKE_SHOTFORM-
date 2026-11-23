'use strict';
const { tx, json } = require('../db');
const { zonedToUtcIso, endOfLocalDateUtc, addDays, assertDate } = require('../util/time');
const { loadCandidates, loadClipAssets, livePublishedCandidateIds, confirmedSelectionsBetween } = require('./candidates');
const { exclusions, score, compareRanked } = require('./scoring');
const { bestClip } = require('../rights/evaluate');

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
  let pick = null, format = null, formatReason = null;
  if (withClip.length) {
    pick = withClip[0];
    format = 'licensed_clip';
    const r = pick.clip.usable.result;
    formatReason = `Usable clip ${r.assetKey}: all required rights cover edit, Instagram, worldwide, schedule and segment` + (r.testOnly ? ' (TEST asset — dry-run only)' : '');
  } else if (eligible.length) {
    pick = eligible[0];
    format = 'original_graphic';
    const clipNotes = eligible.flatMap((e) => e.clip.results.map((x) => `${x.result.assetKey}: ${x.result.reasons[0]}`));
    formatReason = clipNotes.length
      ? `No eligible candidate has a usable clip (${clipNotes.join('; ')}) → original graphic`
      : 'No clip file registered for any eligible candidate → original graphic';
    if (pick.clip.results.length) formatReason = `Clip rejected for this candidate (${pick.clip.results.map((x) => `${x.result.assetKey}: ${x.result.reasons.join(' | ')}`).join('; ')}) → original graphic`;
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
      assets: e.clip.results.map((x) => ({ asset_key: x.result.assetKey, eligible: x.result.eligible, testOnly: x.result.testOnly, reasons: x.result.reasons, checks: x.result.checks })),
    } : null,
    rank: e.eligible ? eligible.indexOf(e) + 1 : null,
  }));

  return { operatingDate, publishAtUtc, pick, format, formatReason, eligible, evaluated, snapshot };
}

function skipReasonFrom(ev) {
  if (!ev.evaluated.length) return 'No candidates registered.';
  const LABEL = {
    not_yet_published: 'official video not yet published on this date', no_official_title_en: 'no official English song title',
    no_official_performer_en: 'no official English performer name', version_unverified: 'version not confirmed by source',
    no_version: 'performance type unknown', no_track: 'song not identified', already_published: 'already published',
    channel_inactive: 'source channel inactive',
  };
  const counts = {};
  for (const e of ev.evaluated) for (const x of e.exclusions) counts[x.code] = (counts[x.code] ?? 0) + 1;
  const parts = Object.entries(counts).map(([c, n]) => `${LABEL[c] ?? c} ×${n}`);
  return `No eligible candidate for ${ev.operatingDate} (${ev.evaluated.length} checked): ${parts.join('; ')}. Nothing will be published.`;
}

function selectionReason(ev) {
  const p = ev.pick;
  const breakdown = p.score.items.map((i) => `${i.key} ${i.points}/${i.max}`).join(', ');
  const runnerUp = ev.eligible.find((e) => e !== p);
  return `Selected ${p.candidate.candidate_key} — ${p.candidate.performer_en} "${p.candidate.title_en}" — score ${p.score.total}/${p.score.max} (${breakdown}). ` +
    `Format: ${ev.format}. ${ev.formatReason}.` +
    (runnerUp ? ` Next best: ${runnerUp.candidate.candidate_key} (${runnerUp.score.total}).` : '');
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
    const plan = ev.pick ? { format: ev.format, clip_asset_id: ev.pick.clip.usable?.result.assetId ?? null, format_reason: ev.formatReason, publish_at_utc: ev.publishAtUtc } : null;
    const fields = ev.pick
      ? { candidate_id: ev.pick.candidate.id, status: 'selected', score: ev.pick.score.total,
          score_breakdown: JSON.stringify({ items: ev.pick.score.items, plan }), reason: selectionReason(ev), skip_reason: null }
      : { candidate_id: null, status: 'skipped', score: null, score_breakdown: null, reason: null, skip_reason: skipReasonFrom(ev) };

    if (existing) {
      db.prepare('DELETE FROM reels WHERE selection_id = ?').run(existing.id); // cascades to dry-run publish jobs
      db.prepare(`UPDATE daily_selections SET candidate_id = ?, status = ?, score = ?, score_breakdown = ?, reason = ?, skip_reason = ?,
                    rule_version = ?, evaluation_snapshot = ?, revision = revision + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
                  WHERE id = ?`).run(fields.candidate_id, fields.status, fields.score, fields.score_breakdown, fields.reason, fields.skip_reason,
        cfg.selection.ruleVersion, JSON.stringify(ev.snapshot), existing.id);
      return { selection: db.prepare('SELECT * FROM daily_selections WHERE id = ?').get(existing.id), reused: false, reselected: true };
    }
    const row = db.prepare(`INSERT INTO daily_selections (operating_date, candidate_id, status, score, score_breakdown, reason, skip_reason, rule_version, evaluation_snapshot)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`)
      .get(operatingDate, fields.candidate_id, fields.status, fields.score, fields.score_breakdown, fields.reason, fields.skip_reason,
        cfg.selection.ruleVersion, JSON.stringify(ev.snapshot));
    return { selection: row, reused: false };
  });
}

function selectionPlan(selection) {
  return json.parse(selection.score_breakdown, {})?.plan ?? null;
}

module.exports = { selectDaily, evaluateDate, scheduledAtUtc, selectionPlan };
