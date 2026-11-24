'use strict';
/**
 * Puts one finished reel into a folder a person can open, with a plain-Korean note explaining what
 * it is and how it was judged. The studio screen already shows all of this; this exists so a result
 * can leave the tool — to be looked at later, or shown to someone who will never run it.
 *
 * The caption file keeps the English exactly as it will be posted. Only the note is Korean.
 */
const fs = require('node:fs');
const path = require('node:path');
const { fromStoredPath } = require('../config');
const { json } = require('../db');
const T = require('../util/terms');

const REEL_SQL = `
  SELECT r.*, ds.operating_date, ds.score, ds.reason, ds.reason_ko, ds.revision,
         pc.performer_en, pc.performer_ko, pc.program_name, pc.candidate_key,
         t.title_en AS song_en, t.title_ko AS song_ko, ca.personal_use_only
    FROM reels r
    JOIN daily_selections ds ON ds.id = r.selection_id
    LEFT JOIN performance_candidates pc ON pc.id = ds.candidate_id
    LEFT JOIN tracks t ON t.id = pc.track_id
    LEFT JOIN clip_assets ca ON ca.id = r.clip_asset_id`;

function pickReel(db, { date, reelId }) {
  if (reelId) return db.prepare(`${REEL_SQL} WHERE r.id = ?`).get(Number(reelId));
  if (date) return db.prepare(`${REEL_SQL} WHERE ds.operating_date = ?`).get(date);
  return db.prepare(`${REEL_SQL} WHERE r.render_status = 'done' ORDER BY ds.operating_date DESC LIMIT 1`).get();
}

function note(r, job, plan, videoName) {
  const checks = (plan.checks ?? []).map((c) => `  ${c.ok ? '[확인]' : '[문제]'} ${c.label_ko ?? c.label}`).join('\n');
  const live = (plan.live_readiness ?? []).map((n) => `  - ${n.ko ?? n.en ?? n}`).join('\n');
  const rev = T.revision(r.revision);
  // A personal-use render has no rights behind it, so the warning goes first — before anything else is read.
  const warn = r.personal_use_only ? '⚠ 이 영상은 권리를 확인하지 않은 개인 확인용입니다. 공개 게시하지 마세요.\n\n' : '';
  return `${warn}SECOND TAKE — 내보낸 릴스 한 편
${'='.repeat(46)}

■ 무엇인가요
${r.operating_date} 운영일에 이 프로그램이 골라서 만든 릴스입니다.
형식: ${T.ko('format', r.output_format)}  (디자인 틀: ${T.ko('template', r.template_id)})

■ 누구의 어떤 공연인가요
${r.performer_en ?? '공연자 미입력'} – ${r.song_en ?? r.song_ko ?? '곡 미연결'}
${[r.performer_ko, r.song_ko].filter(Boolean).join(' – ')}
${r.program_name ?? ''}

■ 왜 이것이 뽑혔나요 (${r.score}점 / 100점)
${r.reason_ko ?? r.reason ?? '-'}

■ 왜 이 형식인가요
${r.format_reason_ko ?? r.format_reason}

■ 발행 예행 연습 결과
${job ? `${T.ko('jobStatus', job.status)} — ${job.expected_status_ko ?? job.expected_status}` : '예약 작업이 없습니다.'}
예약하려던 시각: ${plan.scheduled_local ?? '-'}

점검 내역:
${checks || '  (없음)'}

실제로 올릴 때 확인할 것:
${live || '  (없음)'}

■ 파일 설명
  ${videoName}
                       1080x1920 세로 영상. 이 파일이 그대로 올라갑니다.
  첫화면.png           영상 첫 장면 이미지입니다.
  인스타에_올릴_글.txt   캡션 전문입니다. 영어 그대로 올립니다.
                       해외 K팝 팬이 대상이라 번역하지 않습니다.

■ 내부 식별자 (문제가 생겼을 때 알려주시면 됩니다)
  릴스 #${r.id} · 후보 ${r.candidate_key} · 운영일 ${r.operating_date}${rev ? ` · ${rev}` : ''}
`;
}

/**
 * Strips what Windows refuses in a file or folder name, so an English headline can be used as one.
 * A trailing space or dot is also illegal, and a long name is cut rather than rejected.
 */
function safeName(s, fallback) {
  const cleaned = String(s ?? '')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    .replace(/[ .]+$/, '');
  return cleaned || fallback;
}

/**
 * Writes one reel into its own folder under output/내보내기 and returns what landed in it.
 * Only this reel's folder is replaced — earlier exports of other reels stay where they are.
 */
function exportReel(db, cfg, { date = null, reelId = null, dir = null } = {}) {
  const r = pickReel(db, { date, reelId });
  if (!r) throw new Error(date ? `No reel for ${date}. Run that date first.` : 'No rendered reel to export yet.');
  if (r.render_status !== 'done') throw new Error(`Reel ${r.id} is not rendered yet (${r.render_status}). Run the date again to finish it.`);

  const job = db.prepare("SELECT * FROM publish_jobs WHERE reel_id = ? AND mode = 'dry_run'").get(r.id);
  const plan = json.parse(job?.plan_json, {});
  const title = safeName(r.title_en, `reel-${r.id}`);
  const outDir = dir
    ? path.resolve(dir)
    : path.join(cfg.resolved.output, '내보내기', `${r.operating_date}_${title}`);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const files = [];
  const copy = (stored, name) => {
    if (!stored) return;
    const src = fromStoredPath(cfg, stored);
    if (!fs.existsSync(src)) return;
    fs.copyFileSync(src, path.join(outDir, name));
    files.push({ name, bytes: fs.statSync(path.join(outDir, name)).size });
  };
  const videoName = `${title}.mp4`;
  copy(r.output_path, videoName);
  copy(r.poster_path, '첫화면.png');

  const write = (name, text) => {
    fs.writeFileSync(path.join(outDir, name), text, 'utf8');
    files.push({ name, bytes: Buffer.byteLength(text, 'utf8') });
  };
  write('인스타에_올릴_글.txt', r.caption);
  write('읽어보기.txt', note(r, job, plan, videoName));

  return { dir: outDir, reel: r, files };
}

module.exports = { exportReel, safeName };
