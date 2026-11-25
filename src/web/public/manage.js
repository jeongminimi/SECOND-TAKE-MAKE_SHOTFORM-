'use strict';
/**
 * The registration screen. Five steps, in the order the data depends on each other:
 * channel → video → song → candidate → clip and rights.
 *
 * Two rules shape the whole screen:
 *  - The server decides what may be saved. This file never duplicates a rule; it posts the form and
 *    renders whatever issues come back, against the field they name.
 *  - A refusal is useless unless it says what to do, so every issue is shown in Korean next to the input.
 *
 * `$`, `esc` and `notice` come from app.js, which loads first.
 */

const STEPS = [
  { id: 'channel', n: 1, label: '공식 채널', hint: '영상이 올라오는 공식 계정' },
  { id: 'video', n: 2, label: '원본 영상', hint: '공식 채널의 영상 한 편' },
  { id: 'track', n: 3, label: '곡', hint: '원곡 정보와 공식 영문 표기' },
  { id: 'candidate', n: 4, label: '공연 후보', hint: '소개할 공연 한 건' },
  { id: 'clip', n: 5, label: '클립 · 이용 허락', hint: '파일과 권리 3종' },
];

/** Where the operator usually reads the interesting moment from. Offered as a placeholder, not filled in. */
const SEGMENT_EVIDENCE_HINT = '유튜브 "가장 많이 본 구간" 그래프 기준';

const RIGHTS_HINT = {
  footage: '영상을 촬영·보유한 쪽 (방송사, 공식 채널 등)',
  music: '작사·작곡·퍼블리싱 쪽',
  performance: '무대에 선 아티스트·기획사 쪽',
};

let mstate = { lists: null, step: 'channel', edit: {}, preview: null, draftCues: [], upload: {} };

// ko, idTag, mmss, $, esc, notice are declared in app.js, which loads first and shares this global
// scope. Re-declaring them here throws "Identifier has already been declared", which aborts this
// whole file and leaves the 데이터 등록 tab dead, so they are deliberately not redeclared.

/**
 * Identifiers the program makes for itself. Left blank, the server builds one from the names typed;
 * folded away here so nobody has to invent `P003-orbit-bluehour` before they can press save.
 */
const ADVANCED = {
  track: [{ name: 'track_key', label: '곡 식별자', help: '비워 두면 곡명을 바탕으로 자동으로 만들어집니다.' }],
  candidate: [{ name: 'candidate_key', label: '후보 식별자', help: '비워 두면 공연자·곡명으로 자동으로 만들어집니다.' }],
  'clip-asset': [{ name: 'asset_key', label: '클립 식별자', help: '비워 두면 후보 이름을 바탕으로 자동으로 만들어집니다.' }],
};

const advancedBox = (kind, data) => {
  const fields = ADVANCED[kind];
  if (!fields) return '';
  return `<details class="advanced"><summary class="small muted">고급 설정 (평소에는 건드릴 필요 없습니다)</summary>
    ${fields.map((f) => field(f, data)).join('')}</details>`;
};

const allFields = (kind) => [...(STEP_FIELDS[kind] ? STEP_FIELDS[kind](mstate.lists) : []), ...(ADVANCED[kind] ?? [])];

const mapi = async (path, opts) => {
  const r = await fetch(path, opts);
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok && j.ok !== false, status: r.status, ...j };
};

const val = (v) => (v === null || v === undefined ? '' : String(v));

// ── field rendering ───────────────────────────────────────────────────────────────────────────────

