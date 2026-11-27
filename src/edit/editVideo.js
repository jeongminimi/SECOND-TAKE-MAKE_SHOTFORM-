'use strict';
/**
 * 영상 편집기 — the operator's own file, cut by hand.
 *
 * This is the whole program now, from the screen's point of view: pick a file you already have, watch
 * it, mark the part you want, frame it for 9:16, export. Nothing here selects a song, scores a
 * candidate, judges rights or writes a caption — those paths still exist under src/selection,
 * src/rights and src/copy, and the daily pipeline still uses them; the screen simply does not.
 *
 * It renders through src/render/renderReel.js rather than a second renderer. That function takes plain
 * objects and touches no table, so the same 9:16 output, the same crop/zoom maths and the same
 * 1080×1920 check apply to a hand cut as to a pipeline reel. What differs is only what is drawn: the
 * editor's templates carry one line of text, the source credit, and nothing else.
 *
 * Output is always 1080×1920. The operator cuts a stage out of a wider video, so framing (zoom, left/
 * right, up/down) is part of cutting, not a later step.
 */
const fs = require('node:fs');
const path = require('node:path');
const { fromStoredPath, toStoredPath } = require('../config');
const { renderReel, ZOOM_MIN, ZOOM_MAX } = require('../render/renderReel');
const { probe } = require('../render/ffmpeg');

/**
 * What the editor can choose.
 *
 * The first two are the picture alone. The other three are the text shapes the account has used from
 * the start — the same templates the automatic pipeline renders — except that every word in them is
 * typed by the operator in the editor. The program fills in nothing but the account name.
 */
/**
 * Is `target` inside `root`?
 *
 * `path.relative()` alone is not enough on Windows: between two different drives it returns an
 * absolute path ("C:\\Windows"), which does not start with ".." — so a check written that way lets
 * any path on another drive through. Both conditions are needed.
 */
function isInside(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

const SHAPES = ['edit-fill', 'edit-fit', 'clip-standard', 'clip-large', 'clip-full'];
/** The shapes that carry words, i.e. the ones whose text fields are worth showing. */
const TEXT_SHAPES = ['clip-standard', 'clip-large', 'clip-full'];
const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const clamp = (v, lo, hi) => (v == null ? null : Math.min(hi, Math.max(lo, v)));

/** `1:23` / `83` / `1:23.5` → seconds. Null when it cannot be read — nothing is guessed. */
function toSeconds(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v ?? '').trim();
  if (s === '') return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(s);
  if (!m || Number(m[2]) > 59 || Number(m[3]) >= 60) return null;
  return (Number(m[1] ?? 0) * 3600) + (Number(m[2]) * 60) + Number(m[3]);
}

const fmt = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

/**
 * Everything the screen sent, checked. Refusals are in Korean and name what to fix — the screen is
 * the only caller, and the person reading them is the operator.
 */
