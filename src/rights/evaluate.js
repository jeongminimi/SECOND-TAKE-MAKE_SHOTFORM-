'use strict';
/**
 * Rights check for one clip asset. A clip is usable only when EVERY required rights category
 * (footage, music, performance by default) has a granted permission that covers:
 * edit, Instagram repost, the scheduled publish time (+ a minimum time the post stays up),
 * the exact source segment, and the publish territory.
 *
 * Finding an official URL never implies a file or a permission — clip_assets.file_ref must be a
 * local file and usage_permissions must exist per category.
 *
 * Every verdict is recorded twice: `label`/`reasons` in English, which the tests and logs read, and
 * `label_ko`/`reasons_ko` for the operator. The Korean is not a translation of the English but an
 * answer to "what do I do now", because a rights failure is a task, not a status.
 */
const fs = require('node:fs');
const { fromStoredPath } = require('../config');
const T = require('../util/terms');

function evaluateClip(asset, ctx) {
  const { cfg, publishAtUtc, mode } = ctx;
  const reasons = [];
  const reasonsKo = [];
  const checks = [];
  const pass = (label, ko) => checks.push({ ok: true, label, label_ko: ko });
  const fail = (label, ko) => { checks.push({ ok: false, label, label_ko: ko }); reasons.push(label); reasonsKo.push(ko); };

  const filePath = fromStoredPath(cfg, asset.file_ref);
  if (fs.existsSync(filePath)) pass('Clip file is registered and present on disk', '클립 파일이 등록되어 있고 실제로 있습니다');
  else fail(`Clip file not found: ${asset.file_ref}`, `클립 파일을 찾을 수 없습니다 (${asset.file_ref}). 파일을 다시 올리면 해결됩니다.`);

  if (asset.is_test_asset && mode === 'live') {
    fail('Test asset — cannot be used on the live publishing path', '테스트용 소재입니다. 실제 발행에는 쓸 수 없습니다. 실제로 확보한 파일로 바꾸면 해결됩니다.');
  }
  if (asset.is_test_asset && mode !== 'live') {
    checks.push({ ok: true, label: 'Test asset (allowed in dry-run only)', label_ko: '테스트용 소재입니다 (예행 연습에서만 허용)', testOnly: true });
  }

  const dur = asset.source_end_sec - asset.source_start_sec;
  if (dur > cfg.render.maxClipDurationSec) {
    fail(`Intended segment is ${dur}s, longer than the ${cfg.render.maxClipDurationSec}s reel limit`,
      `쓰려는 구간이 ${dur}초로, 릴스 최대 길이 ${cfg.render.maxClipDurationSec}초를 넘습니다. 구간을 ${cfg.render.maxClipDurationSec}초 이내로 줄이면 해결됩니다.`);
  }

  const publishAt = Date.parse(publishAtUtc);
  const minDays = cfg.rights.minDaysValidAfterPublish ?? 0;
  const mustRunUntil = publishAt + minDays * 86400000;
  const territoriesNeeded = cfg.publish.geoRestrictionSupported ? cfg.publish.targetRegions : ['WORLDWIDE'];
  const platform = cfg.rights.requiredPlatform;

  for (const cat of cfg.rights.requiredCategories) {
    const K = T.ko('category', cat); // 영상 권리 / 음악 권리 / 실연 권리
    const p = asset.permissions.find((x) => x.rights_category === cat);
    if (!p) { fail(`[${cat}] permission missing`, `${K} 정보가 아직 없습니다. 5단계에서 ${K}를 입력하면 해결됩니다.`); continue; }
    const before = reasons.length;

    if (p.status !== 'granted') {
      fail(`[${cat}] status is "${p.status}", not granted`,
        `${K}의 상태가 "${T.ko('permissionStatus', p.status)}"입니다. 허락을 받고 상태를 "허락받음"으로 바꾸면 해결됩니다.`);
    }
    if (!p.allows_edit) fail(`[${cat}] editing not allowed`, `${K}에 편집 허용이 들어 있지 않습니다. 편집(자르기·자막)을 허락받아 체크하면 해결됩니다.`);
    if (!p.allows_repost) fail(`[${cat}] re-posting not allowed`, `${K}에 재게시 허용이 들어 있지 않습니다. Instagram 재게시를 허락받아 체크하면 해결됩니다.`);
    if (!p.platforms.map((s) => s.toLowerCase()).includes(platform)) {
      fail(`[${cat}] ${platform} not in permitted platforms (${p.platforms.join(', ') || 'none'})`,
        `${K}의 허용 플랫폼에 ${platform}이 없습니다 (현재: ${p.platforms.join(', ') || '없음'}). ${platform} 게시를 허락받으면 해결됩니다.`);
    }

    const terr = p.territories.map((s) => s.toUpperCase());
    const coversTerritory = terr.includes('WORLDWIDE') || territoriesNeeded.every((t) => terr.includes(t));
    if (!coversTerritory) {
      fail(`[${cat}] territory ${terr.join(', ') || 'none'} does not cover ${territoriesNeeded.join(', ')}` +
        (cfg.publish.geoRestrictionSupported ? '' : ' (no per-post geo restriction available → worldwide required)'),
        `${K}가 ${T.territories(terr)}에서만 허용됩니다. 해외 팬이 보는 계정이고 게시물별 지역 제한을 쓸 수 없으므로, 전 세계 허락을 받아야 해결됩니다.`);
    }

    if (p.valid_from && Date.parse(p.valid_from) > publishAt) {
      fail(`[${cat}] not yet valid at publish time (from ${p.valid_from})`,
        `${K}의 허락 시작일(${T.day(p.valid_from)})이 게시 예정일(${T.day(publishAtUtc)})보다 늦습니다. 게시일을 늦추거나 더 이른 시작일로 허락받으면 해결됩니다.`);
    }
    if (p.valid_until && Date.parse(p.valid_until) < publishAt) {
      fail(`[${cat}] expired ${p.valid_until} before publish time ${publishAtUtc}`,
        `${K}가 게시 예정일(${T.day(publishAtUtc)}) 전에 만료됩니다 (종료 ${T.day(p.valid_until)}). 기간을 연장해 다시 받으면 해결됩니다.`);
    } else if (p.valid_until && Date.parse(p.valid_until) < mustRunUntil) {
      fail(`[${cat}] ends ${p.valid_until}, less than ${minDays} days after publish`,
        `${K}가 ${T.day(p.valid_until)}에 끝나, 게시 후 ${minDays}일을 채우지 못합니다. 올린 게시물은 계속 남아 있어야 하므로 ${T.day(new Date(mustRunUntil).toISOString())} 이후까지 허락받으면 해결됩니다.`);
    }

    if (p.permitted_start_sec == null || p.permitted_end_sec == null) {
      fail(`[${cat}] permitted segment not stated`, `${K}에 허락받은 구간이 적혀 있지 않습니다. 몇 분 몇 초부터 몇 초까지 쓸 수 있는지 적으면 해결됩니다.`);
    } else if (p.permitted_start_sec > asset.source_start_sec || p.permitted_end_sec < asset.source_end_sec) {
      fail(`[${cat}] permitted segment ${p.permitted_start_sec}–${p.permitted_end_sec}s does not cover intended ${asset.source_start_sec}–${asset.source_end_sec}s`,
        `${K}로 허락받은 구간(${T.range(p.permitted_start_sec, p.permitted_end_sec)})이 쓰려는 구간(${T.range(asset.source_start_sec, asset.source_end_sec)})을 다 덮지 못합니다. 쓰려는 구간을 허락 범위 안으로 옮기거나, 그 구간까지 허락받으면 해결됩니다.`);
    }

    if (!p.evidence_ref) fail(`[${cat}] no evidence reference`, `${K}의 증빙이 없습니다. 허락 메일이나 계약서를 올리면 해결됩니다.`);
    if (p.is_test_permission && mode === 'live') {
      fail(`[${cat}] virtual test permission — not valid for live publishing`, `${K}가 가상 테스트 권한입니다. 실제 발행에는 쓸 수 없습니다. 실제 허락으로 바꾸면 해결됩니다.`);
    }

    if (reasons.length === before) {
      pass(`[${cat}] granted by ${p.rights_holder ?? 'unknown holder'} — edit, ${platform}, territory, period and segment all covered`,
        `${K} 확보 — ${p.rights_holder ?? '권리자 미기재'} · 편집·${platform} 게시·${T.territories(terr)}·기간·구간 모두 충족`);
    }
  }

  const testOnly = Boolean(asset.is_test_asset || asset.permissions.some((p) => p.is_test_permission));
  return { assetId: asset.id, assetKey: asset.asset_key, eligible: reasons.length === 0, reasons, reasons_ko: reasonsKo, checks, testOnly };
}

/** Evaluates every clip of a candidate and returns the first usable one (by asset id) plus all results. */
function bestClip(assets, ctx) {
  const results = assets.map((a) => ({ asset: a, result: evaluateClip(a, ctx) }));
  const ok = results.find((r) => r.result.eligible);
  return { usable: ok ?? null, results };
}

module.exports = { evaluateClip, bestClip };
