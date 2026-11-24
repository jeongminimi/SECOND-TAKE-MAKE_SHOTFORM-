'use strict';
/**
 * Imports candidate data from JSON into the candidate structure.
 * A future official-API collector should produce the same shape and call importData().
 * Idempotent: every row is upserted on its natural key, so re-importing never duplicates.
 */
const fs = require('node:fs');
const { tx } = require('../db');
const V = require('./validate');

function importFile(db, filePath) {
  return importData(db, JSON.parse(fs.readFileSync(filePath, 'utf8')));
}

/** Same rules the web forms use, so a file import can never slip past a check a form enforces. */
function validCues(c) {
  V.assertValid(V.validateCandidate({ ...c, arrangement_tags: c.arrangement_tags ?? [] }));
  return c.watch_cues ?? [];
}

function importData(db, data) {
  return tx(db, () => {
    const ids = { channels: {}, videos: {}, tracks: {}, candidates: {}, assets: {} };
    const counts = { channels: 0, videos: 0, tracks: 0, candidates: 0, clip_assets: 0, usage_permissions: 0 };

    const upChannel = db.prepare(`
      INSERT INTO source_channels (platform, external_id, name, is_active, is_test)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (platform, external_id) DO UPDATE SET name = excluded.name, is_active = excluded.is_active, is_test = excluded.is_test
      RETURNING id`);
    for (const c of data.channels ?? []) {
      V.assertValid(V.validateChannel(c));
      ids.channels[c.key] = upChannel.get(c.platform, c.external_id, c.name, c.is_active ?? 1, c.is_test ?? 0).id;
      counts.channels++;
    }

    const upTrack = db.prepare(`
      INSERT INTO tracks (track_key, original_artist_en, original_artist_ko, title_en, title_ko, name_evidence)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (track_key) DO UPDATE SET original_artist_en = excluded.original_artist_en, original_artist_ko = excluded.original_artist_ko,
        title_en = excluded.title_en, title_ko = excluded.title_ko, name_evidence = excluded.name_evidence
      RETURNING id`);
    for (const t of data.tracks ?? []) {
      V.assertValid(V.validateTrack(t));
      ids.tracks[t.key] = upTrack.get(t.key, t.original_artist_en ?? null, t.original_artist_ko ?? null, t.title_en ?? null, t.title_ko ?? null, t.name_evidence ?? null).id;
      counts.tracks++;
    }

    const upVideo = db.prepare(`
      INSERT INTO source_videos (channel_id, platform, platform_video_id, official_url, title, description, published_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (platform, platform_video_id) DO UPDATE SET channel_id = excluded.channel_id, official_url = excluded.official_url,
        title = excluded.title, description = excluded.description, published_at = excluded.published_at
      RETURNING id`);
    for (const v of data.videos ?? []) {
      V.assertValid(V.validateVideo(v));
      const channelId = ids.channels[v.channel];
      if (!channelId) throw new Error(`video ${v.key}: unknown channel ${v.channel}`);
      ids.videos[v.key] = upVideo.get(channelId, v.platform, v.platform_video_id, v.official_url, v.title, v.description ?? null, v.published_at).id;
      counts.videos++;
    }

    const upCand = db.prepare(`
      INSERT INTO performance_candidates (candidate_key, source_video_id, track_id, performer_en, performer_ko, program_name,
        performance_type, arrangement_tags, version_evidence, segment_start_sec, segment_end_sec, segment_evidence,
        why_watch_en, why_watch_evidence, occasion_note, occasion_date, occasion_evidence, watch_cues, judgement_notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (candidate_key) DO UPDATE SET source_video_id = excluded.source_video_id, track_id = excluded.track_id,
        performer_en = excluded.performer_en, performer_ko = excluded.performer_ko, program_name = excluded.program_name,
        performance_type = excluded.performance_type, arrangement_tags = excluded.arrangement_tags, version_evidence = excluded.version_evidence,
        segment_start_sec = excluded.segment_start_sec, segment_end_sec = excluded.segment_end_sec, segment_evidence = excluded.segment_evidence,
        why_watch_en = excluded.why_watch_en, why_watch_evidence = excluded.why_watch_evidence, occasion_note = excluded.occasion_note,
        occasion_date = excluded.occasion_date, occasion_evidence = excluded.occasion_evidence, watch_cues = excluded.watch_cues, judgement_notes = excluded.judgement_notes
      RETURNING id`);
    for (const c of data.candidates ?? []) {
      const videoId = ids.videos[c.video];
      if (!videoId) throw new Error(`candidate ${c.candidate_key}: unknown video ${c.video}`);
      const trackId = c.track ? ids.tracks[c.track] : null;
      if (c.track && !trackId) throw new Error(`candidate ${c.candidate_key}: unknown track ${c.track}`);
      ids.candidates[c.candidate_key] = upCand.get(
        c.candidate_key, videoId, trackId, c.performer_en ?? null, c.performer_ko ?? null, c.program_name ?? null,
        c.performance_type ?? null, JSON.stringify(c.arrangement_tags ?? []), c.version_evidence ?? null,
        c.segment_start_sec ?? null, c.segment_end_sec ?? null, c.segment_evidence ?? null,
        c.why_watch_en ?? null, c.why_watch_evidence ?? null, c.occasion_note ?? null, c.occasion_date ?? null,
        c.occasion_evidence ?? null, JSON.stringify(validCues(c)), c.judgement_notes ?? null,
      ).id;
      counts.candidates++;
    }

    const upAsset = db.prepare(`
      INSERT INTO clip_assets (asset_key, candidate_id, file_ref, source_start_sec, source_end_sec, file_offset_sec, is_test_asset, personal_use_only, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (asset_key) DO UPDATE SET candidate_id = excluded.candidate_id, file_ref = excluded.file_ref,
        source_start_sec = excluded.source_start_sec, source_end_sec = excluded.source_end_sec, file_offset_sec = excluded.file_offset_sec,
        is_test_asset = excluded.is_test_asset, personal_use_only = excluded.personal_use_only, notes = excluded.notes
      RETURNING id`);
    const upPerm = db.prepare(`
      INSERT INTO usage_permissions (clip_asset_id, rights_category, rights_holder, status, allows_edit, allows_repost, platforms,
        territories, valid_from, valid_until, permitted_start_sec, permitted_end_sec, evidence_ref, is_test_permission)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (clip_asset_id, rights_category) DO UPDATE SET rights_holder = excluded.rights_holder, status = excluded.status,
        allows_edit = excluded.allows_edit, allows_repost = excluded.allows_repost, platforms = excluded.platforms,
        territories = excluded.territories, valid_from = excluded.valid_from, valid_until = excluded.valid_until,
        permitted_start_sec = excluded.permitted_start_sec, permitted_end_sec = excluded.permitted_end_sec,
        evidence_ref = excluded.evidence_ref, is_test_permission = excluded.is_test_permission`);
    for (const a of data.clip_assets ?? []) {
      const candId = ids.candidates[a.candidate];
      if (!candId) throw new Error(`clip asset ${a.asset_key}: unknown candidate ${a.candidate}`);
      V.assertValid(V.validateClipAsset(a));
      const assetId = upAsset.get(a.asset_key, candId, a.file_ref, a.source_start_sec, a.source_end_sec, a.file_offset_sec ?? 0,
        a.is_test_asset ?? 0, a.personal_use_only ?? 0, a.notes ?? null).id;
      ids.assets[a.asset_key] = assetId;
      counts.clip_assets++;
      for (const p of a.permissions ?? []) {
        V.assertValid(V.validatePermission(p, a.asset_key));
        upPerm.run(assetId, p.rights_category, p.rights_holder ?? null, p.status, p.allows_edit ?? 0, p.allows_repost ?? 0,
          JSON.stringify(p.platforms ?? []), JSON.stringify(p.territories ?? []), p.valid_from ?? null, p.valid_until ?? null,
          p.permitted_start_sec ?? null, p.permitted_end_sec ?? null, p.evidence_ref ?? null, p.is_test_permission ?? 0);
        counts.usage_permissions++;
      }
    }
    return { ids, counts };
  });
}

module.exports = { importFile, importData };