function shapeEdit(cfg, d = {}) {
  const fileRef = String(d.file_ref ?? '').trim();
  if (!fileRef) throw new Error('영상 파일을 고르세요.');
  const abs = fromStoredPath(cfg, fileRef);
  if (!isInside(cfg.resolved.video, abs) && !isInside(cfg.resolved.clips, abs)) {
    throw new Error('이 프로그램이 다루는 영상 폴더 밖의 파일입니다.');
  }
  if (!fs.existsSync(abs)) throw new Error(`영상 파일이 없습니다: ${fileRef}`);

  const start = toSeconds(d.start_sec);
  const end = toSeconds(d.end_sec);
  if (start == null) throw new Error('구간 시작을 넣으세요. 영상을 재생하고 「여기부터」를 누르면 들어갑니다.');
  if (end == null) throw new Error('구간 끝을 넣으세요. 영상을 재생하고 「여기까지」를 누르면 들어갑니다.');
  if (end <= start) throw new Error('구간 끝이 시작보다 뒤여야 합니다.');

  const max = cfg.render.maxClipDurationSec;
  if (end - start > max) throw new Error(`구간이 ${fmt(end - start)}입니다. 릴스 한 편은 최대 ${max}초까지만 만듭니다.`);

  const info = probe(cfg, abs);
  if (info?.duration != null && start >= info.duration) {
    throw new Error(`구간 시작(${fmt(start)})이 영상 길이(${fmt(info.duration)})를 넘습니다.`);
  }
  // A cut that runs past the end of the file would render a short clip without saying so.
  const hardEnd = info?.duration != null ? Math.min(end, info.duration) : end;
  if (hardEnd - start < 1) throw new Error('구간이 1초보다 짧습니다.');

  const shape = SHAPES.includes(d.shape) ? d.shape : 'edit-fill';
  const creditOn = d.credit_on === undefined ? 1 : (d.credit_on ? 1 : 0);
  const creditText = String(d.credit_text ?? '').trim();
  // The line is what the video itself says about where the performance came from. Turning it on with
  // nothing typed would burn an empty line into the picture, so that combination is refused here
  // rather than silently drawing nothing.
  if (creditOn && !creditText) throw new Error('출처를 적거나, 출처 표시를 끄세요. 빈 줄을 영상에 넣지는 않습니다.');

  return {
    file_ref: fileRef,
    file_name: String(d.file_name ?? path.basename(abs)),
    start_sec: Math.round(start * 1000) / 1000,
    end_sec: Math.round(hardEnd * 1000) / 1000,
    shape,
    zoom: clamp(num(d.zoom), ZOOM_MIN, ZOOM_MAX),
    crop_x: clamp(num(d.crop_x), 0, 1),
    crop_y: clamp(num(d.crop_y), 0, 1),
    credit_on: creditOn,
    credit_text: creditText || null,
    // Kept exactly as typed. Nothing here is generated, translated or filled in from anywhere —
    // an empty field simply means that line is not drawn.
    ...Object.fromEntries(TEXT_COLS.map((c) => [c, String(d[c] ?? '').trim() || null])),
    hashtags: String(d.hashtags ?? '').trim() || null,
    // Instagram refuses a caption over 2,200 characters, so it is refused here rather than at the
    // moment of pasting. Nothing is trimmed silently.
    caption: (() => {
      const c = String(d.caption ?? '').replace(/\r\n?/g, '\n').trim();
      if ([...c].length > 2200) throw new Error(`올릴 글이 ${[...c].length}자입니다. 인스타그램은 2,200자까지만 받습니다.`);
      return c || null;
    })(),
  };
}

const TEXT_COLS = ['tag_text', 'title_text', 'performer_text', 'ko_text', 'why_text', 'footer_text'];
const COLS = ['file_ref', 'file_name', 'start_sec', 'end_sec', 'shape', 'zoom', 'crop_x', 'crop_y',
  'credit_on', 'credit_text', ...TEXT_COLS, 'hashtags', 'caption'];

/** Saves the cut (new, or the same row again when an id is given) without rendering anything. */
function saveEdit(db, cfg, d = {}) {
  const row = shapeEdit(cfg, d);
  const id = num(d.id);
  if (id) {
    const set = COLS.map((c) => `${c} = ?`).join(', ');
    const updated = db.prepare(`UPDATE edits SET ${set}, render_status = 'pending', render_error = NULL,
      updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ? RETURNING *`).get(...COLS.map((c) => row[c]), id);
    if (!updated) throw new Error(`${id}번 작업이 없습니다.`);
    return updated;
  }
  return db.prepare(`INSERT INTO edits (${COLS.join(', ')}) VALUES (${COLS.map(() => '?').join(', ')}) RETURNING *`)
    .get(...COLS.map((c) => row[c]));
}

const getEdit = (db, id) => db.prepare('SELECT * FROM edits WHERE id = ?').get(Number(id)) ?? null;

/**
 * Records that this video was posted. The program does not post — it cannot know for itself — so
 * this is the operator saying so, and it exists to stop the same cut going up twice.
 */
