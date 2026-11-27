'use strict';
/**
 * 영상 편집기 — the 9:16 frame is the screen.
 *
 * What the operator looks at is the thing they are making: the composed 9:16 frame, with their own
 * file playing inside it and the words sitting where they will sit. The raw video is never shown on
 * its own, because the parts that fall outside the frame are not in the result.
 *
 * Text is edited where it is drawn. The boxes over the picture are the fields — typing in one is
 * typing into the video. An empty one is still shown, greyed, so there is something to click; the
 * renderer draws nothing for it, which is what 「실제 결과 확인」 shows.
 *
 * compose.js lays the frame out from the same template JSON the renderer reads, so this is a preview
 * of the real thing, not a second design. Where the two can differ (line wrapping, a pixel or two of
 * placement) is on the server frame that button fetches.
 */

const E = {
  files: [], file: null,
  start: null, end: null,
  shape: 'edit-fill', zoom: 1, cropX: 0.5, cropY: 0.5,
  creditOn: true,
  text: {},            // tag_text / title_text / performer_text / ko_text / why_text / footer_text / credit_text
  shapes: [],          // template JSON from the server
  edit: null, maxSec: 30,
  natural: { w: 16, h: 9 },
  ghosts: true,
  guides: false,      // 피드·격자에서 잘리는 범위 안내선
  caption: '',
  exported: null,     // 마지막으로 내보낸 폴더       // 빈 자리에 예시 글씨를 띄워 둔다 — 누를 곳이 있어야 하니까
  videoEl: null,
};

const el = (id) => document.getElementById(id);
const tplOf = (id) => E.shapes.find((s) => s.id === id) ?? E.shapes[0] ?? null;
const dur = () => (E.end != null && E.start != null ? E.end - E.start : null);

const BINDS = { tag: 'tag_text', headline: 'title_text', performerLine: 'performer_text', koLine: 'ko_text', why: 'why_text', footer: 'footer_text', credit: 'credit_text' };

/** The bindings the frame draws, from what the operator typed. The brand is the account's own name. */
function bindings() {
  return {
    brand: E.brand ?? '',
    tag: (E.text.tag_text ?? '').toUpperCase(),
    headline: E.text.title_text ?? '',
    performerLine: E.text.performer_text ?? '',
    koLine: E.text.ko_text ?? '',
    why: E.text.why_text ?? '',
    footer: E.text.footer_text ?? '',
    credit: E.creditOn ? (E.text.credit_text ?? '') : '',
  };
}

// ── 9:16 화면 ────────────────────────────────────────────────────────────────────────────────────

/** Keeps the 1080-wide frame scaled to whatever room the column has. */
function fitFrame() {
  const wrap = el('frameWrap');
  const outer = el('frameOuter');
  if (!wrap || !outer) return;
  const avail = Math.min(wrap.clientWidth, (window.innerHeight - 330) * (1080 / 1920));
  const s = Math.max(0.12, Math.min(0.62, avail / 1080));
  outer.style.width = `${Math.round(1080 * s)}px`;
  outer.style.height = `${Math.round(1920 * s)}px`;
  el('frame').style.transform = `scale(${s})`;
}

function drawFrame() {
  const tpl = tplOf(E.shape);
  if (!tpl || !E.file) return;
  Compose.composeFrame(el('frame'), {
    tpl,
    data: bindings(),
    framing: { zoom: E.zoom, cropX: E.cropX, cropY: E.cropY },
    videoEl: E.videoEl,
    natural: E.natural,
    ghosts: E.ghosts,
    guides: E.guides,
  });
  fitFrame();
}

document.addEventListener('input', onPanelInput);

/**
 * The blocks and the frame point at each other: a block with the cursor in it outlines its line in
 * the picture, and clicking a line in the picture puts the cursor in its block. Nothing in the frame
 * is editable — typing happens in a plain input, so the caret never moves under the operator.
 */
document.addEventListener('focusin', (e) => {
  const bind = e.target.closest?.('[data-blockfor]')?.dataset.blockfor;
  for (const n of document.querySelectorAll('.cs-hi')) n.classList.remove('cs-hi');
  if (bind) for (const n of document.querySelectorAll(`#frame [data-bind="${bind}"]`)) n.classList.add('cs-hi');
});

