'use strict';
/**
 * Diagnoses (and optionally repairs) storage/app.db.
 *   node tools/db-doctor.js            진단만
 *   node tools/db-doctor.js --repair   손상 시 백업 후 새로 만들기
 *
 * The database is rebuildable from data/seed, so repair never destroys anything:
 * the old file is renamed aside, never deleted.
 */
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const DB = path.join(ROOT, 'storage', 'app.db');
const JOURNAL = DB + '-journal';
const repair = process.argv.includes('--repair');
const line = (s = '') => console.log(s);

function human(n) { return `${(n / 1024 / 1024).toFixed(1)}MB`; }

function freeSpace() {
  try {
    const st = fs.statfsSync(ROOT);
    return { free: st.bfree * st.bsize, total: st.blocks * st.bsize };
  } catch { return null; }
}

function tryOpen() {
  let db;
  try {
    db = new DatabaseSync(DB);
    db.exec('PRAGMA foreign_keys = ON;');
    const integrity = db.prepare('PRAGMA integrity_check').get();
    const ok = String(Object.values(integrity)[0] ?? '').toLowerCase() === 'ok';
    // the exact query the screen makes on load
    const n = db.prepare('SELECT COUNT(*) c FROM daily_selections').get().c;
    const cand = db.prepare('SELECT COUNT(*) c FROM performance_candidates').get().c;
    const clips = db.prepare('SELECT COUNT(*) c FROM clip_assets').get().c;
    db.close();
    return { ok, integrity: Object.values(integrity)[0], counts: { 운영기록: n, 후보: cand, 클립: clips } };
  } catch (e) {
    try { db?.close(); } catch { /* already broken */ }
    return { ok: false, error: e.message, code: e.code };
  }
}

line('════════ 데이터베이스 점검 ════════');
line();

const sp = freeSpace();
if (sp) {
  line(`디스크 여유 공간 : ${human(sp.free)} / ${human(sp.total)}`);
  if (sp.free < 500 * 1024 * 1024) line('  ⚠ 여유 공간이 500MB 미만입니다. 이것만으로도 disk I/O error가 납니다.');
} else line('디스크 여유 공간 : 확인 불가');

if (!fs.existsSync(DB)) {
  line('데이터베이스 파일 : 없음 (처음 실행하면 새로 만들어집니다)');
  line();
  line('→ 이 창을 닫고 start-studio.bat 을 실행하세요.');
  process.exit(0);
}
const st = fs.statSync(DB);
line(`데이터베이스 파일 : ${human(st.size)}  (마지막 수정 ${st.mtime.toLocaleString('ko-KR')})`);
if (fs.existsSync(JOURNAL)) {
  const js = fs.statSync(JOURNAL);
  line(`임시 기록 파일    : ${js.size} bytes` + (js.size > 0 ? '  ⚠ 비정상 종료 흔적일 수 있습니다' : '  (정상)'));
}
line();

const r = tryOpen();
if (r.ok) {
  line('결과 : ✅ 정상입니다. 데이터베이스는 문제가 없습니다.');
  line(`       저장된 내용 → ${Object.entries(r.counts).map(([k, v]) => `${k} ${v}건`).join(', ')}`);
  line();
  line('화면에 오류가 계속 나온다면 데이터베이스가 아닌 다른 원인입니다.');
  line('검은 창(서버)을 모두 닫고 start-studio.bat 을 다시 한 번만 실행해 보세요.');
  process.exit(0);
}

line(`결과 : ❌ 읽을 수 없습니다`);
line(`       오류: ${r.error}`);
if (r.integrity) line(`       무결성 검사: ${r.integrity}`);
line();

if (/disk I\/O|SQLITE_IOERR/i.test(r.error ?? '')) {
  line('가능한 원인');
  line('  1) 서버가 아직 떠 있어 파일을 붙잡고 있음  → 검은 창을 모두 닫고 다시 실행');
  line('  2) 디스크 여유 공간 부족                  → 위의 여유 공간 확인');
  line('  3) 백신·클라우드 동기화가 파일을 잠금      → 폴더를 검사 예외로 추가');
  line('  4) 파일 자체가 깨짐                       → 아래 복구');
  line();
}

if (!repair) {
  line('복구하려면 이 창을 닫고 fix-db.bat 을 실행한 뒤 Y 를 누르세요.');
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const bak = `${DB}.손상본-${stamp}`;
line('── 복구 시작 ──');
try {
  fs.renameSync(DB, bak);
  line(`기존 파일을 보관했습니다 (지우지 않았습니다): ${path.basename(bak)}`);
  if (fs.existsSync(JOURNAL)) { fs.renameSync(JOURNAL, `${bak}-journal`); }
} catch (e) {
  line(`❌ 파일을 옮길 수 없습니다: ${e.message}`);
  line('   → 서버(검은 창)가 아직 떠 있을 가능성이 큽니다. 모두 닫고 다시 실행하세요.');
  process.exit(1);
}

try {
  const { loadConfig } = require(path.join(ROOT, 'src', 'config.js'));
  const { openDb } = require(path.join(ROOT, 'src', 'db'));
  const { importFile } = require(path.join(ROOT, 'src', 'ingest', 'importJson.js'));
  const cfg = loadConfig();
  const db = openDb(cfg.resolved.db);
  const { counts } = importFile(db, path.join(ROOT, 'data', 'seed', 'test-candidates.json'));
  db.close();
  line(`새 데이터베이스를 만들고 예시 데이터를 넣었습니다: ${JSON.stringify(counts)}`);
  line();
  line('✅ 복구 완료. 이 창을 닫고 start-studio.bat 을 실행하세요.');
  line();
  line('※ 직접 등록하셨던 내용은 새 파일에 없습니다.');
  line(`   보관된 ${path.basename(bak)} 에 남아 있으니 지우지 마세요. 복구 방법을 물어보시면 안내드립니다.`);
} catch (e) {
  line(`❌ 새로 만들기 실패: ${e.message}`);
  line('   → 보관해 둔 파일 이름을 app.db 로 되돌리면 원래 상태로 돌아갑니다.');
  process.exit(1);
}
