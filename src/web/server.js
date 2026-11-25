'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
let express;
try { express = require('express'); } catch { express = require('./mini-express'); }

const { loadConfig, fromStoredPath } = require('../config');
const { openDb, json } = require('../db');
const { runDay } = require('../pipeline');
const { loadCandidate, loadCandidates, loadClipAssets } = require('../selection/candidates');
const { selectionPlan, previewCandidate } = require('../selection/selectDaily');
const entry = require('../ingest/manualEntry');
const V = require('../ingest/validate');
const { todayIn, fmtTimestamp } = require('../util/time');
const { SEED } = require('../cli');
const { analyzeAssets, approveSuggestion, rejectSuggestion, suggestionsForCandidate } = require('../analysis/structure');
const { exportReel } = require('../export/exportReel');
const { loadTemplate, listTemplates } = require('../render/templateEngine');
const { renderReel, ZOOM_MIN, ZOOM_MAX } = require('../render/renderReel');
const { buildCopy } = require('../copy/templates');
const { lookupYoutube, findVideoFile, suggestFromFilename } = require('../ingest/youtubeUrl');
const { sourceForFile, WHERE_KO } = require('../ingest/videoSource');
const { searchYoutube, hasApiKey } = require('../ingest/youtubeSearch');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * @param impl the server implementation to build on. Defaults to Express when installed and to
 *   mini-express otherwise; a test passes mini-express explicitly to exercise that path on a machine
 *   where Express IS installed, because that is the only way it gets covered.
 */