document.addEventListener('click', (e) => {
  const line = e.target.closest?.('#frame [data-field]');
  if (!line) return;
  const input = document.querySelector(`[data-blockfor="${line.dataset.bind}"]`);
  if (!input) return;
  input.focus();
  // An example is not text to replace — the cursor just lands in an empty box, ready to type.
  if (!line.classList.contains('cs-ghost')) input.select?.();
  input.scrollIntoView({ block: 'nearest' });
});

// ── 오른쪽 조절판 ────────────────────────────────────────────────────────────────────────────────

/** What each slot is called, in the order the picture draws them. */
const BLOCK_KO = {
  tag: ['왼쪽 위 상자', 'COVER'],
  headline: ['큰 제목', 'DK X SEUNGKWAN covers Die With A Smile'],
  performerLine: ['공연자 줄', 'DK X SEUNGKWAN – Die With A Smile'],
  koLine: ['한글 줄 (선택)', '도겸X승관 – Die With A Smile'],
  why: ['한 줄 소개 (선택)', 'Two voices so locked in, you stop hearing the original.'],
  footer: ['아래 출처 줄 (선택)', 'SEVENTEEN Official'],
  credit: ['맨 아래 출처', 'Source: SEVENTEEN'],
};

/** The text slots the chosen shape actually has, in the order it draws them. */
function blocksOf(shapeId) {
  const tpl = tplOf(shapeId);
  if (!tpl) return [];
  const seen = new Set();
  return tpl.elements
    .filter((e) => e.bind && BINDS[e.bind] && !seen.has(e.bind) && seen.add(e.bind))
    .map((e) => ({
      bind: e.bind, field: BINDS[e.bind], wrap: e.wrap ?? null,
      label: BLOCK_KO[e.bind]?.[0] ?? e.bind, ph: BLOCK_KO[e.bind]?.[1] ?? '',
    }));
}

/** How many lines this text becomes in the picture, so a long title is noticed before it is drawn. */
function lineCount(b) {
  const v = E.text[b.field] ?? '';
  if (!v || !b.wrap) return v ? 1 : 0;
  return Compose.wrapText(b.bind === 'tag' ? v.toUpperCase() : v, b.wrap).length;
}

function blocksHtml() {
  const blocks = blocksOf(E.shape);
  if (!blocks.length) return '';
  return `<section class="card panel">
    <h3>글자 <span class="opt">(비우면 그 줄은 안 나옵니다)</span></h3>
    ${blocks.map((b) => {
      const n = lineCount(b);
      const over = Boolean(b.wrap) && n > 3;
      return `<div class="blk${over ? ' over' : ''}">
        <label for="blk-${b.field}">${esc(b.label)}
          ${b.bind === 'credit' ? `<input type="checkbox" id="creditOn"${E.creditOn ? ' checked' : ''} title="영상에 넣기">` : ''}
          <span class="lines">${b.wrap && n ? `${n}줄${over ? ' — 너무 깁니다' : ''}` : ''}</span></label>
        <input type="text" id="blk-${b.field}" data-blockfor="${b.bind}" data-field="${b.field}"
          value="${esc(E.text[b.field] ?? '')}" placeholder="${esc(b.ph)}"${b.bind === 'credit' && !E.creditOn ? ' disabled' : ''}>
      </div>`;
    }).join('')}
    <p class="small muted">칸을 누르면 화면에서 그 글자가 어디에 들어가는지 표시됩니다. 화면의 글자를 눌러도 해당 칸으로 옵니다.</p>
  </section>`;
}