function markPosted(db, id, posted = true) {
  const row = db.prepare(`UPDATE edits SET posted_at = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
    WHERE id = ? RETURNING *`).get(posted ? new Date().toISOString().replace(/\.\d+Z$/, 'Z') : null, Number(id));
  if (!row) throw new Error(`${id}번 작업이 없습니다.`);
  return row;
}
const listEdits = (db, limit = 30) => db.prepare('SELECT * FROM edits ORDER BY created_at DESC, id DESC LIMIT ?').all(Number(limit));

/** The in-memory objects renderReel expects. No row is created for any of them. */
function renderInput(edit, brandName = '') {
  return {
    reel: {
      id: `edit-${edit.id}`,
      output_format: 'licensed_clip',
      template_id: edit.shape,
      crop_x: edit.crop_x, crop_y: edit.crop_y, zoom: edit.zoom,
    },
    clipAsset: {
      file_ref: edit.file_ref,
      source_start_sec: edit.start_sec,
      source_end_sec: edit.end_sec,
      // The operator's file IS the original, so the moment and its position in the file are the same.
      file_offset_sec: edit.start_sec,
      // No rights were recorded, and the editor never claims otherwise: this keeps the burnt-in line
      // a source credit instead of a permission it does not have.
      personal_use_only: 1,
      permissions: [],
    },
    copy: {
      graphic: {
        // The account's own name is the one thing the program supplies; everything else was typed.
        brand: brandName,
        // The accent colour follows the little box the operator typed, the same way the pipeline's
        // follows the candidate's version. compose.js picks it from the same word.
        versionKey: /cover/i.test(edit.tag_text ?? '') ? 'cover'
          : (['band', 'acoustic', 'piano', 'unplugged', 'orchestra', 'jazz'].find((k) => new RegExp(k, 'i').test(edit.tag_text ?? '')) ?? 'live'),
        tag: (edit.tag_text ?? '').toUpperCase(),
        headline: edit.title_text ?? '',
        performerLine: edit.performer_text ?? '',
        koLine: edit.ko_text ?? '',
        why: edit.why_text ?? '',
        footer: edit.footer_text ?? '',
        sourceCredit: edit.credit_on && edit.credit_text ? edit.credit_text : '',
        cues: [],
      },
    },
  };
}

/** One still frame of exactly what the render would produce, into a folder that is thrown away. */
async function previewEdit(cfg, edit, previewDir) {
  const { reel, clipAsset, copy } = renderInput(edit, cfg.account?.displayName ?? '');
  return renderReel({ cfg, reel, copy, clipAsset, operatingDate: 'edit', templateId: edit.shape, previewDir });
}

/** Renders the cut to 1080×1920 and records where the file landed. */
async function renderEdit(db, cfg, id) {
  const edit = getEdit(db, id);
  if (!edit) throw new Error(`${id}번 작업이 없습니다.`);
  db.prepare("UPDATE edits SET render_status = 'rendering', render_error = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?").run(edit.id);
  try {
    const { reel, clipAsset, copy } = renderInput(edit, cfg.account?.displayName ?? '');
    const out = await renderReel({ cfg, reel, copy, clipAsset, operatingDate: 'edit', templateId: edit.shape });
    return db.prepare(`UPDATE edits SET render_status = 'done', output_path = ?, poster_path = ?,
      updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ? RETURNING *`)
      .get(out.outputPath, out.posterPath, edit.id);
  } catch (e) {
    db.prepare(`UPDATE edits SET render_status = 'failed', render_error = ?,
      updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`).run(String(e.message).slice(0, 800), edit.id);
    throw e;
  }
}

