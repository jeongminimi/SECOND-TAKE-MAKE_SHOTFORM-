'use strict';
/**
 * The few helpers every screen needs. Kept in its own file so the editor does not have to load the
 * operating screen (app.js) to get them, and so the two cannot declare the same name twice — loading
 * both in one page is a SyntaxError that silently kills the second file.
 *
 * app.js, create.js and manage.js are the automatic pipeline's screens. They are still served and
 * still work, but the page no longer loads them: the program the operator opens is the editor.
 */
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const size = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);

/** `83.5` → `1:23`. Seconds are floored, because a cut starts on the frame you are looking at. */
const mmss = (sec) => {
  const n = Number(sec);
  if (!Number.isFinite(n) || n < 0) return '0:00';
  return `${Math.floor(n / 60)}:${String(Math.floor(n % 60)).padStart(2, '0')}`;
};

/** `1:23` / `83` / `1:23.5` → seconds; null when it cannot be read. Mirrors toSeconds() on the server. */
function toSeconds(v) {
  const s = String(v ?? '').trim();
  if (s === '') return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(s);
  if (!m || Number(m[2]) > 59 || Number(m[3]) >= 60) return null;
  return (Number(m[1] ?? 0) * 3600) + (Number(m[2]) * 60) + Number(m[3]);
}

async function api(path, opts) {
  const r = await fetch(path, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    // A refusal carries the Korean reason that says what to fix; the English message is the fallback.
    const err = new Error(j.error || r.statusText);
    err.error_ko = j.error_ko ?? null;
    err.issues = j.issues ?? null;
    err.code = j.code ?? null;
    throw err;
  }
  return j;
}

function notice(msg, err = false) {
  const n = $('#notice');
  if (!n) return;
  if (!msg) { n.hidden = true; return; }
  n.hidden = false;
  n.className = 'notice' + (err ? ' err' : '');
  n.textContent = msg;
}