function panelHtml() {
  return `
  ${blocksHtml()}

  <section class="card panel">
    <h3>모양</h3>
    <div class="shapes">
      ${E.shapes.map((s) => `<label class="check"><input type="radio" name="shape" value="${esc(s.id)}"${E.shape === s.id ? ' checked' : ''}> ${esc(s.name)}</label>`).join('')}
    </div>
    <p class="small muted" id="shapeNote">${esc(tplOf(E.shape)?.description ?? '')}</p>
  </section>

  <section class="card panel">
    <h3>영상 위치</h3>
    <label class="sl">확대 <output id="zoomOut">${E.zoom.toFixed(2)}×</output>
      <input type="range" id="zoom" min="1" max="2.5" step="0.05" value="${E.zoom}"></label>
    <label class="sl">좌우 <output id="cropXOut">${Math.round(E.cropX * 100)}%</output>
      <input type="range" id="cropX" min="0" max="1" step="0.01" value="${E.cropX}"></label>
    <label class="sl">위아래 <output id="cropYOut">${Math.round(E.cropY * 100)}%</output>
      <input type="range" id="cropY" min="0" max="1" step="0.01" value="${E.cropY}"></label>
  </section>

  <section class="card panel">
    <h3>해시태그 <span class="opt">(선택)</span></h3>
    <input type="text" id="hashtags" value="${esc(E.hashtags ?? '')}" placeholder="#kpop #seventeen">
    <span class="fhelp">내보낸 폴더의 해시태그.txt 에 그대로 담깁니다.</span>
  </section>

  <section class="card panel">
    <label class="check"><input type="checkbox" id="ghosts"${E.ghosts ? ' checked' : ''}> 빈 자리에 예시 글씨 보기</label>
    <label class="check"><input type="checkbox" id="guides"${E.guides ? ' checked' : ''}> 피드에서 잘리는 범위 보기</label>
    <span class="fhelp">릴스로 재생하면 다 보이지만, <b>피드에서는 가운데 4:5</b>, <b>프로필 격자에서는 가운데 1:1</b>만 보입니다. 그 밖에 둔 글씨는 거기서 안 보입니다.</span>
    <span class="fhelp">회색 기울임 글씨는 <b>실제 영상에 나오지 않습니다</b>. 어디에 무엇이 들어가는지 보여 주고, 누르면 그 칸으로 갑니다.</span>
    <div class="actions"><button class="btn ghost" id="realShot" type="button">실제 결과 확인</button></div>
    <span class="fhelp">화면은 결과와 거의 같지만, 긴 글의 줄바꿈 위치는 다를 수 있습니다. 만들기 전에 한 번 눌러 확인하세요.</span>
    <div id="shotBox" hidden><img id="shotImg" alt="실제 렌더 결과"><p class="small muted" id="shotNote"></p></div>
  </section>

  ${E.exported ? `<section class="card panel post">
    <h3>올릴 준비</h3>
    <label class="tfld">인스타에 올릴 글
      <textarea id="caption" rows="6" placeholder="여기에 올릴 글을 쓰세요">${esc(E.caption ?? '')}</textarea></label>
    <div class="actions"><button class="btn ghost tiny" id="fillCaption" type="button">블럭에서 불러오기</button>
      <span class="small muted" id="capLen">${[...(E.caption ?? '')].length}자 / 2200</span></div>
    <div class="actions big">
      <button class="btn" id="copyCaption" type="button">① 글 복사</button>
      <button class="btn ghost" id="openFolder" type="button">② 폴더 열기</button>
      <button class="btn ghost" id="openInsta" type="button">③ 인스타 열기</button>
    </div>
    <p class="small muted">폴더에서 영상을 끌어다 놓고, 글은 붙여넣기(Ctrl+V) 하세요. <b>올리기는 직접 누르셔야 합니다.</b></p>
    <label class="check"><input type="checkbox" id="posted"${E.edit?.posted_at ? ' checked' : ''}> 올렸습니다</label>
  </section>` : ''}

  <div class="actions big">
    <button class="btn" id="make" type="button">영상 만들기</button>
    <button class="btn ghost" id="export" type="button"${E.edit?.render_status === 'done' ? '' : ' disabled'}>내보내기</button>
  </div>
  <div class="upstate" id="state"></div>

  <section class="card panel">
    <h3>지난 작업</h3>
    <ol class="histList" id="history"></ol>
  </section>`;
}

/** Only the line counts change while typing; redrawing the panel would throw the caret away. */
function updateLines() {
  for (const b of blocksOf(E.shape)) {
    if (!b.wrap) continue;
    const box = document.querySelector(`[data-blockfor="${b.bind}"]`)?.closest('.blk');
    if (!box) continue;
    const n = lineCount(b);
    const over = n > 3;
    box.classList.toggle('over', over);
    const tag = box.querySelector('.lines');
    if (tag) tag.textContent = n ? `${n}줄${over ? ' — 너무 깁니다' : ''}` : '';
  }
}

