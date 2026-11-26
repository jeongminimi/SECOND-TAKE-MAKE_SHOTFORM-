'use strict';
/**
 * ① 영상 고르기 · ② 구간과 문구 — the path from a video the operator already has to a finished reel.
 *
 * The file comes first, because that is how the work actually starts: the performance is already in
 * storage/video, and its file name usually says who performed what. Choosing one reads the name and
 * fills the form in. Where the performance came from is then stated explicitly: a YouTube link, the
 * address of the page it was published on, or — when it is not from a video at all — a line the
 * operator writes, which is the credit the picture carries. One of the three is required, because a
 * post that reuses someone's stage says where the stage came from.
 *
 * The five registration steps still exist, under 자료 손보기 on the left, and still do the saving:
 * this screen calls the same endpoints in the order a person actually works.
 *
 * Two things it deliberately does NOT do:
 *  - It never treats a suggestion as a fact. Anything read out of a file name or a video title is
 *    marked 「자동으로 채움」 and the save button stays locked until the operator says they checked it.
 *    A link only overwrites fields that still carry that badge; a field the operator typed is theirs.
 *  - It never fills in a source. name_evidence and version_evidence are typed by a person, because
 *    the program cannot know whether a title proves anything — or whether a channel is official.
 */

const cstate = { lookup: null, fileRef: null, videoFiles: null, result: null, missing: [],
  youtubeSearch: false, found: [], playerTime: null };

const cEl = (id) => document.getElementById(id);
const AUTO = '<span class="autofill">자동으로 채움 — 확인하세요</span>';

/** `1:23` or `83` → seconds; null when it cannot be read. Mirrors parseTimecode() on the server. */
function toSeconds(v) {
  const s = String(v ?? '').trim();
  if (s === '') return null;
  if (/^\d+$/.test(s)) return Number(s);
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})$/.exec(s);
  if (!m || Number(m[2]) > 59 || Number(m[3]) > 59) return null;
  return (Number(m[1] ?? 0) * 3600) + (Number(m[2]) * 60) + Number(m[3]);
}

function field(id, label, { help = '', auto = false, type = 'text', placeholder = '', value = '' } = {}) {
  return `<div class="fld" data-field="${id}">
    <label for="${id}">${esc(label)}${auto ? ` ${AUTO}` : ''}</label>
    <input type="${type}" id="${id}" value="${esc(value)}" placeholder="${esc(placeholder)}">
    ${help ? `<span class="fhelp">${esc(help)}</span>` : ''}</div>`;
}

const TAGS = ['band', 'acoustic', 'orchestra', 'unplugged', 'piano', 'jazz', 'a_cappella', 'rearranged'];

