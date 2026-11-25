'use strict';
/**
 * ① 영상 고르기 · ② 구간과 문구 — the path from a video the operator already has to a finished reel.
 *
 * The file comes first, because that is how the work actually starts: the performance is already in
 * storage/video, and its file name usually says who performed what. Choosing one reads the name and
 * fills the form in. A YouTube link is offered below as an optional extra — it is a better source for
 * the title and channel, and it is what the caption links to — but a reel can be made without one.
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

const cstate = { lookup: null, fileRef: null, videoFiles: null };

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

/** ① as it stands before anything is chosen: the folder first, the link as an afterthought. */
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

  <div class="fld" data-field="url">
    <label for="ytUrl">유튜브 주소 <span class="opt">(출처 기록용 · 선택)</span></label>
    <div class="row">
      <input type="url" id="ytUrl" placeholder="https://www.youtube.com/watch?v=...">
      <button class="btn ghost" id="ytFetch" type="button">가져오기</button>
    </div>
    <span class="fhelp">넣으면 공식 제목·채널로 위 값을 덮어씁니다 (더 정확합니다). 손으로 고친 칸은 그대로 둡니다.
      안 넣어도 영상은 만들어집니다 — 캡션에 공식 영상 주소만 들어가지 않습니다. 영상을 내려받지는 않습니다.</span>
    <div id="ytResult" hidden></div>
  </div>

  <label class="check big" data-field="official"><input type="checkbox" id="cOfficial">
    이 영상의 <b>출처가 공식 채널</b>이 맞습니다 — 프로그램은 확인할 수 없습니다</label>

  ${field('cChannel', '채널 이름 (영상에 「Source:」로 들어갑니다)', { help: '주소를 가져오면 자동으로 채워집니다. 직접 적어도 됩니다.' })}
  ${field('cPublished', '공식 공개일', { type: 'date', help: '유튜브에서 가져올 수 없는 값입니다. 영상 아래에 적힌 공개일을 직접 넣으세요. 파일을 받은 날짜가 아닙니다. 이 날짜가 어느 운영일에 뽑힐 수 있는지를 정합니다.' })}`;
}

/** What a link added: the official title, the channel, and whether the file for it is in the folder. */
function lookupHtml(r) {
  const found = r.local_file
    ? `<p class="small">폴더에서 같은 영상을 찾았습니다 (${r.local_match_by === 'id' ? '영상 번호' : '제목'} 기준): <b>${esc(r.local_file.name)}</b></p>`
    : `<p class="warnbox">${esc(r.local_note ?? '')}<br><button class="btn ghost" id="ytRecheck" type="button">폴더 다시 확인</button></p>`;
  return `<div class="picked">
    ${r.thumbnail_url ? `<img class="thumb" src="${esc(r.thumbnail_url)}" alt="" onerror="this.remove()">` : ''}
    <div>
      <p class="pickedTitle">${esc(r.title ?? '(제목을 가져오지 못했습니다)')}</p>
      <p class="small muted">${esc(r.channel_name ?? '채널 미상')} · <a href="${esc(r.normalized_url)}" target="_blank" rel="noopener noreferrer">영상 보기 ↗</a></p>
    </div>
  </div>
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

/** The save button unlocks only when both confirmations are ticked and the essentials are present. */
function refreshSubmit() {
  const btn = cEl('cSubmit');
  if (!btn) return;
  const need = [
    [cEl('cOfficial')?.checked, '공식 채널 확인'],
    [cEl('cChecked')?.checked, '확인했습니다'],
    [cEl('cPerformer')?.value.trim(), '공연자'],
    [cEl('cTitle')?.value.trim(), '곡명'],
    [cEl('cPublished')?.value, '공개일'],
    [cstate.fileRef, '영상 파일'],
    [cEl('cStart')?.value.trim(), '구간 시작'],
  ].filter(([ok]) => !ok).map(([, label]) => label);
  btn.disabled = need.length > 0;
  cEl('cSubmitState').textContent = need.length ? `아직 비어 있습니다: ${need.join(' · ')}` : '';
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

function pickFile(fileRef, { name = null, suggested = null } = {}) {
  cstate.fileRef = fileRef || null;
  cEl('cFileState').textContent = cstate.fileRef ? `고른 영상: ${name ?? cstate.fileRef}` : '';
  if (!cstate.fileRef) { refreshSubmit(); return; }
  openStep2();
  if (suggested && Object.keys(suggested).length) applySuggestion(suggested);
  refreshSubmit();
}

async function loadVideoFiles() {
  const sel = cEl('cFileList');
  if (!sel) return;
  try {
    const r = await api('/api/entry/video-files');
    cstate.videoFiles = r.files;
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
    autofill('cChannel', r.channel_name);
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

const tagsChecked = () => [...document.querySelectorAll('[data-ctag]')].filter((b) => b.checked).map((b) => b.dataset.ctag);
const val = (id) => cEl(id)?.value.trim() || null;

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
  const say = (t) => { cEl('cSubmitState').textContent = t; };
  const post = async (path, body, what) => {
    try {
      return await api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    } catch (e) { throw new Error(`${what}: ${e.message}`); }
  };
  try {
    const L = cstate.lookup;
    const linked = Boolean(L?.normalized_url);
    const chName = val('cChannel') ?? L?.channel_name ?? '출처 미상';
    const handle = linked ? ((L.channel_url ?? '').split('/').pop() || chName) : `local-${chName}`;

    say('1/6 채널');
    const ch = await post('/api/entry/channel', {
      platform: linked ? 'youtube' : 'local', external_id: handle, name: chName, url: L?.channel_url ?? null,
    }, '채널');

    say('2/6 원본 영상');
    const vid = await post('/api/entry/video', {
      channel_id: ch.row.id,
      platform: linked ? 'youtube' : 'local',
      platform_video_id: linked ? L.video_id : null,
      official_url: linked ? L.normalized_url : '',
      title: L?.title ?? `${val('cPerformer')} – ${val('cTitle')}`,
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
    say(linked ? '' : '출처 링크 없이 등록했습니다 — 캡션에 공식 영상 주소가 들어가지 않습니다.');
    notice(r.status === 'selected'
      ? `등록하고 ${date} 영상까지 만들었습니다. 아래에서 모양을 맞추고 내보내세요.`
      : `등록했습니다. 다만 ${date}에는 이 후보가 뽑히지 않았습니다 — 아래 설명을 보세요.`);
    await loadOverview();
    await showDay(date);
  } catch (e) {
    say('');
    notice(`등록하지 못했습니다 — ${e.message}`, true);
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
  if (e.target.closest('#ytRecheck')) { recheckFolder(); return; }
  if (e.target.closest('#cUploadBtn')) { cEl('cFile').click(); return; }
  if (e.target.closest('#cSubmit')) { submitAll(); return; }
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
  if (['cOfficial', 'cChecked', 'cPublished'].includes(e.target.id)) refreshSubmit();
});

document.addEventListener('input', (e) => {
  // Touching an auto-filled field is the operator taking it over; the badge stops claiming otherwise,
  // and a later lookup leaves that field alone.
  const fld = e.target.closest?.('.fld, .check');
  fld?.querySelector('.autofill')?.remove();
  if (['cPerformer', 'cTitle', 'cStart', 'cEnd'].includes(e.target.id)) {
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