function pickerHtml() {
  if (!E.files.length) {
    return `<p class="warnbox">storage/video 폴더가 비어 있습니다. 영상을 넣고 「다시 읽기」를 누르거나 파일을 올리세요.
      <button class="btn ghost tiny" id="reload" type="button">다시 읽기</button>
      <button class="btn ghost tiny" id="uploadBtn" type="button">파일 올리기</button></p>`;
  }
  return `<select id="fileList">
      <option value="">영상을 고르세요… (${E.files.length}개)</option>
      ${E.files.map((f) => `<option value="${esc(f.file_ref)}"${f.file_ref === E.file?.file_ref ? ' selected' : ''}>${esc(f.name)} · ${size(f.bytes)}</option>`).join('')}
    </select>
    <button class="btn ghost" id="uploadBtn" type="button">파일 올리기</button>
    <button class="btn ghost" id="reload" type="button">다시 읽기</button>
    <input type="file" id="file" accept="video/*" hidden>`;
}

function render() {
  el('picker').innerHTML = pickerHtml();
  el('panel').innerHTML = panelHtml();
  el('transport').hidden = !E.file;
  el('frameHint').hidden = Boolean(E.file);
  loadList();
  if (E.file) {
    const src = `/media/${encodeURIComponent(E.file.name)}`;
    if (!E.videoEl.src.endsWith(encodeURIComponent(E.file.name))) E.videoEl.src = src;
    drawFrame();
  }
  updateLen();
}

// ── 구간 ─────────────────────────────────────────────────────────────────────────────────────────

function setSeg(which, sec) {
  if (sec == null || !Number.isFinite(sec)) return;
  const v = Math.max(0, Math.round(sec * 10) / 10);
  if (which === 'start') {
    E.start = v;
    if (E.end == null || E.end <= E.start) E.end = Math.min(E.start + 25, E.videoEl.duration || E.start + 25);
  } else E.end = v;
  el('startAt').value = E.start == null ? '' : mmss(E.start);
  el('endAt').value = E.end == null ? '' : mmss(E.end);
  updateLen();
}

function updateLen() {
  const box = el('segLen');
  if (!box) return;
  const d = dur();
  box.classList.toggle('over', d != null && d > E.maxSec);
  box.textContent = d == null
    ? '재생하다가 「여기부터」·「여기까지」를 누르면 구간이 정해집니다.'
    : `구간 ${mmss(E.start)} ~ ${mmss(E.end)} · ${Math.round(d * 10) / 10}초${d > E.maxSec ? ` — 최대 ${E.maxSec}초를 넘었습니다` : ''}`;
}

function playSegment() {
  if (E.start == null) { notice('먼저 구간 시작을 정하세요.', true); return; }
  E.videoEl.currentTime = E.start;
  E.videoEl.play();
  const stop = () => {
    if (E.end != null && E.videoEl.currentTime >= E.end) { E.videoEl.pause(); E.videoEl.removeEventListener('timeupdate', stop); }
  };
  E.videoEl.addEventListener('timeupdate', stop);
}

// ── 서버로 ───────────────────────────────────────────────────────────────────────────────────────

const body = () => ({
  id: E.edit?.id ?? null,
  file_ref: E.file?.file_ref ?? '', file_name: E.file?.name ?? '',
  start_sec: E.start, end_sec: E.end,
  shape: E.shape, zoom: E.zoom, crop_x: E.cropX, crop_y: E.cropY,
  credit_on: E.creditOn ? 1 : 0,
  ...E.text,
  hashtags: E.hashtags ?? '',
  caption: E.caption ?? '',
});

