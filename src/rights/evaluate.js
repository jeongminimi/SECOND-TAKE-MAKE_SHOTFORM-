'use strict';
/**
 * Rights check for one clip asset. A clip is usable only when EVERY required rights category
 * (footage, music, performance by default) has a granted permission that covers:
 * edit, Instagram repost, the scheduled publish time (+ a minimum time the post stays up),
 * the exact source segment, and the publish territory.
 *
 * Finding an official URL never implies a file or a permission — clip_assets.file_ref must be a
 * local file and usage_permissions must exist per category.
 */
const fs = require('node:fs');
const { fromStoredPath } = require('../config');

function evaluateClip(asset, ctx) {
  const { cfg, publishAtUtc, mode } = ctx;
  const reasons = [];
  const checks = [];
  const pass = (label) => checks.push({ ok: true, label });
  const fail = (label) => { checks.push({ ok: false, label }); reasons.push(label); };

  const filePath = fromStoredPath(cfg, asset.file_ref);
  if (fs.existsSync(filePath)) pass('Clip file is registered and present on disk');
  else fail(`Clip file not found: ${asset.file_ref}`);

  if (asset.is_test_asset && mode === 'live') fail('Test asset — cannot be used on the live publishing path');
  if (asset.is_test_asset && mode !== 'live') checks.push({ ok: true, label: 'Test asset (allowed in dry-run only)', testOnly: true });

  const dur = asset.source_end_sec - asset.source_start_sec;
  if (dur > cfg.render.maxClipDurationSec) fail(`Intended segment is ${dur}s, longer than the ${cfg.render.maxClipDurationSec}s reel limit`);

  const publishAt = Date.parse(publishAtUtc);
  const minDays = cfg.rights.minDaysValidAfterPublish ?? 0;
  const mustRunUntil = publishAt + minDays * 86400000;
  const territoriesNeeded = cfg.publish.geoRestrictionSupported ? cfg.publish.targetRegions : ['WORLDWIDE'];
  const platform = cfg.rights.requiredPlatform;

  for (const cat of cfg.rights.requiredCategories) {
    const p = asset.permissions.find((x) => x.rights_category === cat);
    if (!p) { fail(`[${cat}] permission missing`); continue; }
    const before = reasons.length;
    if (p.status !== 'granted') fail(`[${cat}] status is "${p.status}", not granted`);
    if (!p.allows_edit) fail(`[${cat}] editing not allowed`);
    if (!p.allows_repost) fail(`[${cat}] re-posting not allowed`);
    if (!p.platforms.map((s) => s.toLowerCase()).includes(platform)) fail(`[${cat}] ${platform} not in permitted platforms (${p.platforms.join(', ') || 'none'})`);
    const terr = p.territories.map((s) => s.toUpperCase());
    const coversTerritory = terr.includes('WORLDWIDE') || territoriesNeeded.every((t) => terr.includes(t));
    if (!coversTerritory) {
      fail(`[${cat}] territory ${terr.join(', ') || 'none'} does not cover ${territoriesNeeded.join(', ')}` +
        (cfg.publish.geoRestrictionSupported ? '' : ' (no per-post geo restriction available → worldwide required)'));
    }
    if (p.valid_from && Date.parse(p.valid_from) > publishAt) fail(`[${cat}] not yet valid at publish time (from ${p.valid_from})`);
    if (p.valid_until && Date.parse(p.valid_until) < publishAt) fail(`[${cat}] expired ${p.valid_until} before publish time ${publishAtUtc}`);
    else if (p.valid_until && Date.parse(p.valid_until) < mustRunUntil) fail(`[${cat}] ends ${p.valid_until}, less than ${minDays} days after publish`);
    if (p.permitted_start_sec == null || p.permitted_end_sec == null) fail(`[${cat}] permitted segment not stated`);
    else if (p.permitted_start_sec > asset.source_start_sec || p.permitted_end_sec < asset.source_end_sec) {
      fail(`[${cat}] permitted segment ${p.permitted_start_sec}–${p.permitted_end_sec}s does not cover intended ${asset.source_start_sec}–${asset.source_end_sec}s`);
    }
    if (!p.evidence_ref) fail(`[${cat}] no evidence reference`);
    if (p.is_test_permission && mode === 'live') fail(`[${cat}] virtual test permission — not valid for live publishing`);
    if (reasons.length === before) pass(`[${cat}] granted by ${p.rights_holder ?? 'unknown holder'} — edit, ${platform}, territory, period and segment all covered`);
  }

  const testOnly = Boolean(asset.is_test_asset || asset.permissions.some((p) => p.is_test_permission));
  return { assetId: asset.id, assetKey: asset.asset_key, eligible: reasons.length === 0, reasons, checks, testOnly };
}

/** Evaluates every clip of a candidate and returns the first usable one (by asset id) plus all results. */
function bestClip(assets, ctx) {
  const results = assets.map((a) => ({ asset: a, result: evaluateClip(a, ctx) }));
  const ok = results.find((r) => r.result.eligible);
  return { usable: ok ?? null, results };
}

module.exports = { evaluateClip, bestClip };