/** ① as it stands before anything is chosen: the folder first, then where it came from. */
function step1Html() {
  return `<div class="fld" data-field="file_ref">
    <label for="cFileList">영상 파일</label>
    <div class="row">
      <select id="cFileList"><option value="">불러오는 중…</option></select>
      <button class="btn ghost" id="cUploadBtn" type="button">파일 올리기</button>
    </div>
    <input type="file" id="cFile" accept="video/*" hidden>
    <div class="upstate" id="cFileState"></div>
    <span class="fhelp">storage/video 폴더에 둔 영상에서 고릅니다. 고르면 파일 이름을 읽어 아래 칸을 채웁니다.</span>
  </div>

  ${field('cPerformer', '공연자 (공식 영문 표기)')}
  ${field('cTitle', '곡명 (공식 영문 표기)')}
  ${field('cOriginal', '원곡 아티스트 (커버일 때)')}
  ${field('cNameEv', '↳ 공식 영문 표기를 어디서 확인했나요', { help: '예: 공식 영상 제목에 그대로 적혀 있음. 비우면 저장은 되지만 선곡되지 않습니다.' })}

  <div class="fld" data-field="type">
    <label for="cType">공연 유형</label>
    <select id="cType">
      <option value="live">라이브</option>
      <option value="cover">커버</option>
    </select>
  </div>
  <div class="fld" data-field="tags">
    <label>편곡 태그</label>
    <div class="tagRow">${TAGS.map((t) => `<label class="check"><input type="checkbox" data-ctag="${t}"> ${esc(ko('tag', t))}</label>`).join('')}</div>
    <span class="fhelp">원곡과 다른 점이 있을 때만 고릅니다. 하나라도 고르면 아래 근거가 필요합니다.</span>
  </div>
  ${field('cVersionEv', '↳ 커버인지·편곡이 다른지를 어디서 확인했나요', { help: '예: 공식 제목에 [COVER] 라고 적혀 있음. 비어 있으면 저장이 막힙니다.' })}

  <div class="fld" data-field="source">
    <label>이 영상의 출처</label>
    <div class="tagRow">
      <label class="check"><input type="radio" name="cSrcKind" value="youtube" checked> 유튜브</label>
      <label class="check"><input type="radio" name="cSrcKind" value="other"> 다른 곳 (공식 SNS·방송사 페이지 등)</label>
      <label class="check"><input type="radio" name="cSrcKind" value="none"> 유튜브 영상이 아님 (직접 촬영 등)</label>
    </div>
    <span class="fhelp">셋 중 무엇을 고르더라도 아래 칸을 채워야 등록됩니다. 프로그램은 출처를 지어내지 않습니다.</span>
  </div>

  <div class="fld" data-field="url" id="srcYoutube">
    <label for="ytUrl">유튜브 주소</label>
    <div class="row">
      <input type="url" id="ytUrl" placeholder="https://www.youtube.com/watch?v=...">
      <button class="btn ghost" id="ytFetch" type="button">가져오기</button>
    </div>
    <span class="fhelp">주소를 붙여넣으면 바로 조회합니다 — 공식 제목과 채널 이름이 그때 들어옵니다. 손으로 고친 칸은 그대로 둡니다.
      영상을 내려받지는 않습니다.</span>
    <div class="row" style="margin-top:8px">
      <button class="btn ghost" id="ytPaste" type="button">복사한 주소 붙여넣기</button>
      <button class="btn ghost" id="ytSearch" type="button">제목으로 찾기</button>
    </div>
    <div id="ytFound" hidden></div>
    <div id="ytResult" hidden></div>
  </div>

  <div class="fld" data-field="srcUrl" id="srcOther" hidden>
    <label for="cSrcUrl">출처 주소</label>
    <input type="url" id="cSrcUrl" placeholder="https://...">
    <span class="fhelp">그 무대가 공개된 페이지 주소를 그대로 붙여넣으세요. 캡션의 공식 영상 주소로 들어갑니다.</span>
  </div>

  <div class="fld" data-field="srcNote" id="srcNone" hidden>
    <label for="cSrcNote">이 영상을 어디서 얻었나요</label>
    <input type="text" id="cSrcNote" placeholder="예: 내가 직접 촬영 · 2026-10-12 서울 공연">
    <span class="fhelp"><b>여기 쓴 글이 영상에 Source: ___ 으로 그대로 나갑니다.</b> 보는 사람이 읽을 문장으로 적으세요.</span>
  </div>

  <label class="check big" data-field="official"><input type="checkbox" id="cOfficial">
    이 영상의 <b>출처가 공식 채널</b>이 맞습니다 — 프로그램은 확인할 수 없습니다</label>

  ${field('cChannel', '채널 이름 (영상에 「Source:」로 들어갑니다)', { help: '주소를 가져오면 자동으로 채워집니다. 직접 적어도 됩니다.' })}
  ${field('cPublished', '공식 공개일', { type: 'date', help: '유튜브에서 가져올 수 없는 값입니다. 영상 아래에 적힌 공개일을 직접 넣으세요. 파일을 받은 날짜가 아닙니다. 이 날짜가 어느 운영일에 뽑힐 수 있는지를 정합니다.' })}`;
}

const mmss = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
const comma = (n) => (n == null ? null : Number(n).toLocaleString('ko-KR'));

/**
 * The official video, played in the page.
 *
 * This is YouTube's own embed: it plays the video from YouTube and nothing is downloaded, stored or
 * cut here. It is here so the operator can watch the stage and mark where the good part starts
 * instead of having to know the timecode before they begin. What gets cut is still their own file.
 */