const safeName = (s) => String(s ?? '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 70) || '영상';

/**
 * Copies the finished video out to a folder the operator opens in Explorer.
 *
 * What goes in it: the video, its first frame, the hashtags if any were typed, and a short note. The
 * note says where the file came from and that rights were not checked — the editor does not judge
 * rights, so the reminder belongs with the file that leaves the program.
 */
function exportEdit(db, cfg, { id, dir = null } = {}) {
  const edit = getEdit(db, id);
  if (!edit) throw new Error(`${id}번 작업이 없습니다.`);
  if (edit.render_status !== 'done' || !edit.output_path) throw new Error('먼저 영상을 만들어 주세요.');
  const video = fromStoredPath(cfg, edit.output_path);
  if (!fs.existsSync(video)) throw new Error('만든 영상 파일을 찾을 수 없습니다. 다시 만들어 주세요.');

  const stem = `${edit.created_at.slice(0, 10)}_${safeName(path.basename(edit.file_name ?? '', path.extname(edit.file_name ?? '')))}`;
  const base = dir ? path.resolve(dir) : path.join(cfg.resolved.output, '내보내기');
  let outDir = path.join(base, stem);
  for (let i = 2; fs.existsSync(outDir); i += 1) outDir = path.join(base, `${stem} (${i})`);
  fs.mkdirSync(outDir, { recursive: true });

  const files = [];
  const copy = (from, name) => {
    fs.copyFileSync(from, path.join(outDir, name));
    files.push({ name, bytes: fs.statSync(path.join(outDir, name)).size });
  };
  const write = (name, text) => {
    fs.writeFileSync(path.join(outDir, name), text, 'utf8');
    files.push({ name, bytes: Buffer.byteLength(text, 'utf8') });
  };

  const videoName = `${safeName(stem)}.mp4`;
  copy(video, videoName);
  if (edit.poster_path && fs.existsSync(fromStoredPath(cfg, edit.poster_path))) copy(fromStoredPath(cfg, edit.poster_path), '첫화면.png');
  // What gets pasted into Instagram. The caption is the operator's own text; the hashtags are added
  // underneath only when they are not already part of it.
  const tags = edit.hashtags ?? '';
  const caption = edit.caption ?? '';
  const post = [caption, tags && !caption.includes(tags.split(/\s+/)[0]) ? `\n${tags}` : ''].filter(Boolean).join('\n');
  if (post.trim()) write('인스타에_올릴_글.txt', `${post.trim()}\n`);
  else if (tags) write('해시태그.txt', `${tags}\n`);
  write('읽어보기.txt', [
    '⚠ 이 영상은 권리를 확인하지 않았습니다. 올릴지는 운영자가 판단하세요.',
    '='.repeat(58),
    '',
    `만든 날짜   ${edit.created_at.slice(0, 10)}`,
    `원본 파일   ${edit.file_name ?? edit.file_ref}`,
    `쓴 구간     ${fmt(edit.start_sec)} ~ ${fmt(edit.end_sec)}  (${Math.round((edit.end_sec - edit.start_sec) * 10) / 10}초)`,
    `모양        ${edit.shape === 'edit-fit' ? '전체 보이기 (위아래 여백)' : '꽉 채우기 (좌우 잘림)'} · 1080×1920`,
    `출처 자막   ${edit.credit_on && edit.credit_text ? edit.credit_text : '(넣지 않음)'}`,
    '',
    '폴더에 든 것',
    `  ${videoName}`,
    '  첫화면.png        영상 첫 장면입니다.',
    post.trim() ? '  인스타에_올릴_글.txt  복사해서 그대로 붙여 넣으세요.' : (tags ? '  해시태그.txt      복사해서 글에 붙이세요.' : null),
    '',
    '이 프로그램은 영상을 올려 주지 않습니다. 인스타그램에는 직접 올리세요.',
    '남의 무대 영상이라면 권리는 운영자 책임입니다.',
  ].filter((l) => l !== null).join('\n'));

  return { dir: toStoredPath(cfg, outDir), absDir: outDir, files };
}

module.exports = {
  isInside, SHAPES, TEXT_SHAPES, TEXT_COLS, toSeconds, markPosted, fmt, shapeEdit, saveEdit, getEdit, listEdits,
  previewEdit, renderEdit, exportEdit,
};