function field(f, data) {
  const v = val(data?.[f.name]);
  const id = `f_${f.name}`;
  const help = f.help ? `<span class="fhelp">${esc(f.help)}</span>` : '';
  let input;
  if (f.type === 'textarea') input = `<textarea id="${id}" name="${f.name}" rows="${f.rows ?? 2}">${esc(v)}</textarea>`;
  else if (f.type === 'select') {
    input = `<select id="${id}" name="${f.name}">${(f.options ?? []).map((o) =>
      `<option value="${esc(o.value)}" ${String(o.value) === v ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`;
  } else if (f.type === 'checkbox') input = `<input type="checkbox" id="${id}" name="${f.name}" ${data?.[f.name] ? 'checked' : ''}>`;
  else input = `<input type="${f.type ?? 'text'}" id="${id}" name="${f.name}" value="${esc(v)}" ${f.placeholder ? `placeholder="${esc(f.placeholder)}"` : ''} ${f.step ? `step="${f.step}"` : ''}>`;
  return `<div class="fld ${f.type === 'checkbox' ? 'inline' : ''}" data-field="${f.name}">
    <label for="${id}">${esc(f.label)}${f.evidence ? ' <span class="req">근거 필수</span>' : ''}</label>
    ${input}${help}<div class="ferr" hidden></div></div>`;
}

function readForm(form, fields) {
  const out = {};
  for (const f of fields) {
    const el = form.elements[f.name];
    if (!el) continue;
    if (f.type === 'checkbox') out[f.name] = el.checked ? 1 : 0;
    else if (f.type === 'number') out[f.name] = el.value === '' ? null : Number(el.value);
    else out[f.name] = el.value === '' ? null : el.value;
  }
  return out;
}

/** Clears old messages, then puts each issue under the input it belongs to. */
function showIssues(form, issues) {
  form.querySelectorAll('.ferr').forEach((e) => { e.hidden = true; e.textContent = ''; e.className = 'ferr'; });
  form.querySelectorAll('.fld').forEach((e) => e.classList.remove('bad', 'warned'));
  const loose = [];
  for (const i of issues ?? []) {
    const box = form.querySelector(`.fld[data-field="${CSS.escape(i.field)}"]`);
    if (!box) { loose.push(i); continue; }
    box.classList.add(i.level === 'block' ? 'bad' : 'warned');
    const err = box.querySelector('.ferr');
    err.hidden = false;
    err.className = `ferr ${i.level}`;
    err.textContent = (i.level === 'block' ? '저장 불가 — ' : '참고 — ') + i.ko;
  }
  return loose;
}

function formShell(title, intro, inner) {
  return `<section class="card"><h3>${esc(title)}</h3><p class="small muted">${intro}</p>${inner}</section>`;
}

const rowsTable = (head, rows) =>
  `<div class="table-wrap"><table class="cands"><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows || ''}</tbody></table></div>`;

const activeCell = (kind, row) => `<td><button class="btn tiny ${row.is_active ? 'ghost' : ''}" data-active="${kind}:${row.id}:${row.is_active ? 0 : 1}">
  ${row.is_active ? '사용 중 · 끄기' : '꺼짐 · 켜기'}</button></td>`;

// ── steps ─────────────────────────────────────────────────────────────────────────────────────────

const STEP_FIELDS = {
  channel: () => [
    { name: 'platform', label: '플랫폼', type: 'select', options: [{ value: 'youtube', label: 'youtube' }, { value: 'instagram', label: 'instagram' }, { value: 'tiktok', label: 'tiktok' }] },
    { name: 'external_id', label: '공식 채널 ID', help: '예: UCxxxxxxxx. 채널 URL 끝부분입니다.' },
    { name: 'name', label: '채널 이름' },
    { name: 'is_test', label: '테스트용 채널 (실제 발행에서 거부됨)', type: 'checkbox' },
  ],
  video: (L) => [
    { name: 'channel_id', label: '공식 채널', type: 'select', options: L.channels.map((c) => ({ value: c.id, label: `${c.name}${c.is_active ? '' : ' (꺼짐)'}` })) },
    { name: 'platform', label: '플랫폼', type: 'select', options: [{ value: 'youtube', label: 'youtube' }] },
    { name: 'platform_video_id', label: '영상 ID', help: 'YouTube 주소의 v= 뒤 부분입니다. 같은 ID는 중복 등록되지 않습니다.' },
    { name: 'official_url', label: '공식 링크', help: 'http:// 또는 https:// 로 시작하는 공식 영상 주소' },
    { name: 'title', label: '영상 제목', help: '공식 제목을 그대로 적습니다. 번역하지 않습니다.' },
    { name: 'published_at', label: '공식 게시 시각 (UTC)', help: '예: 2026-11-20T09:00:00Z. 이 날짜 이전 운영일에는 선곡되지 않습니다.' },
    { name: 'description', label: '영상 설명 (선택)', type: 'textarea', rows: 3, help: '챕터 목록이 있으면 근거로 인용할 수 있어 붙여 두면 좋습니다.' },
  ],
  track: () => [
    { name: 'title_en', label: '공식 영문 곡명', help: '공식 표기가 없으면 비워 두세요. 번역하거나 지어내지 않습니다.' },
    { name: 'title_ko', label: '한글 곡명' },
    { name: 'original_artist_en', label: '원곡 아티스트 (영문)' },
    { name: 'original_artist_ko', label: '원곡 아티스트 (한글)' },
    { name: 'name_evidence', label: '영문 표기 근거', help: '어디서 확인했는지. 없으면 영어 소개 정보 점수(25점)를 받지 못합니다.' },
  ],
  candidate: (L) => [
    { name: 'source_video_id', label: '원본 영상', type: 'select', options: L.videos.map((v) => ({ value: v.id, label: `${v.title}${v.is_active ? '' : ' (꺼짐)'}` })) },
    { name: 'track_id', label: '곡', type: 'select', options: [{ value: '', label: '— 고르세요 —' }, ...L.tracks.map((t) => ({ value: t.id, label: `${t.title_en ?? t.title_ko ?? '제목 없음'}${t.original_artist_en ? ` · ${t.original_artist_en}` : ''}` }))] },
    { name: 'performer_en', label: '실제 공연자 (영문)', help: '원곡 가수가 아니라 이 무대에 선 사람입니다. 비면 선곡에서 제외됩니다.' },
    { name: 'performer_ko', label: '실제 공연자 (한글)' },
    { name: 'program_name', label: '프로그램·무대 이름', help: '예: Seoul Live Sessions' },
    { name: 'performance_type', label: '공연 유형', type: 'select', options: [{ value: '', label: '— 고르세요 —' }, { value: 'live', label: 'live (본인 곡 라이브)' }, { value: 'cover', label: 'cover (다른 사람 곡)' }] },
    { name: 'version_evidence', label: '버전 근거', evidence: true, type: 'textarea', help: '편곡 태그를 하나라도 고르면 반드시 필요합니다. 공식 제목·설명에서 그 차이가 확인되는 문구를 적으세요.' },
    { name: 'why_watch_en', label: '왜 볼 만한가 (영어 한 줄)', help: '직접 보고 느낀 점을 쓰세요. 출처가 있으면 함께 적어도 됩니다. 비우면 사실만으로 만든 문장이 대신 쓰입니다.' },
    { name: 'why_watch_evidence', label: '↳ 그 한 줄의 근거 (선택)' },
    { name: 'segment_start_sec', label: '확인된 추천 구간 시작', help: '1:23 처럼 분:초로 적어도 되고, 초 단위 숫자로 적어도 됩니다. 캡션에 ▶ 시각으로 들어갑니다.' },
    { name: 'segment_end_sec', label: '↳ 끝' },
    { name: 'segment_evidence', label: '↳ 그 시각의 출처', evidence: true, placeholder: SEGMENT_EVIDENCE_HINT },
    { name: 'occasion_note', label: '지금 소개할 이유 (선택)', help: '예: 공식 10주년. 적으면 근거가 필요합니다.' },
    { name: 'occasion_date', label: '↳ 해당 날짜', type: 'date' },
    { name: 'occasion_evidence', label: '↳ 그 이유의 근거', evidence: true },
    { name: 'extra_hashtags', label: '해시태그 직접 추가 (선택)', placeholder: '#kpop #seventeen', help: '공연자·곡명으로 만든 태그 뒤에 그대로 붙습니다. 저장해 두면 이 후보로 다시 만들 때도 쓰입니다.' },
    { name: 'judgement_notes', label: '운영 메모 (선택)', type: 'textarea', help: '어떻게 확인했는지 남겨 두면 나중에 판단을 되짚을 수 있습니다.' },
  ],
};

function stepChannel(L) {
  const fields = STEP_FIELDS.channel(L);
  const rows = L.channels.map((c) => `<tr><td><b>${esc(c.name)}</b><div class="k">${esc(c.platform)} · ${esc(c.external_id)}</div></td>
    <td>${c.is_test ? '<span class="badge warn">테스트</span>' : ''}</td>${activeCell('channel', c)}
    <td><button class="btn tiny ghost" data-edit="channel:${c.id}">수정</button></td></tr>`).join('');
  return formShell('1. 공식 채널', '영상이 올라오는 공식 계정을 등록합니다. 꺼 두면 그 채널의 모든 후보가 선곡에서 빠집니다.',
    `<form class="entry" data-kind="channel">${fields.map((f) => field(f, mstate.edit.channel)).join('')}
      <div class="actions"><button class="btn" type="submit">저장</button>${mstate.edit.channel ? '<button class="btn ghost" type="button" data-cancel>새로 입력</button>' : ''}</div></form>`)
    + `<section class="card"><h3>등록된 채널 ${L.channels.length}개</h3>${rowsTable(['채널', '', '사용', ''], rows)}</section>`;
}

function stepVideo(L) {
  if (!L.channels.length) return formShell('2. 원본 영상', '먼저 1단계에서 공식 채널을 등록하세요.', '<p class="muted">등록된 채널이 없습니다.</p>');
  const fields = STEP_FIELDS.video(L);
  const rows = L.videos.map((v) => `<tr><td><b>${esc(v.title)}</b><div class="k">${esc(v.channel_name)} · ${esc(v.platform_video_id)}</div></td>
    <td class="small">${esc(v.published_at)}</td>${activeCell('video', v)}
    <td><button class="btn tiny ghost" data-edit="video:${v.id}">수정</button></td></tr>`).join('');
  return formShell('2. 원본 영상', '공식 채널에 올라온 영상 한 편입니다. 영상 파일을 올리는 단계가 아니라 <b>어떤 공식 영상인지</b>를 적는 단계입니다.',
    `<form class="entry" data-kind="video">${fields.map((f) => field(f, mstate.edit.video)).join('')}
      <div class="actions"><button class="btn" type="submit">저장</button>${mstate.edit.video ? '<button class="btn ghost" type="button" data-cancel>새로 입력</button>' : ''}</div></form>`)
    + `<section class="card"><h3>등록된 영상 ${L.videos.length}개</h3>${rowsTable(['영상', '공식 게시', '사용', ''], rows)}</section>`;
}

function stepTrack(L) {
  const fields = STEP_FIELDS.track(L);
  const rows = L.tracks.map((t) => `<tr><td><b>${esc(t.title_en ?? '영문 곡명 없음')}</b> ${esc(t.title_ko ?? '')}${idTag(t.track_key)}</td>
    <td>${esc(t.original_artist_en ?? '')}</td>
    <td>${t.name_evidence ? '<span class="badge ok">근거 있음</span>' : '<span class="badge warn">근거 없음</span>'}</td>
    <td><button class="btn tiny ghost" data-edit="track:${t.id}">수정</button></td></tr>`).join('');
  return formShell('3. 곡', '원곡 정보입니다. 같은 곡의 라이브와 커버는 이 곡 하나를 함께 가리킵니다.',
    `<form class="entry" data-kind="track">${fields.map((f) => field(f, mstate.edit.track)).join('')}
      ${advancedBox('track', mstate.edit.track)}
      <div class="actions"><button class="btn" type="submit">저장</button>${mstate.edit.track ? '<button class="btn ghost" type="button" data-cancel>새로 입력</button>' : ''}</div></form>`)
    + `<section class="card"><h3>등록된 곡 ${L.tracks.length}개</h3>${rowsTable(['곡', '원곡 아티스트', '영문 표기 근거', ''], rows)}</section>`;
}

function cuesEditor() {
  const rows = mstate.draftCues.map((q, i) => `<div class="cue" data-cue="${i}">
    <input type="number" step="0.1" placeholder="시점(초)" value="${esc(val(q.at_sec))}" data-cue-at>
    <input type="text" placeholder="영어 설명" value="${esc(val(q.text_en))}" data-cue-text>
    <input type="text" placeholder="근거 (없으면 저장 안 됨)" value="${esc(val(q.evidence))}" data-cue-ev>
    <button type="button" class="btn tiny ghost" data-cue-del="${i}">삭제</button></div>`).join('');
  return `<div class="fld" data-field="watch_cues"><label>시청 포인트 <span class="req">근거 필수</span></label>
    <span class="fhelp">공식 영상에서 "여기를 보세요"라고 할 시점입니다. 근거가 없는 항목은 저장되지 않습니다.</span>
    <div class="cues">${rows}</div>
    <button type="button" class="btn tiny ghost" id="addCue">+ 시청 포인트 추가</button><div class="ferr" hidden></div></div>`;
}

function stepCandidate(L) {
  if (!L.videos.length) return formShell('4. 공연 후보', '먼저 2단계에서 원본 영상을 등록하세요.', '<p class="muted">등록된 영상이 없습니다.</p>');
  const fields = STEP_FIELDS.candidate(L);
  const tags = L.arrangementTags.map((t) => {
    const on = (mstate.edit.candidate?.arrangement_tags ?? []).includes(t);
    return `<label class="tag-pick"><input type="checkbox" data-tag="${esc(t)}" ${on ? 'checked' : ''}> ${esc(t)}</label>`;
  }).join('');
  const tagBox = `<div class="fld" data-field="arrangement_tags"><label>편곡 태그</label>
    <span class="fhelp">하나라도 고르면 아래 "버전 근거"가 반드시 필요합니다. 이 계정의 핵심이 "원곡과 다른 버전"이기 때문입니다.</span>
    <div class="tags-pick">${tags}</div><div class="ferr" hidden></div></div>`;

  const rows = L.candidates.map((c) => `<tr class="${c.is_active ? '' : 'off'}">
    <td><b>${esc(c.performer_en ?? '공연자 미입력')}</b> – ${esc(c.title_en ?? c.title_ko ?? '곡 미연결')}${idTag(c.candidate_key)}</td>
    <td>${esc([c.performance_type, ...(c.arrangement_tags ?? [])].filter(Boolean).map((t) => ko('tag', t)).join(' · '))}</td>
    <td>${c.clip_assets.length ? `<span class="badge info">클립 ${c.clip_assets.length}개</span>` : '<span class="muted">클립 없음</span>'}</td>
    ${activeCell('candidate', c)}
    <td><button class="btn tiny ghost" data-edit="candidate:${c.id}">수정</button>
        <button class="btn tiny" data-preview="${c.id}">형식 확인</button></td></tr>`).join('');

  const idx = fields.findIndex((f) => f.name === 'version_evidence');
  const before = fields.slice(0, idx).map((f) => field(f, mstate.edit.candidate)).join('');
  const after = fields.slice(idx).map((f) => field(f, mstate.edit.candidate)).join('');
  return formShell('4. 공연 후보', '소개할 공연 한 건입니다. <b>근거 필수</b> 표시가 붙은 칸은, 위 칸에 무언가를 적었다면 반드시 함께 채워야 저장됩니다.',
    `<form class="entry" data-kind="candidate">${before}${tagBox}${after}${cuesEditor()}
      ${advancedBox('candidate', mstate.edit.candidate)}
      <div class="actions"><button class="btn" type="submit">저장하고 형식 확인</button>${mstate.edit.candidate ? '<button class="btn ghost" type="button" data-cancel>새로 입력</button>' : ''}</div></form>`)
    + `<section class="card" id="previewCard">${previewHtml()}</section>`
    + `<section class="card"><h3>등록된 후보 ${L.candidates.length}개</h3>${rowsTable(['후보', '버전', '클립', '사용', ''], rows)}</section>`;
}

function previewHtml() {
  const p = mstate.preview;
  if (!p) {
    return `<h3>이 후보는 어떻게 나갈까요</h3>
      <p class="muted">후보를 저장하거나 목록에서 <b>형식 확인</b>을 누르면, 그 후보가 오늘 뽑힐 경우 공연 클립형과 자체 그래픽형 중 무엇이 되고 왜 그런지 여기에 나옵니다.</p>`;
  }
  return `<h3>이 후보는 어떻게 나갈까요 <span class="muted small">${esc(p.operating_date)} 기준</span></h3>
    <p><b style="font-size:16px">${esc(p.display_name ?? '')}</b></p>
    <p><span class="badge ${p.format === 'licensed_clip' ? 'info' : 'warn'}">${esc(ko('format', p.format))}</span>
       <span class="badge ${p.eligible ? 'ok' : 'bad'}">${p.eligible ? '뽑힐 수 있음' : '지금은 뽑히지 않음'}</span>
       ${p.score ? `<span class="badge">${p.score.total}/100점</span>` : ''}</p>
    <p class="reason">${esc(p.format_reason_ko ?? p.format_reason)}</p>
    ${p.eligible ? '' : `<h4 class="small muted">아직 뽑히지 않는 이유</h4>
      <ul class="checks">${p.exclusions.map((x) => `<li class="no">${esc(x.text_ko ?? x.text)}</li>`).join('')}</ul>`}
    ${p.clip.assets.length ? `<h4 class="small muted" style="margin-top:14px">클립 권리 점검</h4>${p.clip.assets.map((a) => `<details class="asset" ${a.eligible ? '' : 'open'}>
      <summary>${a.personalUseOnly ? '<span class="badge bad">권리 미확인 · 개인 확인용</span>'
        : a.eligible ? '<span class="badge ok">권리 확보</span>' : '<span class="badge bad">권리 미비</span>'}
        ${a.personalUseOnly || !a.testOnly ? '' : '<span class="badge warn">테스트 소재 · 실제 게시 불가</span>'}<span class="k">${esc(a.asset_key)}</span></summary>
      <ul class="checks">${a.checks.map((c) => `<li class="${c.testOnly ? 'test' : c.ok ? '' : 'no'}">${esc(c.label_ko ?? c.label)}</li>`).join('')}</ul></details>`).join('')}` : ''}
    ${p.score ? `<details style="margin-top:10px"><summary class="small muted">점수를 어떻게 매겼는지 보기</summary>
      <ul class="checks">${p.score.items.map((i) => `<li class="${i.points === i.max ? '' : 'no'}">${esc(ko('score', i.key))} ${i.points}/${i.max} — ${esc(i.reason_ko ?? i.reason)}</li>`).join('')}</ul></details>` : ''}`;
}

function stepClip(L) {
  const withClips = L.candidates;
  if (!withClips.length) return formShell('5. 클립 · 이용 허락', '먼저 4단계에서 공연 후보를 등록하세요.', '<p class="muted">등록된 후보가 없습니다.</p>');
  const sel = mstate.edit.clipCandidateId ?? withClips[0].id;
  const cand = withClips.find((c) => String(c.id) === String(sel)) ?? withClips[0];
  const nameOf = (c) => `${c.performer_en ?? '공연자 미입력'} – ${c.title_en ?? c.title_ko ?? '곡 미연결'}`;
  const personalOn = Boolean(mstate.edit.clipAsset?.personal_use_only);
  const clipMax = L.clipSeconds?.max ?? 30;
  const picker = `<div class="fld"><label for="clipCand">어느 후보의 클립인가요</label>
    <select id="clipCand">${withClips.map((c) => `<option value="${c.id}" ${c.id === cand.id ? 'selected' : ''}>${esc(nameOf(c))}</option>`).join('')}</select></div>`;

  const assets = cand.clip_assets.map((a) => {
    // A personal-use clip has no rights to show, so the rights area is replaced by what it means instead.
    if (a.personal_use_only) {
      return `<div class="asset"><h4>사용 구간 ${TERMS.range(a.source_start_sec, a.source_end_sec)}
          <span class="badge bad">권리 미확인 · 개인 확인용</span></h4>
        ${idTag(a.asset_key)}
        <p class="small muted">영상·음악·실연 권리를 입력하지 않는 클립입니다. 예행 연습에서는 영상이 만들어지지만,
          실제 발행은 영구히 막힙니다. 공개 게시하면 안 됩니다.</p>
        <details class="small muted" style="margin-top:8px"><summary>파일 정보</summary>
          <p class="k">${esc(a.file_ref)} · 파일 내 시작 ${TERMS.mmss(a.file_offset_sec)}</p></details></div>`;
    }
    const perms = (L.rightsCategories ?? []).map((cat) => {
      const p = a.permissions.find((x) => x.rights_category === cat);
      const ok = p && p.status === 'granted' && p.allows_edit && p.allows_repost && p.evidence_ref;
      return `<span class="badge ${ok ? 'ok' : 'bad'}">${esc(ko('category', cat))} ${ok ? '확보' : '미비'}</span>`;
    }).join(' ');
    return `<div class="asset"><h4>사용 구간 ${TERMS.range(a.source_start_sec, a.source_end_sec)}
        ${a.is_test_asset ? '<span class="badge warn">테스트 소재</span>' : ''}</h4>
      ${idTag(a.asset_key)}
      <p>${perms}</p>
      <div class="actions">${(L.rightsCategories ?? []).map((cat) =>
        `<button class="btn tiny ghost" data-perm="${a.id}:${cat}">${esc(ko('category', cat))} 입력</button>`).join('')}</div>
      <details class="small muted" style="margin-top:8px"><summary>파일 정보</summary>
        <p class="k">${esc(a.file_ref)} · 파일 내 시작 ${TERMS.mmss(a.file_offset_sec)}</p></details>
      <div class="perm-slot" data-perm-slot="${a.id}"></div></div>`;
  }).join('') || '<p class="muted">이 후보에는 아직 클립이 없습니다. 위 양식에서 파일을 올리면 공연 클립형으로 만들 수 있게 됩니다.</p>';

  return formShell('5. 클립 · 이용 허락',
    '적법하게 확보한 영상 파일과, 그 파일에 대한 <b>영상·음악·실연</b> 세 가지 이용 허락을 등록합니다. 세 가지가 모두 충족될 때만 공연 클립형 릴스가 만들어집니다.',
    picker + `<form class="entry" data-kind="clip-asset" ${personalOn ? 'data-personal' : ''}>
      <input type="hidden" name="candidate_id" value="${cand.id}">
      <div class="fld" data-field="file_ref"><label>클립 파일</label>
        <span class="fhelp">공식 링크는 파일이 아닙니다. 적법하게 확보한 동영상 파일을 올리세요. storage/clips 에 저장됩니다.</span>
        <input type="file" id="clipFile" accept="video/*">
        <div class="upstate" id="clipUpState">${mstate.upload.clip ? `올림 완료: ${esc(mstate.upload.clip)}` : ''}</div>
        <input type="hidden" name="file_ref" value="${esc(val(mstate.upload.clip))}"><div class="ferr" hidden></div></div>
      ${[{ name: 'source_start_sec', label: '원본에서 쓸 구간 시작', placeholder: '1:23',
          help: '유튜브에서 읽은 그대로 1:23 처럼 적어도 되고, 초 단위 숫자(83)로 적어도 됩니다. 시작을 적으면 끝이 자동으로 채워집니다.' },
        { name: 'source_end_sec', label: '↳ 끝', placeholder: '1:48', help: `길이는 ${clipMax}초를 넘을 수 없습니다. 자동으로 채워진 값은 고쳐도 됩니다.` },
        { name: 'segment_evidence', label: '그 시각을 어떻게 알았나요', placeholder: SEGMENT_EVIDENCE_HINT,
          help: '적으면 캡션에 ▶ 시각이 들어갑니다. 비워 두면 전체 영상으로만 링크됩니다. 이 후보의 "추천 구간 근거"에 저장됩니다.' },
        { name: 'file_offset_sec', label: '파일 안에서의 시작 위치 (초)', type: 'number', help: '올린 파일이 원본 전체가 아니라 잘라낸 것이라면, 그 시작점이 원본의 몇 초인지에 맞춰 적습니다.' },
        { name: 'is_test_asset', label: '테스트 소재 (실제 발행에서 거부됨)', type: 'checkbox' },
        { name: 'personal_use_only', label: '개인 확인용 (권리 입력 건너뛰기)', type: 'checkbox',
          help: '내 PC에 있는 영상을 잘라서 어떻게 보이는지 확인만 합니다. 권리 3종을 입력하지 않아도 영상이 만들어집니다. '
            + '대신 이 영상은 실제 발행이 영구히 막히고, 공개 게시하면 안 됩니다.' },
        { name: 'notes', label: '메모 (선택)' }].map((f) => field(f, mstate.edit.clipAsset)).join('')}
      <div class="upstate" id="personalHint" ${personalOn ? '' : 'hidden'}>권리 3종은 입력하지 않아도 됩니다. 아래 권리 영역을 흐리게 표시했습니다.</div>
      ${advancedBox('clip-asset', mstate.edit.clipAsset)}
      <div class="actions"><button class="btn" type="submit">클립 저장</button></div></form>`)
    + `<section class="card${personalOn ? ' dimmed' : ''}" id="clipRights"><h3>${esc(cand.candidate_key)} 의 클립</h3>${assets}</section>`
    + `<section class="card" id="previewCard">${previewHtml()}</section>`;
}

function permForm(assetId, cat, L, existing) {
  const label = ko('category', cat);
  const f = (spec) => field(spec, existing);
  return `<form class="entry perm" data-kind="permission" data-asset="${assetId}" data-cat="${cat}">
    <h4>${esc(label)} 권리 <span class="small muted">${esc(RIGHTS_HINT[cat] ?? '')}</span></h4>
    ${f({ name: 'rights_holder', label: '권리자' })}
    ${f({ name: 'status', label: '허락 상태', type: 'select', options: ['granted', 'pending', 'denied', 'revoked'].map((v) => ({ value: v, label: ko('permissionStatus', v) })) })}
    ${f({ name: 'allows_edit', label: '편집 허용', type: 'checkbox' })}
    ${f({ name: 'allows_repost', label: 'Instagram 재게시 허용', type: 'checkbox' })}
    ${f({ name: 'valid_from', label: '허락 시작 (UTC)', help: '예: 2026-11-01T00:00:00Z' })}
    ${f({ name: 'valid_until', label: '허락 종료 (UTC)', help: '게시 시점 +30일 이상 남아 있어야 통과합니다. 게시물은 계속 노출되기 때문입니다.' })}
    ${f({ name: 'permitted_start_sec', label: '허락된 구간 시작 (초)', type: 'number' })}
    ${f({ name: 'permitted_end_sec', label: '↳ 끝 (초)', type: 'number', help: '위에서 정한 사용 구간을 모두 포함해야 합니다.' })}
    <div class="fld" data-field="evidence_ref"><label>이용 허락 증빙</label>
      <span class="fhelp">메일·계약서 등을 올리면 storage/evidence 에 보관되고, 데이터베이스에는 참조값만 남습니다. 원본은 Git에 들어가지 않습니다.</span>
      <input type="file" data-ev-file>
      <div class="upstate" data-ev-state>${existing?.evidence_ref ? esc(TERMS.evidence(existing.evidence_ref)) : ''}</div>
      <input type="hidden" name="evidence_ref" value="${esc(val(existing?.evidence_ref))}"><div class="ferr" hidden></div></div>
    ${f({ name: 'is_test_permission', label: '가상 테스트 권한 (실제 발행에서 거부됨)', type: 'checkbox' })}
    <div class="actions"><button class="btn" type="submit">${esc(label)} 권리 저장</button>
      <button class="btn ghost" type="button" data-perm-close>닫기</button></div></form>`;
}

const PERM_FIELDS = [
  { name: 'rights_holder' }, { name: 'status' }, { name: 'allows_edit', type: 'checkbox' }, { name: 'allows_repost', type: 'checkbox' },
  { name: 'valid_from' }, { name: 'valid_until' }, { name: 'permitted_start_sec', type: 'number' }, { name: 'permitted_end_sec', type: 'number' },
  { name: 'evidence_ref' }, { name: 'is_test_permission', type: 'checkbox' },
];

// ── wiring ────────────────────────────────────────────────────────────────────────────────────────

const RENDER = { channel: stepChannel, video: stepVideo, track: stepTrack, candidate: stepCandidate, clip: stepClip };

async function loadLists() {
  mstate.lists = await mapi('/api/entry/lists');
}

function renderSteps() {
  $('#stepList').innerHTML = STEPS.map((s) => `<li><button data-step="${s.id}" class="${mstate.step === s.id ? 'active' : ''}">
    <span class="d">단계 ${s.n}</span><span>${esc(s.label)}</span><span class="t">${esc(s.hint)}</span></button></li>`).join('');
}

/** Hands the main area to 자료 손보기, or back to the make-a-reel flow. */
function showManage(on) {
  $('#managePanel').hidden = !on;
  for (const id of ['#stepPick', '#stepClip', '#detail']) {
    const el = $(id);
    if (el) el.hidden = on ? true : (id === '#stepClip' ? !cstate?.lookup : false);
  }
}

async function renderManage() {
  if (!mstate.lists) await loadLists();
  renderSteps();
  $('#managePanel').innerHTML = `<div class="actions" style="margin-bottom:12px">
      <button class="btn ghost" id="manageClose" type="button">← 영상 만들기로 돌아가기</button></div>`
    + RENDER[mstate.step](mstate.lists);
}

async function refreshPreview(candidateId) {
  const r = await mapi(`/api/entry/preview/${candidateId}?date=${mstate.lists.today}`);
  mstate.preview = r.ok ? r.preview : null;
  const card = $('#previewCard');
  if (card) card.innerHTML = previewHtml();
  if (card) card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function uploadFile(kind, file) {
  const r = await fetch(`/api/entry/upload/${kind}?name=${encodeURIComponent(file.name)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file,
  });
  const j = await r.json();
  if (!r.ok || !j.ok) throw new Error(j.error || '업로드 실패');
  return j;
}