function playerHtml(r) {
  const d = r.details;
  const rows = [
    ['제목', r.title],
    ['채널', r.channel_name],
    ['길이', d?.duration_sec != null ? mmss(d.duration_sec) : null],
    ['조회수', comma(d?.view_count)],
    ['공개일', d?.published_at ? d.published_at.slice(0, 10) : null],
  ].filter(([, v]) => v);
  return `<div class="ytPlayerBox">
    <div class="ytFrame"><iframe id="ytPlayer" src="https://www.youtube.com/embed/${esc(r.video_id)}?enablejsapi=1&rel=0"
      title="원본 영상" frameborder="0" allow="accelerometer; clipboard-write; encrypted-media; picture-in-picture" allowfullscreen></iframe></div>
    <div class="ytInfo">
      <table class="ytMeta">${rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(String(v))}</td></tr>`).join('')}</table>
      ${d ? '' : '<p class="small muted">길이·조회수·공개일은 API 키를 넣으면 함께 들어옵니다.</p>'}
      <p class="small muted">재생하면서 쓸 구간을 정하세요. 버튼을 누르면 ② 구간 칸에 그 시각이 들어갑니다.</p>
      <div class="row">
        <button class="btn ghost" id="segFrom" type="button">여기부터</button>
        <button class="btn ghost" id="segTo" type="button">여기까지</button>
      </div>
      <p class="small muted">영상은 유튜브에서 재생됩니다 — 이 프로그램은 내려받거나 저장하지 않습니다.
        자르기는 <b>운영자가 넣은 파일</b>에 합니다.</p>
    </div>
  </div>`;
}

/** What a link added: the official title, the channel, and whether the file for it is in the folder. */
function lookupHtml(r) {
  const found = r.local_file
    ? `<p class="small">폴더에서 같은 영상을 찾았습니다 (${r.local_match_by === 'id' ? '영상 번호' : '제목'} 기준): <b>${esc(r.local_file.name)}</b></p>`
    : `<p class="warnbox">${esc(r.local_note ?? '')}<br><button class="btn ghost" id="ytRecheck" type="button">폴더 다시 확인</button></p>`;
  return `${r.video_id ? playerHtml(r) : `<div class="picked">
    ${r.thumbnail_url ? `<img class="thumb" src="${esc(r.thumbnail_url)}" alt="" onerror="this.remove()">` : ''}
    <div>
      <p class="pickedTitle">${esc(r.title ?? '(제목을 가져오지 못했습니다)')}</p>
      <p class="small muted">${esc(r.channel_name ?? '채널 미상')} · <a href="${esc(r.normalized_url)}" target="_blank" rel="noopener noreferrer">영상 보기 ↗</a></p>
    </div>
  </div>`}
  ${r.lookup_ok ? '' : `<p class="warnbox">${esc(r.note)}</p>`}
  ${found}`;
}

function step2Html() {
  return `<h2><span class="n">2</span> 구간과 문구</h2>
    <div class="row2">
      ${field('cStart', '쓸 구간 시작', { placeholder: '1:23', help: '1:23 처럼 분:초로, 또는 초 단위 숫자로.' })}
      ${field('cEnd', '↳ 끝', { placeholder: '1:48', help: '시작만 넣으면 자동으로 채워집니다. 최대 30초.' })}
    </div>
    ${field('cSegEv', '그 시각을 어떻게 알았나요', { placeholder: '유튜브 "가장 많이 본 구간" 그래프 기준', help: '적으면 캡션에 ▶ 시각이 들어갑니다. 비우면 전체 영상으로만 링크됩니다.' })}
    ${field('cWhy', '왜 봐야 하는지 (영어 한 줄)', { help: '직접 보고 느낀 점을 쓰세요. 출처가 없어도 됩니다. 이 문장이 캡션에 그대로 나갑니다.' })}
    ${field('cTags', '해시태그 직접 추가', { placeholder: '#kpop #seventeen', help: '공연자·곡명으로 만든 태그 뒤에 그대로 붙습니다. 띄어쓰기나 쉼표로 구분하세요. K팝 영상이면 여기에 #kpop 을 넣으세요.' })}

    <label class="check big" data-field="personal"><input type="checkbox" id="cPersonal" checked>
      <b>권리 미확인</b> — 권리 3종을 입력하지 않습니다. 영상은 만들어지고 <b>자막에는 출처 채널이 들어갑니다.</b>
      다만 <b>프로그램을 통한 실제 발행은 영구히 막힙니다.</b></label>
    <p class="small muted">권리를 확보한 클립이라면 이 체크를 끄고, 왼쪽 <b>자료 손보기 → 5단계</b>에서 영상·음악·실연 권리를 입력하세요.</p>

    <label class="check big" data-field="checked"><input type="checkbox" id="cChecked">
      위 내용을 <b>직접 확인했습니다</b> (자동으로 채워진 값 포함)</label>

    <div class="actions"><button class="btn" id="cSubmit" type="button" disabled>등록하고 영상 만들기</button></div>
    <div class="upstate" id="cSubmitState"></div>`;
}

/**
 * The save button unlocks only when both confirmations are ticked and the essentials are present.
 *
 * It has to refuse exactly what the server refuses, or the button promises a save that cannot happen:
 * an arrangement tag claims this version differs from the original, and that claim needs the source it
 * was read from, which POST /api/entry/candidate rejects without (`version_evidence_required`).
 *
 * `name_evidence` is the other way round — it never stops a save, it only keeps the candidate out of
 * automatic selection. So it warns here and does not lock. The rule is the server's; this only mirrors
 * it, and neither of them is relaxed to make the button easier to press.
 */
function refreshSubmit() {
  const btn = cEl('cSubmit');
  if (!btn) return;
  const taggedWithoutSource = tagsChecked().length > 0 && !cEl('cVersionEv')?.value.trim();
  const srcField = { youtube: 'ytUrl', other: 'cSrcUrl', none: 'cSrcNote' }[srcKind()];
  const missing = [
    [cEl('cOfficial')?.checked, '공식 채널 확인', 'cOfficial'],
    [cEl('cChecked')?.checked, '확인했습니다', 'cChecked'],
    [cEl('cPerformer')?.value.trim(), '공연자', 'cPerformer'],
    [cEl('cTitle')?.value.trim(), '곡명', 'cTitle'],
    [cEl('cPublished')?.value, '공개일', 'cPublished'],
    [cstate.fileRef, '영상 파일', 'cFileList'],
    [cEl('cStart')?.value.trim(), '구간 시작', 'cStart'],
    [!taggedWithoutSource, '편곡 태그 근거', 'cVersionEv'],
    [!sourceNeed(), sourceNeed(), srcField],
  ].filter(([ok]) => !ok);

  // Which fields they are, in the order they appear on screen — that is the order a person would
  // fill them in, and the order pressing the button walks through.
  const inScreenOrder = (a, b) => {
    const [x, y] = [cEl(a), cEl(b)];
    if (!x || !y) return 0;
    return x.compareDocumentPosition(y) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  };
  cstate.missing = missing.map(([, , id]) => id).filter(Boolean).sort(inScreenOrder);
  markMissing(cstate.missing);
  const need = missing.map(([, label]) => label);

  // Locked, but not `disabled`: a disabled button swallows the click, and pressing it is how the
  // operator asks "what is left?" — so it stays clickable and the press jumps to the empty field.
  btn.disabled = false;
  btn.classList.toggle('locked', need.length > 0);
  btn.setAttribute('aria-disabled', String(need.length > 0));

  // What a finished attempt said stays until the operator changes something; otherwise the line under
  // the button would snap back to a checklist the moment a save failed, which reads as "nothing
  // happened" — the very thing that made a refusal invisible.
  const st = cEl('cSubmitState');
  st.classList.toggle('err', Boolean(cstate.result?.err));
  if (cstate.result) { st.textContent = cstate.result.text; return; }
  st.textContent = [
    need.length ? `아직 비어 있습니다: ${need.join(' · ')}` : '',
    cEl('cNameEv') && !cEl('cNameEv').value.trim() ? '공식 표기 근거가 없어 자동 선곡에서는 빠집니다 — 등록은 됩니다.' : '',
  ].filter(Boolean).join('\n');
}

/** Fills a field and marks it as something the program guessed, unless the operator already typed. */
function autofill(id, value) {
  const el = cEl(id);
  if (!el || value == null || value === '') return;
  const fld = el.closest('.fld');
  const touched = el.value.trim() && !fld?.querySelector('.autofill');
  if (touched) return;
  el.value = value;
  if (fld && !fld.querySelector('.autofill')) fld.querySelector('label')?.insertAdjacentHTML('beforeend', ` ${AUTO}`);
}

/** Everything a title — of a file or of a video — suggested, applied to the form. */
function applySuggestion(s = {}) {
  autofill('cPerformer', s.performer_en);
  autofill('cTitle', s.title_en);
  autofill('cOriginal', s.original_artist_en);
  if (s.performance_type) cEl('cType').value = s.performance_type;
  for (const box of document.querySelectorAll('[data-ctag]')) {
    if ((s.arrangement_tags ?? []).includes(box.dataset.ctag)) box.checked = true;
  }
  refreshSubmit();
}

/** ② appears once a file is chosen: that is the point from which there is something to cut. */
function openStep2() {
  const s2 = cEl('stepClip');
  if (!s2 || !s2.hidden) return;
  s2.hidden = false;
  s2.classList.remove('dim');
  s2.innerHTML = step2Html();
}

function pickFile(fileRef, { name = null, suggested = null, readSource = true } = {}) {
  cstate.fileRef = fileRef || null;
  cEl('cFileState').textContent = cstate.fileRef ? `고른 영상: ${name ?? cstate.fileRef}` : '';
  if (!cstate.fileRef) { refreshSubmit(); return; }
  openStep2();
  if (suggested && Object.keys(suggested).length) applySuggestion(suggested);
  refreshSubmit();
  if (readSource) readFileSource(cstate.fileRef);
}

/**
 * Whether the file itself already says where it came from. Most download tools can keep the link in
 * the file name, in a text file beside it, or in the video's own metadata — and then there is nothing
 * to search for. It is still only a suggestion: the id goes through the same oEmbed lookup a pasted
 * link does, and the operator still ticks 「출처가 공식 채널이 맞습니다」.
 */
async function readFileSource(fileRef) {
  const state = cEl('cFileState');
  try {
    const r = await api(`/api/entry/file-source?file_ref=${encodeURIComponent(fileRef)}`);
    if (!r.source || cstate.fileRef !== fileRef) return;
    cEl('ytUrl').value = r.source.url;
    state.textContent = `${state.textContent} · ${r.where_ko} — 주소를 확인하는 중…`;
    await fetchUrl();
    state.textContent = `${state.textContent.split(' · ')[0]} · ${r.where_ko}`;
  } catch { /* nothing was found, or the lookup failed: the operator finds the link the usual way */ }
}

async function loadVideoFiles() {
  const sel = cEl('cFileList');
  if (!sel) return;
  try {
    const r = await api('/api/entry/video-files');
    cstate.videoFiles = r.files;
    cstate.youtubeSearch = Boolean(r.youtube_search);
    sel.innerHTML = r.files.length
      ? `<option value="">폴더에 있는 영상에서 고르기…</option>${r.files.map((f) => `<option value="${esc(f.file_ref)}">${esc(f.name)} · ${size(f.bytes)}</option>`).join('')}`
      : '<option value="">폴더가 비어 있습니다 — 파일을 올리세요</option>';
  } catch {
    sel.innerHTML = '<option value="">목록을 불러오지 못했습니다 — 파일을 올리세요</option>';
  }
  return cstate.videoFiles;
}

const fileByRef = (ref) => (cstate.videoFiles ?? []).find((f) => f.file_ref === ref) ?? null;

/**
 * The link path. The official title is a better reading than a mangled file name, so it overwrites
 * what the file name suggested — but only fields still marked as guesses. If the operator has not
 * chosen a file yet, the one the server matched in their folder is selected for them.
 */
async function fetchUrl() {
  const btn = cEl('ytFetch');
  const url = cEl('ytUrl').value.trim();
  if (!url) { notice('유튜브 주소를 붙여넣으세요.', true); return; }
  const was = btn.textContent;
  btn.disabled = true; btn.textContent = '가져오는 중…';
  try {
    const r = await api('/api/entry/from-url', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
    cstate.lookup = r;
    cEl('ytResult').hidden = false;
    cEl('ytResult').innerHTML = lookupHtml(r);
    watchPlayer();
    autofill('cChannel', r.channel_name);
    // The published date decides which operating day this can be selected for. oEmbed has no such
    // field, so it used to be typed by hand; videos.list carries it, as a suggestion like the rest.
    if (r.details?.published_at) autofill('cPublished', r.details.published_at.slice(0, 10));
    if (r.local_file) {
      await loadVideoFiles();
      cEl('cFileList').value = r.local_file.file_ref;
      pickFile(r.local_file.file_ref, { name: r.local_file.name });
    }
    if (r.lookup_ok) applySuggestion(r.suggested ?? {});
    refreshSubmit();
    notice(r.lookup_ok ? '제목과 채널을 가져왔습니다. 자동으로 채운 값은 확인하고 고치세요.' : r.note, !r.lookup_ok);
  } catch (e) {
    notice(`가져오지 못했습니다: ${e.message}`, true);
  } finally {
    btn.disabled = false; btn.textContent = was;
  }
}

/** What to search YouTube for: what the operator typed, else the file name as it was read. */
function searchQuery() {
  const parts = [val('cPerformer'), val('cTitle')].filter(Boolean);
  if (parts.length) return parts.join(' ');
  return fileByRef(cstate.fileRef)?.name?.replace(/\.[^.]+$/, '') ?? '';
}

/**
 * Finding the link for a file, without leaving the page when that is possible.
 *
 * With an API key the official Data API returns a few candidates and the operator picks one. Without a
 * key the same search opens in a YouTube tab — fewer steps than typing the title there by hand, and it
 * needs no key, no quota and no account. Either way the program never decides which video it is.
 */
async function searchForFile() {
  const q = searchQuery();
  if (!q) { notice('먼저 영상 파일을 고르거나 공연자·곡명을 적어 주세요.', true); return; }
  const host = cEl('ytFound');
  if (!cstate.youtubeSearch) {
    window.open(`https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`, '_blank', 'noopener');
    host.hidden = false;
    host.innerHTML = `<p class="small muted">유튜브에서 「${esc(q)}」를 검색한 탭을 열었습니다. 맞는 영상의 주소를 복사해 위 칸에 붙여넣으세요.</p>`;
    return;
  }
  host.hidden = false;
  host.innerHTML = '<p class="small muted">유튜브에서 찾는 중…</p>';
  try {
    const r = await api(`/api/entry/youtube-search?q=${encodeURIComponent(q)}`);
    cstate.found = r.items;
    host.innerHTML = r.items.length ? `
      <p class="small muted">이 중에 있나요? 누르면 그 영상의 주소가 들어갑니다. <b>프로그램은 고르지 않습니다.</b></p>
      ${r.items.map((it, i) => `<button class="btn ghost found" type="button" data-found="${i}">
        <img class="ythumb" src="${esc(it.thumbnail_url ?? '')}" alt="" onerror="this.remove()">
        <span><b>${esc(it.title ?? '(제목 없음)')}</b><br>${esc(it.channel_name ?? '')} · ${esc((it.published_at ?? '').slice(0, 10))}</span>
      </button>`).join('')}
      <p class="small muted">아닌 것 같으면 공연자·곡명을 고치고 다시 누르세요.</p>`
      : `<p class="warnbox">「${esc(q)}」로는 찾지 못했습니다. 공연자·곡명을 고쳐서 다시 누르거나, 주소를 직접 붙여넣으세요.</p>`;
  } catch (e) {
    host.innerHTML = `<p class="warnbox">${esc(e.issues?.[0]?.ko ?? e.error_ko ?? e.message)}</p>`;
    notice(e.message, true);
  }
}

/**
 * Where the embedded player currently is.
 *
 * YouTube's embed reports playback state to the page that asked for it, so there is no need to load
 * their API script: the iframe is told to start reporting (`listening`), and each report carries the
 * current time. Only messages from YouTube's own origin are read.
 */
window.addEventListener('message', (e) => {
  if (!/^https:\/\/(www\.)?youtube(-nocookie)?\.com$/.test(e.origin)) return;
  let d = null;
  try { d = JSON.parse(e.data); } catch { return; }
  const t = d?.info?.currentTime;
  if (typeof t === 'number' && Number.isFinite(t)) cstate.playerTime = t;
});

/** Asks the freshly-mounted player to report its position. */
function watchPlayer() {
  const f = cEl('ytPlayer');
  if (!f) return;
  cstate.playerTime = null;
  const hello = () => f.contentWindow?.postMessage(
    JSON.stringify({ event: 'listening', id: 'ytPlayer', channel: 'widget' }), 'https://www.youtube.com');
  f.addEventListener('load', hello);
  hello();
}

/** 「여기부터」/「여기까지」: the player's position becomes the segment field, in 1:23 form. */
function setSegFromPlayer(id) {
  if (!cEl(id)) { notice('먼저 영상 파일을 고르세요. ② 구간 칸이 생기면 시각을 넣을 수 있습니다.', true); return; }
  const t = cstate.playerTime;
  if (t == null) { notice('영상을 조금 재생한 다음 눌러 주세요 — 멈춰 있으면 시각을 읽을 수 없습니다.', true); return; }
  cEl(id).value = mmss(t);
  if (id === 'cStart' && cEl('cEnd') && !cEl('cEnd').value.trim()) cEl('cEnd').value = mmss(Math.floor(t) + 25);
  cstate.result = null;
  refreshSubmit();
  notice(`${id === 'cStart' ? '시작' : '끝'}을 ${mmss(t)} 로 넣었습니다. 유튜브에서 본 시각이므로 「그 시각을 어떻게 알았나요」에 근거를 적을 수 있습니다.`);
}

/** Reads the address straight off the clipboard, so it never has to be put in the field by hand. */
async function pasteUrl() {
  try {
    const text = await navigator.clipboard.readText();
    if (!text?.trim()) { notice('클립보드가 비어 있습니다. 유튜브에서 주소를 복사하고 다시 누르세요.', true); return; }
    cEl('ytUrl').value = text.trim();
    await fetchUrl();
  } catch {
    // Clipboard permission is the browser's to give; typing into the field still works.
    notice('브라우저가 클립보드 읽기를 막았습니다. 위 칸에 직접 붙여넣으면 바로 조회합니다.', true);
    cEl('ytUrl').focus();
  }
}

/** The operator chose one of the candidates: its address goes in and is looked up like any other. */
async function useFound(i) {
  const hit = (cstate.found ?? [])[i];
  if (!hit) return;
  cEl('ytUrl').value = hit.url;
  cEl('ytFound').hidden = true;
  await fetchUrl();
}

const tagsChecked = () => [...document.querySelectorAll('[data-ctag]')].filter((b) => b.checked).map((b) => b.dataset.ctag);
const val = (id) => cEl(id)?.value.trim() || null;

/** Outlines every field that is still empty, so the one being jumped to is not the only clue. */
function markMissing(ids) {
  for (const el of document.querySelectorAll('.fld.missing, .check.missing')) el.classList.remove('missing');
  for (const id of ids) cEl(id)?.closest('.fld, .check')?.classList.add('missing');
}

/**
 * Pressing a locked button moves to the first thing that is still empty and puts the cursor in it.
 * Saying what is missing in a line of text is not much help on a form this long — the field itself is
 * usually off screen, which is the same problem the invisible error had.
 */
function jumpToMissing() {
  const el = cEl(cstate.missing?.[0]);
  if (!el) return;
  const fld = el.closest('.fld, .check') ?? el;
  fld.scrollIntoView({ behavior: 'smooth', block: 'center' });
  // A checkbox takes focus but shows nothing, so the surrounding row is flagged either way.
  el.focus({ preventScroll: true });
  if (typeof el.select === 'function' && el.type !== 'checkbox' && el.type !== 'date') el.select();
}

/** Which of the three kinds of source the operator said this performance came from. */
const srcKind = () => document.querySelector('[name="cSrcKind"]:checked')?.value ?? 'youtube';
const isUrl = (s) => /^https?:\/\/\S+$/i.test(String(s ?? '').trim());
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return null; } };

/**
 * What is still missing for the chosen kind of source. A performance taken from YouTube has to carry
 * the link it came from — that is the operator's own rule for the account, and the program cannot
 * check it, so the screen refuses to save without it rather than filling in a placeholder.
 */
function sourceNeed() {
  const kind = srcKind();
  if (kind === 'youtube') return cstate.lookup?.normalized_url ? null : '유튜브 주소 가져오기';
  if (kind === 'other') return isUrl(cEl('cSrcUrl')?.value) ? null : '출처 주소';
  return val('cSrcNote') ? null : '출처 (어디서 얻었는지)';
}

/**
 * Saves through the same five endpoints the registration screen uses, in the order they depend on
 * each other, then runs the day so there is something to look at. Stops at the first refusal and says
 * which step it was, because a half-made chain is confusing to undo by hand.
 *
 * With no link there is no platform id and no official URL: the video is registered as `local`, which
 * says exactly that rather than inventing either.
 */
async function submitAll() {
  const btn = cEl('cSubmit');
  const was = btn.textContent;
  btn.disabled = true; btn.textContent = '등록하는 중…';
  cstate.result = null;
  const say = (t) => { cEl('cSubmitState').classList.remove('err'); cEl('cSubmitState').textContent = t; };
  const post = async (path, body, what) => {
    try {
      return await api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    } catch (e) {
      const err = new Error(`${what}: ${e.message}`);
      err.issues = e.issues ?? null; // the Korean reasons ride along to the catch below
      throw err;
    }
  };
  // Tracks whether anything has been written yet, so a refusal can say what is already in the
  // database. The six endpoints are six separate saves with no transaction between them.
  let saved = false;
  try {
    const L = cstate.lookup;

    // The candidate step (4/6) is the one with the evidence rules, and it is the fourth save — a
    // refusal there used to leave a channel, a video and a track behind with no candidate attached.
    // So it is asked first, through the route that validates and writes nothing.
    say('입력을 확인하는 중 — 아직 아무것도 저장하지 않습니다');
    const pre = await post('/api/entry/check/candidate', {
      performer_en: val('cPerformer'), performance_type: cEl('cType').value,
      arrangement_tags: tagsChecked(), version_evidence: val('cVersionEv'),
      why_watch_en: val('cWhy'), extra_hashtags: val('cTags'),
    }, '입력 확인');
    // candidate_key is made by the save itself from the performer and the song, so it is not missing
    // here in any sense the operator could act on.
    const stops = (pre.issues ?? []).filter((i) => i.level === 'block' && i.field !== 'candidate_key');
    if (stops.length) { const e = new Error('입력을 확인하세요'); e.issues = stops; throw e; }
    const kind = srcKind();
    const linked = kind === 'youtube' && Boolean(L?.normalized_url);
    // Whatever the operator said the source is, verbatim. A performance taken from YouTube is saved
    // with its link; one from somewhere else with that page's address; one that is not from a video at
    // all with the line they typed, which is what the picture then credits.
    const url = linked ? L.normalized_url : (kind === 'other' ? val('cSrcUrl') : '');
    const chName = val('cChannel')
      ?? (kind === 'none' ? val('cSrcNote') : (linked ? L.channel_name : null))
      ?? hostOf(url);
    // Nothing stands in for a source: '출처 미상' used to be written here, which put a credit on the
    // video that no one had checked.
    if (!chName) throw new Error('출처를 적어야 합니다 — 유튜브 주소, 출처 주소, 또는 어디서 얻었는지 한 줄.');
    const handle = linked ? ((L.channel_url ?? '').split('/').pop() || chName) : `local-${chName}`;

    say('1/6 채널');
    const ch = await post('/api/entry/channel', {
      platform: linked ? 'youtube' : 'local', external_id: handle, name: chName,
      url: linked ? (L.channel_url ?? null) : (kind === 'other' ? url : null),
    }, '채널');
    saved = true;

    say('2/6 원본 영상');
    const vid = await post('/api/entry/video', {
      channel_id: ch.row.id,
      platform: linked ? 'youtube' : 'local',
      platform_video_id: linked ? L.video_id : null,
      official_url: url,
      title: (linked ? L?.title : null) ?? `${val('cPerformer')} – ${val('cTitle')}`,
      published_at: `${cEl('cPublished').value}T00:00:00Z`,
    }, '원본 영상');

    say('3/6 곡');
    const tr = await post('/api/entry/track', {
      title_en: val('cTitle'), original_artist_en: val('cOriginal') ?? val('cPerformer'), name_evidence: val('cNameEv'),
    }, '곡');

    say('4/6 공연 후보');
    const cand = await post('/api/entry/candidate', {
      source_video_id: vid.row.id, track_id: tr.row.id,
      performer_en: val('cPerformer'), performance_type: cEl('cType').value,
      arrangement_tags: tagsChecked(), version_evidence: val('cVersionEv'),
      why_watch_en: val('cWhy'), extra_hashtags: val('cTags'),
    }, '공연 후보');

    say('5/6 클립');
    await post('/api/entry/clip-asset', {
      candidate_id: cand.row.id, file_ref: cstate.fileRef,
      source_start_sec: val('cStart'), source_end_sec: val('cEnd'),
      personal_use_only: cEl('cPersonal').checked ? 1 : 0,
    }, '클립');

    if (val('cSegEv')) {
      await post('/api/entry/segment', {
        candidate_id: cand.row.id, start_sec: val('cStart'), end_sec: val('cEnd'), evidence: val('cSegEv'),
      }, '추천 구간');
    }

    say('6/6 영상 만드는 중 — 수십 초 걸립니다');
    const date = cEl('runDate').value || state.overview?.today;
    const r = await post('/api/run', { date, reselect: true }, '영상 만들기');
    cstate.result = url ? null
      : { text: `출처를 「${chName}」(으)로 기록했습니다. 공식 영상 주소가 없어 캡션에 링크는 들어가지 않습니다.`, err: false };
    notice(r.status === 'selected'
      ? `등록하고 ${date} 영상까지 만들었습니다. 아래에서 모양을 맞추고 내보내세요.`
      : `등록했습니다. 다만 ${date}에는 이 후보가 뽑히지 않았습니다 — 아래 설명을 보세요.`);
    await loadOverview();
    await showDay(date);
  } catch (e) {
    // The refusal has to be where the operator is looking. They pressed a button at the bottom of a
    // long form and #notice is at the top of the page, so clearing the line beside the button looked
    // like the press did nothing at all. The server's reason is Korean and names the field; the
    // English message is only the fallback for an error that carries no issues.
    const reasons = (e.issues ?? []).filter((i) => i.level === 'block').map((i) => i.ko).filter(Boolean);
    const msg = `등록하지 못했습니다 — ${reasons.length ? reasons.join('\n') : e.message}`;
    cstate.result = {
      text: saved
        ? `${msg}\n채널·영상·곡은 이미 저장됐습니다. 고쳐서 다시 누르면 같은 줄을 덮어씁니다.`
        : msg,
      err: true,
    };
    notice(msg, true);
  } finally {
    btn.textContent = was;
    refreshSubmit();
  }
}

/** Looks in the folder again for the video the link named, after the operator has put the file there. */
async function recheckFolder() {
  const files = await loadVideoFiles();
  const L = cstate.lookup;
  if (!L || !files) return;
  const key = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9가-힣]+/g, '');
  const want = key(L.title);
  const hit = files.find((f) => f.name.includes(L.video_id))
    ?? (want.length >= 4 ? files.find((f) => key(f.name).includes(want) || want.includes(key(f.name))) : null);
  if (hit) {
    cEl('cFileList').value = hit.file_ref;
    pickFile(hit.file_ref, { name: hit.name, suggested: hit.suggested });
    cEl('ytResult').innerHTML = lookupHtml({ ...L, local_file: hit, local_match_by: 'title' });
    notice(`폴더에서 찾았습니다: ${hit.name}`);
  } else {
    notice('아직 폴더에 없습니다. 파일을 넣고 다시 눌러 주세요.', true);
  }
}

document.addEventListener('click', (e) => {
  if (e.target.closest('#ytFetch')) { fetchUrl(); return; }
  if (e.target.closest('#ytSearch')) { searchForFile(); return; }
  if (e.target.closest('#ytPaste')) { pasteUrl(); return; }
  if (e.target.closest('#segFrom')) { setSegFromPlayer('cStart'); return; }
  if (e.target.closest('#segTo')) { setSegFromPlayer('cEnd'); return; }
  const found = e.target.closest('[data-found]');
  if (found) { useFound(Number(found.dataset.found)); return; }
  if (e.target.closest('#ytRecheck')) { recheckFolder(); return; }
  if (e.target.closest('#cUploadBtn')) { cEl('cFile').click(); return; }
  if (e.target.closest('#cSubmit')) {
    if (cstate.missing?.length) { jumpToMissing(); return; }
    submitAll();
    return;
  }
});

document.addEventListener('change', async (e) => {
  if (e.target.id === 'cFileList') {
    const f = fileByRef(e.target.value);
    pickFile(e.target.value, { name: f?.name, suggested: f?.suggested });
    return;
  }
  if (e.target.id === 'cFile' && e.target.files[0]) {
    const st = cEl('cFileState');
    st.textContent = '올리는 중…';
    try {
      const r = await fetch(`/api/entry/upload/clip?name=${encodeURIComponent(e.target.files[0].name)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: e.target.files[0],
      }).then((x) => x.json());
      if (!r.ok) throw new Error(r.error);
      cEl('cFileList').value = '';
      pickFile(r.file_ref, { name: e.target.files[0].name, suggested: r.suggested });
    } catch (err) { st.textContent = `올리지 못했습니다: ${err.message}`; }
    return;
  }
  // An arrangement tag is what makes the version-difference source necessary, so ticking one has to
  // re-check the button the same way filling a field does.
  if (e.target.matches?.('[data-ctag]')) { cstate.result = null; refreshSubmit(); return; }
  // Each kind of source asks for a different thing, so only that one's field is on screen.
  if (e.target.name === 'cSrcKind') {
    const kind = srcKind();
    cEl('srcYoutube').hidden = kind !== 'youtube';
    cEl('srcOther').hidden = kind !== 'other';
    cEl('srcNone').hidden = kind !== 'none';
    cstate.result = null;
    refreshSubmit();
    return;
  }
  if (['cOfficial', 'cChecked', 'cPublished', 'cType'].includes(e.target.id)) { cstate.result = null; refreshSubmit(); }
});