/** The real renderer's own frame — the arbiter when the browser's guess at wrapping is in doubt. */
async function realShot() {
  const btn = el('realShot');
  const was = btn.textContent;
  btn.disabled = true; btn.textContent = '그리는 중…';
  try {
    const r = await fetch('/api/edit/preview', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body()),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error_ko ?? j.error ?? '미리보기를 만들지 못했습니다.');
    }
    const img = el('shotImg');
    if (img.dataset.url) URL.revokeObjectURL(img.dataset.url);
    const url = URL.createObjectURL(await r.blob());
    img.dataset.url = url; img.src = url;
    el('shotBox').hidden = false;
    el('shotNote').textContent = '서버가 실제로 그린 한 장입니다. 영상도 이대로 나옵니다.';
  } catch (e) {
    notice(e.message, true);
  } finally { btn.disabled = false; btn.textContent = was; }
}

async function make() {
  const btn = el('make');
  const was = btn.textContent;
  btn.disabled = true; btn.textContent = '만드는 중…';
  el('state').classList.remove('err');
  el('state').textContent = '수십 초 걸립니다. 이 창을 그대로 두세요.';
  try {
    const r = await api('/api/edit/render', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body()) });
    E.edit = r.edit;
    el('result').hidden = false;
    el('result').innerHTML = `<h3>만든 영상</h3><video src="${esc(r.video_url)}" controls playsinline></video>
      <p class="small muted">${esc(r.edit.file_name ?? '')} · ${mmss(r.edit.start_sec)}~${mmss(r.edit.end_sec)} · 1080×1920</p>`;
    el('state').textContent = '만들었습니다. 확인하고 「내보내기」를 누르세요.';
    el('export').disabled = false;
    notice('영상을 만들었습니다.');
    loadList();
  } catch (e) {
    el('state').textContent = e.error_ko ?? e.message;
    el('state').classList.add('err');
    notice(e.error_ko ?? e.message, true);
  } finally { btn.disabled = false; btn.textContent = was; }
}