function createApp(cfg, db, impl = express) {
  const app = impl();
  app.use(impl.json());
  let queue = Promise.resolve();
  const serial = (fn) => (queue = queue.then(fn, fn));

  const reelFor = (selectionId) => db.prepare('SELECT * FROM reels WHERE selection_id = ?').get(selectionId);
  const jobsFor = (reelId) => db.prepare('SELECT * FROM publish_jobs WHERE reel_id = ? ORDER BY id').all(reelId)
    .map((j) => ({ ...j, plan: json.parse(j.plan_json) }));
  const mediaUrl = (p) => {
    if (!p) return null;
    const rel = path.relative(cfg.resolved.output, fromStoredPath(cfg, p));
    return rel.startsWith('..') || path.isAbsolute(rel) ? null : '/output/' + rel.split(path.sep).map(encodeURIComponent).join('/');
  };

  app.get('/api/overview', (req, res) => {
    const selections = db.prepare(`
      SELECT ds.id, ds.operating_date, ds.status, ds.score, ds.revision, ds.skip_reason, ds.skip_reason_ko,
             pc.candidate_key, pc.performer_en, pc.performer_ko, t.title_en AS song_title_en, t.title_ko AS song_title_ko,
             r.title_en, r.output_format, r.render_status, r.poster_path, pj.status AS job_status
        FROM daily_selections ds
        LEFT JOIN performance_candidates pc ON pc.id = ds.candidate_id
        LEFT JOIN tracks t ON t.id = pc.track_id
        LEFT JOIN reels r ON r.selection_id = ds.id
        LEFT JOIN publish_jobs pj ON pj.reel_id = r.id AND pj.mode = 'dry_run'
       ORDER BY ds.operating_date DESC`).all().map((s) => ({ ...s, poster_url: mediaUrl(s.poster_path) }));
    let scenarioDates = {};
    try { scenarioDates = require(SEED)._meta.scenarioDates; } catch { /* optional */ }
    // The screen offers a template per reel, so it needs to know which ones exist and what each does.
    const templates = listTemplates().map((t) => ({
      id: t.id, format: t.format, name: t.name, description: t.description,
      crops: Boolean(t.video?.fullBleed || t.video?.fit === 'cover'),
    }));
    res.json({ account: cfg.account, timezone: cfg.timezone, publishLocalTime: cfg.publish.localTime, ruleVersion: cfg.selection.ruleVersion,
      weights: cfg.selection.weights, today: todayIn(cfg.timezone), scenarioDates, selections, templates,
      expressFallback: Boolean(impl.isFallback) });
  });

  app.get('/api/day/:date', (req, res) => {
    const sel = db.prepare('SELECT * FROM daily_selections WHERE operating_date = ?').get(req.params.date);
    if (!sel) return res.status(404).json({ error: `No run for ${req.params.date} yet` });
    const out = { selection: { ...sel, evaluation_snapshot: undefined, score_breakdown: json.parse(sel.score_breakdown) },
      snapshot: json.parse(sel.evaluation_snapshot, []), plan: selectionPlan(sel) };
    if (sel.candidate_id) {
      const c = loadCandidate(db, sel.candidate_id);
      out.candidate = c;
      const reel = reelFor(sel.id);
      if (reel) {
        out.reel = { ...reel, video_url: mediaUrl(reel.output_path), poster_url: mediaUrl(reel.poster_path) };
        out.jobs = jobsFor(reel.id);
        out.clip = reel.clip_asset_id ? loadClipAssets(db, c.id).find((a) => a.id === reel.clip_asset_id) : null;
      }
      out.suggestions = suggestionsForCandidate(db, c.id);
    }
    res.json(out);
  });

  app.get('/api/candidates', (req, res) => {
    res.json(loadCandidates(db).map((c) => ({ ...c, clip_assets: loadClipAssets(db, c.id) })));
  });

  app.post('/api/run', async (req, res) => {
    const date = req.body?.date || todayIn(cfg.timezone);
    try {
      const r = await serial(() => runDay(db, cfg, date, { reselect: Boolean(req.body?.reselect) }));
      res.json({ ok: true, date, selectionReused: r.selectionReused, reelCreated: r.reelCreated, rendered: r.rendered, status: r.selection.status });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  /** Framing from a request, falling back to what the reel already has. A blank field is "unchanged". */
  const framingFrom = (src, reel) => {
    const num = (v, col, lo, hi) => {
      if (v == null || v === '') return reel?.[col] ?? null;
      const n = Number(v);
      if (!Number.isFinite(n)) throw new Error(`${col} must be a number`);
      return Math.min(hi, Math.max(lo, n));
    };
    return {
      cropX: num(src.cropX, 'crop_x', 0, 1),
      cropY: num(src.cropY, 'crop_y', 0, 1),
      zoom: num(src.zoom, 'zoom', ZOOM_MIN, ZOOM_MAX),
    };
  };

  /**
   * One frame of what the full render would produce, so the operator can aim the crop without waiting
   * tens of seconds for a video. Same template, same scrims, same text — just stopped after a frame.
   * Writes nothing to the database and leaves no file behind.
   */
  app.get('/api/reel/:id/crop-preview', async (req, res) => {
    let dir = null;
    try {
      const reel = db.prepare('SELECT * FROM reels WHERE id = ?').get(Number(req.params.id));
      if (!reel) throw new Error(`reel ${req.params.id} not found`);
      const sel = db.prepare('SELECT * FROM daily_selections WHERE id = ?').get(reel.selection_id);
      const cand = loadCandidate(db, sel.candidate_id);
      const clip = reel.clip_asset_id ? loadClipAssets(db, cand.id).find((a) => a.id === reel.clip_asset_id) : null;
      const copy = buildCopy(cand, { format: reel.output_format, clipAsset: clip, account: cfg.account });

      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crop-preview-'));
      const out = await serial(() => renderReel({
        cfg, reel, copy, clipAsset: clip, operatingDate: sel.operating_date,
        templateId: req.query.template || reel.template_id || undefined,
        framing: framingFrom(req.query, reel),
        previewDir: dir,
      }));
      res.type('jpeg').set('Cache-Control', 'no-store').send(fs.readFileSync(out.previewPath));
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    } finally {
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * Re-frames one finished reel: a different template, or a different crop, rendered onto the SAME
   * reel row. The day is not selected again — only the picture changes.
   */
  app.post('/api/reel/:id/template', async (req, res) => {
    try {
      const reel = db.prepare('SELECT * FROM reels WHERE id = ?').get(Number(req.params.id));
      if (!reel) throw new Error(`reel ${req.params.id} not found`);
      const id = String(req.body?.template_id ?? '');
      let tpl;
      try { tpl = loadTemplate(id); } catch { throw new Error(`"${id}" is not a template in templates/reels/`); }
      if (tpl.format !== reel.output_format) {
        throw new Error(`Template ${id} is for ${tpl.format}, but reel ${reel.id} is ${reel.output_format}`);
      }
      const f = framingFrom(req.body ?? {}, reel);

      const date = db.prepare('SELECT ds.operating_date d FROM reels r JOIN daily_selections ds ON ds.id = r.selection_id WHERE r.id = ?').get(reel.id).d;
      db.prepare(`UPDATE reels SET template_id = ?, crop_x = ?, crop_y = ?, zoom = ?, render_status = 'pending',
                    updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`).run(id, f.cropX, f.cropY, f.zoom, reel.id);
      const r = await serial(() => runDay(db, cfg, date));
      res.json({
        ok: true, date, reel_id: r.reel.id, template_id: r.reel.template_id,
        crop_x: f.cropX, crop_y: f.cropY, zoom: f.zoom,
        render_status: r.reel.render_status, render_error: r.reel.render_error ?? null,
      });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  // Copies one finished reel into its own folder the operator can open. Same call as `npm run export`.
  app.post('/api/export', (req, res) => {
    try {
      const r = exportReel(db, cfg, { reelId: req.body?.reelId ?? null, date: req.body?.date ?? null });
      res.json({ ok: true, dir: r.dir, files: r.files.map((f) => ({ name: f.name, bytes: f.bytes })) });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/analyze', async (req, res) => {
    try { res.json({ ok: true, results: await serial(() => analyzeAssets(db, cfg, { assetKey: req.body?.assetKey ?? null })) }); }
    catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });

  // Approve → clip range changes → every affected date is re-run so the reel is re-rendered on the same row.
  app.post('/api/suggestions/:id/approve', async (req, res) => {
    try {
      const r = await serial(async () => {
        const a = approveSuggestion(db, cfg, Number(req.params.id));
        const dates = a.reelsToRerender.length
          ? db.prepare(`SELECT ds.operating_date d FROM reels r JOIN daily_selections ds ON ds.id = r.selection_id WHERE r.id IN (${a.reelsToRerender.map(() => '?').join(',')})`).all(...a.reelsToRerender).map((x) => x.d)
          : [];
        for (const d of dates) await runDay(db, cfg, d);
        return { ...a, rerunDates: dates };
      });
      res.json({ ok: true, ...r });
    } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });

  app.post('/api/suggestions/:id/reject', (req, res) => {
    try { rejectSuggestion(db, Number(req.params.id)); res.json({ ok: true }); } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });

  // Local "original guide" list: post title → official original (with verified timestamp only).
  app.get('/guide', (req, res) => {
    const rows = db.prepare(`SELECT r.id, r.title_en, r.official_link, r.output_format, ds.operating_date FROM reels r
                               JOIN daily_selections ds ON ds.id = r.selection_id ORDER BY ds.operating_date DESC`).all();
    res.send(guideShell('Official originals', `<h1>Watch the official originals</h1><p class="muted">Every reel links to the full official video.</p><ul class="list">${
      rows.map((r) => `<li><a href="/guide/${r.id}"><span class="d">${esc(r.operating_date)}</span>${esc(r.title_en)}</a></li>`).join('')}</ul>`));
  });

  app.get('/guide/:id', (req, res) => {
    const r = db.prepare('SELECT r.*, ds.candidate_id, ds.operating_date FROM reels r JOIN daily_selections ds ON ds.id = r.selection_id WHERE r.id = ?').get(Number(req.params.id));
    if (!r) return res.status(404).send(guideShell('Not found', '<h1>Not found</h1>'));
    const c = loadCandidate(db, r.candidate_id);
    const ts = c.segment_start_sec != null && c.segment_evidence ? fmtTimestamp(c.segment_start_sec) : null;
    res.send(guideShell(r.title_en, `
      <p class="eyebrow">${esc(cfg.account.displayName)} · ${esc(r.operating_date)}</p>
      <h1>${esc(r.title_en)}</h1>
      <p class="big">${esc(c.performer_en)} – ${esc(c.title_en)}</p>
      ${c.performer_ko || c.title_ko ? `<p class="muted">${esc(c.performer_ko ?? '')} – ${esc(c.title_ko ?? '')}</p>` : ''}
      <p>${esc(c.program_name ?? '')} · Official source: ${esc(c.channel_name)}</p>
      <a class="btn" href="${esc(r.official_link)}" target="_blank" rel="noopener noreferrer">▶ Watch the full official video${ts ? ` from ${ts}` : ''}</a>
      ${ts ? `<p class="muted small">Timestamp from: ${esc(c.segment_evidence)}</p>` : '<p class="muted small">No verified timestamp — link opens the full video.</p>'}
      <p class="muted small">${r.output_format === 'licensed_clip' ? 'The reel uses a clip under permission.' : 'The reel is an original graphic; it contains no performance footage or audio.'}</p>
      <p><a href="/guide">← All originals</a></p>`));
  });

  // ── Registration screen: everything the operator needs to add data without touching JSON ──────────
  // A save answers with the saved row plus any warnings, so the screen can say "stored, but it will
  // not be selected yet, and here is why" instead of silently accepting a half-filled record.
  const savedOk = (res, r) => res.json({ ok: true, row: r.row, warnings: r.warnings });
  const saveFailed = (res, e) => res.status(400).json({ ok: false, error: e.message, issues: e.issues ?? null });
  const handleSave = (res, fn) => { try { savedOk(res, fn()); } catch (e) { saveFailed(res, e); } };
  /**
   * For saves that change a clip range: the same reel is re-rendered on its own row, so the operator
   * does not have to re-select the day. Selection, revision and score stay as they were.
   */
  const handleSaveAndRerender = async (res, fn) => {
    try {
      const r = fn();
      for (const d of r.rerunDates ?? []) await serial(() => runDay(db, cfg, d));
      res.json({ ok: true, row: r.row, warnings: r.warnings, rerunDates: r.rerunDates ?? [] });
    } catch (e) { saveFailed(res, e); }
  };

  app.get('/api/entry/lists', (req, res) => {
    res.json({
      channels: db.prepare('SELECT * FROM source_channels ORDER BY name').all(),
      videos: db.prepare(`SELECT sv.*, sc.name AS channel_name FROM source_videos sv
                            JOIN source_channels sc ON sc.id = sv.channel_id ORDER BY sv.published_at DESC`).all(),
      tracks: db.prepare('SELECT * FROM tracks ORDER BY track_key').all(),
      candidates: loadCandidates(db).map((c) => ({ ...c, clip_assets: loadClipAssets(db, c.id) })),
      rightsCategories: cfg.rights.requiredCategories,
      categoryLabels: V.CATEGORY_KO,
      arrangementTags: cfg.selection.differentiatingVersionTags,
      clipSeconds: { default: cfg.render.defaultClipDurationSec, max: cfg.render.maxClipDurationSec },
      today: todayIn(cfg.timezone),
    });
  });

  app.post('/api/entry/channel', (req, res) => handleSave(res, () => entry.saveChannel(db, req.body ?? {})));
  app.post('/api/entry/video', (req, res) => handleSave(res, () => entry.saveVideo(db, req.body ?? {})));
  app.post('/api/entry/track', (req, res) => handleSave(res, () => entry.saveTrack(db, req.body ?? {})));
  app.post('/api/entry/candidate', (req, res) => handleSave(res, () => entry.saveCandidate(db, req.body ?? {})));
  app.post('/api/entry/clip-asset', (req, res) => handleSaveAndRerender(res, () => entry.saveClipAsset(db, cfg, req.body ?? {})));
  app.post('/api/entry/permission', (req, res) => handleSave(res, () => entry.savePermission(db, req.body ?? {})));

  /**
   * The video files already sitting in storage/video. The operator usually puts a file there first,
   * so the screen offers that list rather than asking them to upload a file into the folder it is
   * already in. Read-only, and it never looks outside that one folder.
   */
  app.get('/api/entry/video-files', (req, res) => {
    try {
      // `youtube_search` tells the screen which of the two ways of finding the link it can offer:
      // the list of candidates in the page, or a search tab the operator looks through themselves.
      res.json({ ok: true, dir: 'storage/video', files: entry.listVideoFiles(cfg), youtube_search: hasApiKey(cfg) });
    } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });

  /**
   * The link a file already carries — in its name, in a text file beside it, or in its own metadata.
   * Reading the container costs a process, so it is asked for one file at a time, when it is picked.
   * What comes back is a suggestion: the screen confirms the id through oEmbed like any pasted link.
   */
  app.get('/api/entry/file-source', async (req, res) => {
    try {
      const file = fromStoredPath(cfg, String(req.query?.file_ref ?? ''));
      // Only the two folders the program stores videos in, whatever the browser asked for.
      const inside = [cfg.resolved.video, cfg.resolved.clips].some((dir) => !path.relative(dir, file).startsWith('..'));
      if (!inside) throw new Error('이 프로그램이 다루는 영상 폴더 밖의 파일입니다.');
      const found = await sourceForFile(cfg, file);
      res.json({ ok: true, source: found, where_ko: found ? WHERE_KO[found.from] : null });
    } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });

  /**
   * Candidates for a performance the operator has a file of, from the official Data API. Metadata
   * only — there is no download here and the API offers none. Nothing is stored and nothing is
   * chosen: the operator picks which video it is.
   */
  app.get('/api/entry/youtube-search', async (req, res) => {
    try {
      const r = await searchYoutube(req.query?.q, { cfg });
      res.json({ ok: true, ...r });
    } catch (e) {
      res.status(e.code === 'no_api_key' ? 501 : 400).json({ ok: false, error: e.message, code: e.code ?? null, error_ko: e.ko ?? null });
    }
  });

  /**
   * A pasted link, read back as a head start on the registration steps. Reads only: nothing is
   * stored, nothing is downloaded, and every field it returns is a suggestion for the operator to
   * confirm — saving still goes through the five endpoints below.
   */
  app.post('/api/entry/from-url', async (req, res) => {
    try {
      const look = await lookupYoutube(req.body?.url);
      // Starting from a link is the side path: the file still has to be one the operator already has,
      // so their folder is searched for it — by the video id in the file name, else by the title.
      // Nothing is fetched when it is not there; the answer is "put it in the folder".
      const hit = findVideoFile(entry.listVideoFiles(cfg), { videoId: look.video_id, title: look.title });
      res.json({
        ok: true,
        ...look,
        local_file: hit?.file ?? null,
        local_match_by: hit?.by ?? null,
        local_note: hit ? null : `이 영상이 storage/video 폴더에 없습니다. 받아서 폴더에 넣어 주세요. 영상 번호: ${look.video_id}`,
      });
    } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });

  // Step 5 writes the moment and its source onto the candidate, so the caption may carry "▶ 1:23".
  app.post('/api/entry/segment', (req, res) => handleSaveAndRerender(res, () => entry.setCandidateSegment(db, {
    candidate_id: Number(req.body?.candidate_id),
    start_sec: req.body?.start_sec ?? null,
    end_sec: req.body?.end_sec ?? null,
    evidence: req.body?.evidence ?? null,
  })));

  app.post('/api/entry/active', (req, res) => {
    const { kind, id, active } = req.body ?? {};
    try { res.json({ ok: true, row: entry.setActive(db, kind, Number(id), Boolean(active)) }); }
    catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });

  // Checks a candidate without saving it, so the form can warn while the operator is still typing.
  app.post('/api/entry/check/candidate', (req, res) => {
    res.json({ ok: true, issues: V.validateCandidate({ arrangement_tags: [], watch_cues: [], ...(req.body ?? {}) }) });
  });

  app.get('/api/entry/preview/:id', (req, res) => {
    try { res.json({ ok: true, preview: previewCandidate(db, cfg, Number(req.params.id), req.query?.date || todayIn(cfg.timezone)) }); }
    catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });

  // Uploads arrive as a raw body (no multipart dependency); the name travels in the query string.
  const MB = 1024 * 1024;
  async function readRawBody(req, maxBytes) {
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
      total += chunk.length;
      if (total > maxBytes) throw new Error(`파일이 너무 큽니다 (최대 ${Math.round(maxBytes / MB)}MB)`);
      chunks.push(chunk);
    }
    if (!total) throw new Error('빈 파일입니다');
    return Buffer.concat(chunks);
  }

  const upload = (maxBytes, store) => async (req, res) => {
    try {
      const buf = await readRawBody(req, maxBytes);
      // An uploaded file's name reads the same way a file already in the folder does, so the form
      // gets the same head start either way. It is a suggestion, like every other one.
      res.json({ ok: true, suggested: suggestFromFilename(req.query?.name), ...store(cfg, req.query?.name, buf) });
    } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  };
  app.post('/api/entry/upload/clip', upload(1024 * MB, entry.storeClipFile));
  app.post('/api/entry/upload/evidence', upload(25 * MB, entry.storeEvidenceFile));

  // The screens load the very same dictionary file the server uses, so the two can never drift.
  app.get('/terms.js', (req, res) => res.type('js').sendFile(path.join(__dirname, '..', 'util', 'terms.js')));

  app.use('/output', impl.static(cfg.resolved.output));
  app.use('/', impl.static(path.join(__dirname, 'public')));
  return app;
}

function guideShell(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><link rel="stylesheet" href="/guide.css"></head><body><main class="guide">${body}</main></body></html>`;
}

if (require.main === module) {
  const cfg = loadConfig();
  const db = openDb(cfg.resolved.db);
  const port = Number(process.env.PORT || 3000);
  createApp(cfg, db).listen(port, () => {
    console.log(`SECOND TAKE studio → http://localhost:${port}  (${express.isFallback ? 'built-in fallback server: run `npm install` for Express' : 'Express'})`);
  });
}

module.exports = { createApp };