// Pasting the address IS the request to look it up; pressing a second button added nothing.
document.addEventListener('paste', (e) => {
  if (e.target.id !== 'ytUrl') return;
  setTimeout(() => { if (cEl('ytUrl').value.trim()) fetchUrl(); }, 0);
});

document.addEventListener('input', (e) => {
  // Touching an auto-filled field is the operator taking it over; the badge stops claiming otherwise,
  // and a later lookup leaves that field alone.
  const fld = e.target.closest?.('.fld, .check');
  fld?.querySelector('.autofill')?.remove();
  // Editing anything in these two steps means the last attempt's message no longer describes what is
  // on screen, so the line goes back to saying what is still missing.
  if (e.target.closest?.('#stepPick, #stepClip') && cstate.result) { cstate.result = null; refreshSubmit(); }
  if (['cPerformer', 'cTitle', 'cStart', 'cEnd', 'cVersionEv', 'cNameEv', 'cSrcUrl', 'cSrcNote'].includes(e.target.id)) {
    if (e.target.id === 'cStart' && cEl('cEnd') && !cEl('cEnd').value.trim()) {
      const sec = toSeconds(e.target.value);
      if (sec != null) cEl('cEnd').value = `${Math.floor((sec + 25) / 60)}:${String((sec + 25) % 60).padStart(2, '0')}`;
    }
    refreshSubmit();
  }
});

// The form is there from the start now: the first thing to do is pick a file, not paste a link.
document.addEventListener('DOMContentLoaded', () => {
  const host = cEl('pickForm');
  if (!host) return;
  host.innerHTML = step1Html();
  loadVideoFiles();
});