async function exportOne() {
  if (!E.edit) return;
  try {
    const r = await api('/api/edit/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: E.edit.id }) });
    el('state').classList.remove('err');
    el('state').textContent = `${r.dir}\n${r.files.map((f) => `  ${f.name}  ${size(f.bytes)}`).join('\n')}`;
    E.exported = r.dir;
    if (!E.caption) E.caption = captionDraft();
    el('panel').innerHTML = panelHtml();
    loadList();
    notice('내보냈습니다. 아래 「올릴 준비」에서 글을 복사하고 폴더를 여세요.');
  } catch (e) {
    el('state').textContent = e.error_ko ?? e.message;
    el('state').classList.add('err');
    notice(e.error_ko ?? e.message, true);
  }
}

/**
 * A first draft of the caption, made only of what the operator already typed: the performer line, the
 * one-line note, then the hashtags. Nothing is written for them — the lines are put in an order.
 */
function captionDraft() {
  const t = E.text;
  return [t.performer_text || t.title_text || '', t.why_text || '', '', E.hashtags || '']
    .join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

async function copyCaption() {
  const text = el('caption')?.value ?? '';
  if (!text.trim()) { notice('올릴 글이 비어 있습니다.', true); return; }
  try {
    await navigator.clipboard.writeText(text);
    notice('글을 복사했습니다. 인스타그램 글 칸에서 Ctrl+V 하세요.');
  } catch {
    el('caption').select();
    notice('브라우저가 복사를 막았습니다. 글이 선택되어 있으니 Ctrl+C 를 누르세요.', true);
  }
}

async function openFolder() {
  if (!E.exported) return;
  try {
    await api('/api/edit/open-folder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir: E.exported }) });
    notice('폴더를 열었습니다. 영상을 인스타그램 창으로 끌어다 놓으세요.');
  } catch (e) { notice(e.error_ko ?? e.message, true); }
}

async function loadList() {
  const host = el('history');
  if (!host) return;
  try {
    const r = await api('/api/edit/list');
    E.maxSec = r.maxSec ?? E.maxSec;
    host.innerHTML = r.edits.length
      ? r.edits.map((e) => `<li><button type="button" data-edit="${e.id}">
          <span class="d">${esc(e.created_at.slice(5, 16).replace('T', ' '))}</span>
          <span class="t">${esc(e.file_name ?? e.file_ref)} · ${mmss(e.start_sec)}~${mmss(e.end_sec)}</span>
          ${e.posted_at ? '<span class="badge ok">올림</span>' : ''}</button></li>`).join('')
      : '<li class="muted small">아직 만든 영상이 없습니다.</li>';
  } catch { /* the list is a convenience */ }
}

function openEdit(row) {
  E.file = E.files.find((f) => f.file_ref === row.file_ref) ?? { file_ref: row.file_ref, name: row.file_name, bytes: 0 };
  E.start = row.start_sec; E.end = row.end_sec;
  E.shape = row.shape; E.zoom = row.zoom ?? 1; E.cropX = row.crop_x ?? 0.5; E.cropY = row.crop_y ?? 0.5;
  E.creditOn = Boolean(row.credit_on);
  E.text = Object.fromEntries(Object.values(BINDS).map((k) => [k, row[k] ?? '']));
  E.hashtags = row.hashtags ?? '';
  E.caption = row.caption ?? '';
  E.exported = null;
  E.edit = row;
  render();
  notice(`${row.id}번 작업을 열었습니다. 고쳐서 다시 만들면 같은 작업에 덮어씁니다.`);
}

// ── 이벤트 ───────────────────────────────────────────────────────────────────────────────────────

document.addEventListener('click', async (e) => {
  const t = e.target;
  if (t.closest('#reload')) { await loadFiles(); return; }
  if (t.closest('#uploadBtn')) { el('file').click(); return; }
  if (t.closest('#playPause')) { if (E.videoEl.paused) E.videoEl.play(); else E.videoEl.pause(); return; }
  if (t.closest('#markIn')) { setSeg('start', E.videoEl.currentTime); return; }
  if (t.closest('#markOut')) { setSeg('end', E.videoEl.currentTime); return; }
  if (t.closest('#playSeg')) { playSegment(); return; }
  if (t.closest('#realShot')) { realShot(); return; }
  if (t.closest('#make')) { make(); return; }
  if (t.closest('#export')) { exportOne(); return; }
  if (t.closest('#copyCaption')) { copyCaption(); return; }
  if (t.closest('#openFolder')) { openFolder(); return; }
  if (t.closest('#openInsta')) { window.open('https://www.instagram.com/', '_blank', 'noopener'); return; }
  if (t.closest('#fillCaption')) {
    E.caption = captionDraft();
    el('caption').value = E.caption;
    el('capLen').textContent = `${[...E.caption].length}자 / 2200`;
    notice('쓰신 글자로 초안을 만들었습니다. 고쳐서 쓰세요.');
    return;
  }
  const nudge = t.closest('[data-nudge]');
  if (nudge) {
    const [which, by] = nudge.dataset.nudge.split(':');
    const cur = which === 'start' ? E.start : E.end;
    if (cur != null) setSeg(which, cur + Number(by));
    return;
  }
  const past = t.closest('[data-edit]');
  if (past) {
    const r = await api('/api/edit/list');
    const row = r.edits.find((x) => String(x.id) === past.dataset.edit);
    if (row) openEdit(row);
  }
});

document.addEventListener('change', async (e) => {
  if (e.target.id === 'fileList') {
    E.file = E.files.find((x) => x.file_ref === e.target.value) ?? null;
    E.edit = null; E.start = null; E.end = null;
    render();
    return;
  }
  if (e.target.name === 'shape') {
    E.shape = e.target.value;
    // Each shape has its own set of text slots, so the blocks have to be built again — redrawing
    // only the picture left the blocks showing the slots of the shape chosen before.
    el('panel').innerHTML = panelHtml();
    loadList();
    drawFrame();
    return;
  }
  if (e.target.id === 'ghosts') { E.ghosts = e.target.checked; drawFrame(); return; }
  if (e.target.id === 'guides') { E.guides = e.target.checked; drawFrame(); return; }
  if (e.target.id === 'posted') {
    if (!E.edit) return;
    try {
      const r = await api('/api/edit/posted', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: E.edit.id, posted: e.target.checked }) });
      E.edit = r.edit;
      loadList();
      notice(e.target.checked ? '올린 것으로 표시했습니다.' : '올림 표시를 지웠습니다.');
    } catch (err) { notice(err.error_ko ?? err.message, true); }
    return;
  }
  if (e.target.id === 'creditOn') {
    E.creditOn = e.target.checked;
    const input = document.querySelector('[data-blockfor="credit"]');
    if (input) input.disabled = !E.creditOn;
    drawFrame();
    return;
  }
  if (e.target.id === 'file' && e.target.files[0]) {
    const name = e.target.files[0].name;
    el('state').textContent = '올리는 중…';
    try {
      const r = await fetch(`/api/entry/upload/clip?name=${encodeURIComponent(name)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: e.target.files[0],
      }).then((x) => x.json());
      if (!r.ok) throw new Error(r.error);
      await loadFiles();
      E.file = E.files.find((f) => f.name === name) ?? E.file;
      render();
      el('state').textContent = '';
    } catch (err) { el('state').textContent = `올리지 못했습니다: ${err.message}`; }
  }
});

/** Panel inputs. Frame typing is handled above and never reaches here. */
function onPanelInput(e) {
  // A text block. The caret lives in the input, so the frame can be redrawn on every keystroke.
  if (e.target.dataset?.blockfor) {
    E.text[e.target.dataset.field] = e.target.value;
    drawFrame();
    updateLines();
    return;
  }
  const id = e.target.id;
  if (id === 'zoom' || id === 'cropX' || id === 'cropY') {
    const v = Number(e.target.value);
    if (id === 'zoom') { E.zoom = v; el('zoomOut').textContent = `${v.toFixed(2)}×`; }
    if (id === 'cropX') { E.cropX = v; el('cropXOut').textContent = `${Math.round(v * 100)}%`; }
    if (id === 'cropY') { E.cropY = v; el('cropYOut').textContent = `${Math.round(v * 100)}%`; }
    drawFrame();
    return;
  }
  if (id === 'startAt' || id === 'endAt') {
    const sec = toSeconds(e.target.value);
    if (sec != null) { if (id === 'startAt') E.start = sec; else E.end = sec; updateLen(); }
    return;
  }
  if (id === 'seek' && E.videoEl.duration) { E.videoEl.currentTime = (Number(e.target.value) / 100) * E.videoEl.duration; return; }
  if (id === 'caption') {
    E.caption = e.target.value;
    const n = [...E.caption].length;
    const tag = el('capLen');
    if (tag) { tag.textContent = `${n}자 / 2200`; tag.classList.toggle('over', n > 2200); }
    return;
  }
  if (id === 'hashtags') E.hashtags = e.target.value;
}

document.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName) || e.target.isContentEditable) return;
  if (!E.file) return;
  e.preventDefault();
  if (E.videoEl.paused) E.videoEl.play(); else E.videoEl.pause();
});

window.addEventListener('resize', fitFrame);

async function loadFiles() {
  try { E.files = (await api('/api/edit/files')).files; }
  catch (e) { notice(`영상 목록을 읽지 못했습니다: ${e.message}`, true); E.files = []; }
  render();
  return E.files;
}

document.addEventListener('DOMContentLoaded', async () => {
  if (!el('frame')) return;
  // One <video> for the whole session: compose.js moves it between shapes, so playback never stops.
  E.videoEl = document.createElement('video');
  E.videoEl.playsInline = true;
  E.videoEl.preload = 'metadata';
  E.videoEl.addEventListener('loadedmetadata', () => {
    E.natural = { w: E.videoEl.videoWidth || 16, h: E.videoEl.videoHeight || 9 };
    el('len').textContent = mmss(E.videoEl.duration);
    drawFrame();
  });
  E.videoEl.addEventListener('timeupdate', () => {
    el('at').textContent = mmss(E.videoEl.currentTime);
    const s = el('seek');
    if (s && E.videoEl.duration) s.value = (E.videoEl.currentTime / E.videoEl.duration) * 100;
  });
  E.videoEl.addEventListener('play', () => { el('playPause').textContent = '❚❚ 멈춤'; });
  E.videoEl.addEventListener('pause', () => { el('playPause').textContent = '▶ 재생'; });

  try {
    const r = await api('/api/edit/shapes');
    E.shapes = r.shapes;
    E.brand = r.brand;
  } catch (e) { notice(`모양을 읽지 못했습니다: ${e.message}`, true); }
  await loadFiles();
});