async function submitEntry(form) {
  const kind = form.dataset.kind;
  let payload;
  if (kind === 'permission') {
    payload = { clip_asset_id: Number(form.dataset.asset), rights_category: form.dataset.cat, ...readForm(form, PERM_FIELDS) };
    payload.platforms = ['instagram'];
    payload.territories = ['WORLDWIDE'];
  } else if (kind === 'clip-asset') {
    // The range is sent as typed (1:23 or 83); the server reads both. segment_evidence is not a clip
    // field — it belongs to the candidate, and goes in a second call once the clip itself is saved.
    payload = { candidate_id: Number(form.elements.candidate_id.value), file_ref: form.elements.file_ref.value || null,
      ...readForm(form, [{ name: 'source_start_sec' }, { name: 'source_end_sec' },
        { name: 'file_offset_sec', type: 'number' }, { name: 'is_test_asset', type: 'checkbox' },
        { name: 'personal_use_only', type: 'checkbox' }, { name: 'notes' }, { name: 'asset_key' }]) };
  } else {
    payload = readForm(form, allFields(kind));
    if (mstate.edit[kind]?.id) payload.id = mstate.edit[kind].id;
    if (kind === 'candidate') {
      payload.arrangement_tags = [...form.querySelectorAll('[data-tag]')].filter((b) => b.checked).map((b) => b.dataset.tag);
      payload.watch_cues = readCues(form);
      payload.source_video_id = Number(payload.source_video_id);
      payload.track_id = payload.track_id ? Number(payload.track_id) : null;
    }
    if (kind === 'video') payload.channel_id = Number(payload.channel_id);
  }

  const r = await mapi(`/api/entry/${kind}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (!r.ok) {
    const loose = showIssues(form, r.issues ?? []);
    const placed = (r.issues ?? []).length - loose.length;
    notice(placed ? '저장하지 못했습니다. 빨간 칸의 설명을 확인하세요.' : `저장하지 못했습니다: ${r.error}`, true);
    return;
  }
  showIssues(form, r.warnings ?? []);
  let warned = (r.warnings ?? []).length;

  // The moment and its source live on the candidate, so a clip save carries them across in one step.
  let segmentNote = '';
  if (kind === 'clip-asset' && (form.elements.segment_evidence?.value ?? '').trim() !== '') {
    const seg = await mapi('/api/entry/segment', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        candidate_id: payload.candidate_id,
        start_sec: payload.source_start_sec,
        end_sec: payload.source_end_sec,
        evidence: form.elements.segment_evidence.value,
      }),
    });
    if (seg.ok) {
      warned += (seg.warnings ?? []).length;
      segmentNote = ' 캡션에 ▶ 시각이 들어갑니다.'
        + (seg.rerunDates?.length ? ` 구간이 바뀌어 ${seg.rerunDates.join(', ')} 영상을 다시 만들었습니다 (다시 고르지 않았습니다).` : '');
    }
    else { showIssues(form, seg.issues ?? []); segmentNote = ` 다만 추천 구간은 저장하지 못했습니다: ${seg.error ?? '빨간 칸을 확인하세요'}`; }
  }
  const NEXT = {
    channel: '다음은 2단계(원본 영상)입니다.',
    video: '다음은 3단계(곡)입니다.',
    track: '다음은 4단계(공연 후보)입니다.',
    candidate: '아래에 이 후보가 어떤 형식으로 나갈지 표시했습니다. 공연 클립형으로 만들려면 5단계로 넘어가세요.',
    'clip-asset': (r.rerunDates ?? []).length
      ? `구간이 바뀌어 ${r.rerunDates.join(', ')} 영상을 다시 만들었습니다 — 다시 고르지 않았으니 선곡 기록은 그대로입니다.`
      : '이제 영상·음악·실연 세 가지 권리를 각각 입력하세요. 셋이 다 채워져야 공연 클립형이 됩니다.',
    permission: '나머지 권리도 같은 방식으로 채우면 공연 클립형으로 바뀝니다.',
  };
  notice(`저장했습니다.${segmentNote} ${warned ? `확인할 점이 ${warned}가지 있습니다 (노란 설명). ` : ''}${NEXT[kind] ?? ''}`);

  mstate.edit = {};
  mstate.upload = {};
  mstate.draftCues = [];
  const candidateId = kind === 'candidate' ? r.row.id : (kind === 'clip-asset' || kind === 'permission' ? currentCandidateId() : null);
  await loadLists();
  await renderManage();
  if (candidateId) await refreshPreview(candidateId);
  if (typeof loadOverview === 'function') loadOverview().catch(() => {});
}

function currentCandidateId() {
  const sel = document.getElementById('clipCand');
  return sel ? Number(sel.value) : null;
}

function readCues(form) {
  return [...form.querySelectorAll('.cue')].map((row) => {
    const at = row.querySelector('[data-cue-at]').value;
    return {
      at_sec: at === '' ? null : Number(at),
      text_en: row.querySelector('[data-cue-text]').value || null,
      evidence: row.querySelector('[data-cue-ev]').value || null,
    };
  }).filter((q) => q.at_sec !== null || q.text_en || q.evidence);
}

/** Adding or removing a cue re-renders the form, so whatever is typed has to be carried over first. */
function captureCandidateForm(form) {
  mstate.draftCues = readCues(form);
  mstate.edit.candidate = {
    ...(mstate.edit.candidate ?? {}),
    ...readForm(form, allFields('candidate')),
    arrangement_tags: [...form.querySelectorAll('[data-tag]')].filter((b) => b.checked).map((b) => b.dataset.tag),
  };
}

document.addEventListener('click', async (e) => {
  // 자료 손보기 lives in the left column now. Opening a step takes over the main area; closing it
  // gives the main area back to the make-a-reel flow, which is what the screen is normally for.
  const backToFlow = e.target.closest('#manageClose');
  if (backToFlow) { showManage(false); return; }

  const step = e.target.closest('[data-step]');
  if (step) { mstate.step = step.dataset.step; mstate.edit = {}; mstate.upload = {}; mstate.draftCues = []; showManage(true); await renderManage(); return; }

  const addCue = e.target.closest('#addCue');
  if (addCue) {
    captureCandidateForm(addCue.closest('form'));
    mstate.draftCues.push({ at_sec: null, text_en: '', evidence: '' });
    await renderManage();
    return;
  }
  const delCue = e.target.closest('[data-cue-del]');
  if (delCue) {
    captureCandidateForm(delCue.closest('form'));
    mstate.draftCues.splice(Number(delCue.dataset.cueDel), 1);
    await renderManage();
    return;
  }

  const act = e.target.closest('[data-active]');
  if (act) {
    const [kind, id, active] = act.dataset.active.split(':');
    const r = await mapi('/api/entry/active', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind, id: Number(id), active: active === '1' }) });
    notice(r.ok ? (active === '1' ? '다시 사용하도록 켰습니다.' : '껐습니다. 기록은 남고 선곡에서만 빠집니다.') : r.error, !r.ok);
    await loadLists(); await renderManage();
    if (typeof loadOverview === 'function') loadOverview().catch(() => {});
    return;
  }

  const edit = e.target.closest('[data-edit]');
  if (edit) {
    const [kind, id] = edit.dataset.edit.split(':');
    const L = mstate.lists;
    const src = { channel: L.channels, video: L.videos, track: L.tracks, candidate: L.candidates }[kind];
    mstate.edit[kind] = src.find((x) => String(x.id) === id);
    if (kind === 'candidate') mstate.draftCues = [...(mstate.edit.candidate.watch_cues ?? [])];
    mstate.step = kind;
    await renderManage();
    return;
  }

  const prev = e.target.closest('[data-preview]');
  if (prev) { await refreshPreview(Number(prev.dataset.preview)); return; }

  const perm = e.target.closest('[data-perm]');
  if (perm) {
    const [assetId, cat] = perm.dataset.perm.split(':');
    const cand = mstate.lists.candidates.find((c) => c.clip_assets.some((a) => String(a.id) === assetId));
    const asset = cand?.clip_assets.find((a) => String(a.id) === assetId);
    const existing = asset?.permissions.find((p) => p.rights_category === cat);
    const slot = document.querySelector(`[data-perm-slot="${assetId}"]`);
    if (slot) slot.innerHTML = permForm(assetId, cat, mstate.lists, existing);
    return;
  }
  const close = e.target.closest('[data-perm-close]');
  if (close) { close.closest('.perm-slot').innerHTML = ''; return; }

  const cancel = e.target.closest('[data-cancel]');
  if (cancel) { mstate.edit = {}; mstate.upload = {}; mstate.draftCues = []; await renderManage(); }
});

/** `1:23` or `83` → seconds. Mirrors parseTimecode() on the server; null when it cannot be read. */
function toSeconds(v) {
  const s = String(v ?? '').trim();
  if (s === '') return null;
  if (/^\d+$/.test(s)) return Number(s);
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})$/.exec(s);
  if (!m || Number(m[2]) > 59 || Number(m[3]) > 59) return null;
  return (Number(m[1] ?? 0) * 3600) + (Number(m[2]) * 60) + Number(m[3]);
}
const mmssOf = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;

document.addEventListener('change', async (e) => {
  if (e.target.id === 'clipCand') { mstate.edit.clipCandidateId = Number(e.target.value); await renderManage(); return; }
  // Typing only a start time fills the end in, so the usual case needs one number instead of two.
  if (e.target.name === 'source_start_sec') {
    const form = e.target.closest('form');
    const end = form?.elements.source_end_sec;
    const start = toSeconds(e.target.value);
    if (end && start != null && String(end.value).trim() === '') {
      const span = Math.min(mstate.lists.clipSeconds?.default ?? 25, mstate.lists.clipSeconds?.max ?? 30);
      end.value = mmssOf(start + span);
    }
    return;
  }
  // Ticking "개인 확인용" says the rights below will not be filled in, so they stop looking like a to-do.
  if (e.target.name === 'personal_use_only') {
    $('#clipRights')?.classList.toggle('dimmed', e.target.checked);
    const hint = $('#personalHint');
    if (hint) hint.hidden = !e.target.checked;
    return;
  }
  if (e.target.id === 'clipFile' && e.target.files[0]) {
    const state = $('#clipUpState');
    state.textContent = '올리는 중…';
    try {
      const j = await uploadFile('clip', e.target.files[0]);
      mstate.upload.clip = j.file_ref;
      state.textContent = `올림 완료: ${j.file_ref} (${Math.round(j.bytes / 1048576)}MB)`;
      e.target.closest('form').elements.file_ref.value = j.file_ref;
    } catch (err) { state.textContent = err.message; notice(err.message, true); }
    return;
  }
  if (e.target.matches('[data-ev-file]') && e.target.files[0]) {
    const form = e.target.closest('form');
    const state = form.querySelector('[data-ev-state]');
    state.textContent = '올리는 중…';
    try {
      const j = await uploadFile('evidence', e.target.files[0]);
      form.elements.evidence_ref.value = j.evidence_ref;
      state.textContent = `보관했습니다 — ${TERMS.evidence(j.evidence_ref)} (문서 자체는 내 컴퓨터에만 남고, 프로그램에는 이 이름만 적힙니다)`;
    } catch (err) { state.textContent = err.message; notice(err.message, true); }
  }
});

document.addEventListener('submit', async (e) => {
  const form = e.target.closest('form.entry');
  if (!form) return;
  e.preventDefault();
  const btn = form.querySelector('button[type="submit"]');
  const was = btn.textContent;
  btn.disabled = true; btn.textContent = '저장 중…';
  try { await submitEntry(form); } catch (err) { notice(err.message, true); } finally { btn.disabled = false; btn.textContent = was; }
});
