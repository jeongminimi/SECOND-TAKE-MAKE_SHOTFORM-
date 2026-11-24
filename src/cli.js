#!/usr/bin/env node
'use strict';
/**
 * Usage:
 *   node src/cli.js setup                         create DB, import test data, generate test clip
 *   node src/cli.js run [--date YYYY-MM-DD] [--reselect]   run the pipeline for one operating date (dry-run)
 *   node src/cli.js demo                          setup + run every scenario date in the test data
 *   node src/cli.js analyze [--asset KEY]         music-structure analysis → clip segment suggestions (proposals only)
 *   node src/cli.js approve --id N                approve a segment suggestion (re-run its date to re-render)
 *   node src/cli.js status                        print selections / reels / jobs
 *   node src/cli.js reset --yes                   empty all tables (keeps files)
 */
const path = require('node:path');
const { loadConfig } = require('./config');
const { openDb } = require('./db');
const { importFile } = require('./ingest/importJson');
const { ensureTestClip } = require('./setup/testAssets');
const { runDay } = require('./pipeline');
const { todayIn } = require('./util/time');
const { checkFfmpeg } = require('./render/ffmpeg');
const { analyzeAssets, approveSuggestion } = require('./analysis/structure');

const SEED = path.join(__dirname, '..', 'data', 'seed', 'test-candidates.json');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) out[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out[k] = argv[++i];
      else out[k] = true;
    } else out._.push(a);
  }
  return out;
}

async function setup(cfg, db, seedFile = SEED) {
  const ff = checkFfmpeg(cfg);
  console.log(ff.ok ? `FFmpeg: ${ff.version}` : `FFmpeg NOT available: ${ff.error}`);
  const { counts } = importFile(db, seedFile);
  console.log(`Imported: ${JSON.stringify(counts)}`);
  if (ff.ok) {
    const t = await ensureTestClip(cfg);
    console.log(`Test clip: ${path.relative(cfg.resolved.root, t.file)} (${t.created ? 'generated' : 'already present'})`);
  }
}

function summarize(r) {
  const s = r.selection;
  const head = `${r.operatingDate} [rev ${s.revision}${r.selectionReused ? ', reused' : ''}]`;
  if (s.status === 'skipped') return `${head} SKIPPED — ${s.skip_reason}`;
  const reel = r.reel;
  return [
    `${head} score ${s.score} → ${reel.output_format} (reel #${reel.id}${r.reelCreated ? ' new' : ' existing'}, render ${reel.render_status}${r.rendered ? '' : ' (skipped, already done)'})`,
    `   title : ${reel.title_en}`,
    `   file  : ${reel.output_path ?? '-'}${reel.render_error ? `  ERROR: ${reel.render_error}` : ''}`,
    `   job   : ${r.job ? `#${r.job.id} ${r.job.mode} ${r.job.status} @ ${r.job.scheduled_at} — ${r.job.expected_status}` : '-'}`,
  ].join('\n');
}

function printAnalysis(results) {
  for (const r of results) {
    if (!r.suggestion) { console.log(`  ${r.asset_key}: no suggestion — ${r.reason}`); continue; }
    const s = r.suggestion;
    console.log(`  ${r.asset_key}: #${s.id} [${r.analyzer}] ${s.label} ${s.suggested_start_sec}–${s.suggested_end_sec}s (${s.status}${r.alreadyApplied ? ', already applied' : ''})`);
  }
}

function status(db) {
  const rows = db.prepare(`
    SELECT ds.operating_date, ds.status, ds.score, ds.revision, pc.candidate_key, r.id AS reel_id, r.output_format, r.render_status,
           pj.id AS job_id, pj.status AS job_status, pj.scheduled_at
      FROM daily_selections ds
      LEFT JOIN performance_candidates pc ON pc.id = ds.candidate_id
      LEFT JOIN reels r ON r.selection_id = ds.id
      LEFT JOIN publish_jobs pj ON pj.reel_id = r.id
     ORDER BY ds.operating_date`).all();
  console.table(rows);
  const c = (t) => db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
  console.log(`counts: selections=${c('daily_selections')} reels=${c('reels')} publish_jobs=${c('publish_jobs')} metric_snapshots=${c('metric_snapshots')}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] ?? 'help';
  const cfg = loadConfig(args.db ? { paths: { db: args.db } } : {});
  const db = openDb(cfg.resolved.db);
  try {
    if (cmd === 'setup') await setup(cfg, db);
    else if (cmd === 'run') {
      const date = args.date ?? todayIn(cfg.timezone);
      console.log(summarize(await runDay(db, cfg, date, { reselect: Boolean(args.reselect) })));
    } else if (cmd === 'demo') {
      await setup(cfg, db);
      const dates = Object.keys(require(SEED)._meta.scenarioDates);
      for (const d of dates) console.log(summarize(await runDay(db, cfg, d)));
      console.log('\nSegment suggestions (music-structure analysis; proposals only, nothing changes until approved):');
      printAnalysis(analyzeAssets(db, cfg));
      console.log('\nRe-run of the same dates (must not create anything new):');
      for (const d of dates) console.log(summarize(await runDay(db, cfg, d)));
      status(db);
      console.log('\nOpen the local UI: npm start → http://localhost:3000');
    } else if (cmd === 'analyze') {
      printAnalysis(analyzeAssets(db, cfg, { assetKey: args.asset ?? null }));
    } else if (cmd === 'approve') {
      if (!args.id) throw new Error('approve needs --id <suggestion id>');
      const r = approveSuggestion(db, cfg, Number(args.id));
      console.log(`Approved #${r.suggestion.id}. Reels to re-render on next run of their date: ${r.reelsToRerender.join(', ') || 'none'}`);
    } else if (cmd === 'export') {
      const { exportReel } = require('./export/exportReel');
      const r = exportReel(db, cfg, { date: args.date ?? null, reelId: args.reel ?? null, dir: args.to ?? null });
      console.log(`${r.reel.operating_date} · ${r.reel.performer_en} – ${r.reel.song_en} → ${r.dir}`);
      const size = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
      for (const f of r.files) console.log(`  ${f.name}  ${size(f.bytes)}`);
    } else if (cmd === 'status') status(db);
    else if (cmd === 'reset') {
      if (!args.yes) throw new Error('reset empties every table. Re-run with --yes.');
      for (const t of ['metric_snapshots', 'account_metric_snapshots', 'publish_jobs', 'reels', 'daily_selections', 'usage_permissions', 'clip_assets', 'performance_candidates', 'tracks', 'source_videos', 'source_channels']) db.exec(`DELETE FROM ${t}`);
      console.log('All tables emptied.');
    } else {
      console.log(require('node:fs').readFileSync(__filename, 'utf8').split('\n').slice(2, 12).join('\n'));
    }
  } finally {
    db.close();
  }
}

if (require.main === module) main().catch((e) => { console.error(`Error: ${e.message}`); process.exit(1); });
module.exports = { setup, summarize, SEED };
