'use strict';
/**
 * The operating screen: what went out today, in what form, and why.
 *
 * Written for someone who does not read code. Two rules follow from that:
 *  - Anything the program produced for itself — a status value, a key, a template name — is shown
 *    through TERMS, never raw. The identifier stays visible but small, because when something goes
 *    wrong the operator has to be able to read it out.
 *  - Only what is needed every day is open. The evidence behind a verdict is one click away in a
 *    <details>, not gone.
 *
 * What the account publishes (title, caption, hashtags, text inside the video) is never translated.
 */
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ACC = { cover: '#2EC4B6', band: '#FF5A3C', acoustic: '#F2B134', piano: '#F2B134', unplugged: '#F2B134', orchestra: '#9B7BFF', jazz: '#6FA8FF', live: '#E8E8EE' };

const ko = (kind, v) => TERMS.ko(kind, v);
const mmss = (v) => TERMS.mmss(v);
/** The identifier is kept, but it stops competing with the name a person actually reads. */
const idTag = (v) => (v ? `<div class="k">${esc(v)}</div>` : '');
const songOf = (s) => [s.performer_en, s.song_title_en ?? s.song_title_ko].filter(Boolean).join(' – ') || s.title_en || '—';
const size = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);

let state = { overview: null, current: null, links: new Map() };

async function api(path, opts) {
  const r = await fetch(path, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    // A refusal carries a per-field Korean reason (issues[].ko) that says what to fix. Throwing only
    // the English message threw that away, so it travels on the error and the caller decides.
    const err = new Error(j.error || r.statusText);
    err.issues = j.issues ?? null;
    err.error_ko = j.error_ko ?? null; // a refusal that is about the whole request, not one field
    err.code = j.code ?? null;
    throw err;
  }
  return j;
}

function notice(msg, err = false) {
  const n = $('#notice');
  if (!msg) { n.hidden = true; return; }
  n.hidden = false; n.className = 'notice' + (err ? ' err' : ''); n.textContent = msg;
}

/** Shown before anything exists, and whenever a day has nothing to show: always names the next action. */
function emptyState() {
  const hasData = (state.overview?.selections ?? []).length;
  return `<section class="empty">
    <h1>${hasData ? '왼쪽에서 날짜를 고르세요' : '아직 등록된 후보가 없습니다'}</h1>
    <p>${hasData
      ? '왼쪽 <b>운영 기록</b>에서 날짜를 누르면 그날 무엇이 뽑혔고 왜 그렇게 됐는지 볼 수 있습니다.'
      : '위 <b>1. 영상 고르기</b>에 유튜브 주소를 붙여넣고 시작하세요. 이미 등록한 자료를 고치려면 왼쪽 <b>자료 손보기</b>를 여세요.'}</p>
    ${hasData ? '' : '<p class="small muted">왼쪽 <b>운영 기록</b>의 시나리오 날짜를 누르면 예시 데이터로 전체 흐름을 먼저 볼 수도 있습니다.</p>'}
  </section>`;
}

async function loadOverview() {
  const o = await api('/api/overview');
  state.overview = o;
  // official_url and platform_video_id already ride along here; the comparison snapshot does not
  // carry them, so they are joined on by candidate id rather than re-stored.
  try { state.links = new Map((await api('/api/candidates')).map((c) => [c.id, c])); } catch { state.links = new Map(); }
  $('#brandName').textContent = o.account.displayName;
  $('#brandConcept').textContent = `${o.account.concept} · ${o.account.handle}`;
  if (!$('#runDate').value) $('#runDate').value = Object.keys(o.scenarioDates)[0] ?? o.today;
  $('#scenarios').innerHTML = Object.entries(o.scenarioDates).map(([d, t]) =>
    `<button class="chip" data-date="${d}"><b>${d}</b>${esc(t)}</button>`).join('');
  const list = $('#dayList');
  list.innerHTML = o.selections.length ? o.selections.map((s) => {
    const rev = TERMS.revision(s.revision);
    return `<li><button data-date="${s.operating_date}" class="${state.current === s.operating_date ? 'active' : ''}">
      <span class="d">${s.operating_date}${rev ? ` · ${rev}` : ''}</span>
      <span>${s.status === 'skipped' ? '<span class="badge">건너뜀</span>'
        : `<span class="badge ${s.output_format === 'licensed_clip' ? 'info' : 'warn'}">${ko('format', s.output_format)}</span> <span class="badge">${s.score}점</span>`}</span>
      <span class="t">${esc(s.status === 'skipped' ? '올릴 후보 없음' : songOf(s))}</span>
    </button></li>`;
  }).join('') : '<li class="muted">아직 실행 기록이 없습니다.</li>';
  const sn = $('#serverNote');
  sn.hidden = !o.expressFallback;
  sn.textContent = 'ⓘ Express 미설치 — 내장 호환 서버로 실행 중입니다. `npm install` 후 다시 시작하면 Express로 동작합니다.';
}

async function run(date, reselect = false) {
  const btn = $('#runBtn');
  btn.disabled = true; btn.textContent = '실행 중…';
  try {
    const r = await api('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date, reselect }) });
    notice(r.selectionReused
      ? `${date}: 이미 실행한 날짜라 기존 결과를 그대로 씁니다${r.rendered ? ' (실패했던 영상 제작만 이어서 처리했습니다)' : ''}. 새 기록은 만들지 않았습니다.`
      : `${date}: ${reselect ? '다시 골랐습니다.' : '실행을 마쳤습니다.'}`);
    state.current = date;
    await loadOverview();
    await showDay(date);
  } catch (e) {
    notice(`${date}: ${e.message}`, true);
  } finally {
    btn.disabled = false; btn.textContent = '오늘의 추천 받기';
    $('#reselect').checked = false;
  }
}

/** True when the clip this day was built from is the operator's own file with no rights behind it. */
function personalClip(d) {
  const picked = (d.snapshot ?? []).find((x) => x.candidate_id === d.selection?.candidate_id);
  const key = picked?.clip?.usable_asset_key;
  return Boolean(key && picked.clip.assets.find((a) => a.asset_key === key)?.personalUseOnly);
}

function flowSteps(d) {
  const s = d.selection;
  const job = d.jobs?.[0];
  if (s.status === 'skipped') {
    return [['후보 확인', 'ok', `${d.snapshot.length}건 검토`], ['자동 선곡', 'bad', '올릴 후보 없음'], ['권리 판정', 'skip', '-'],
      ['영어 문구', 'skip', '-'], ['세로 영상', 'skip', '-'], ['예약', 'skip', '올리지 않음']];
  }
  const elig = d.snapshot.filter((x) => x.eligible).length;
  return [
    ['후보 확인', 'ok', `${d.snapshot.length}건 중 ${elig}건 적격`],
    ['자동 선곡', 'ok', `${d.candidate.performer_en} · ${s.score}점`],
    personalClip(d)
      ? ['권리 판정', 'bad', '권리 미확인 · 개인 확인용']
      : ['권리 판정', d.reel?.output_format === 'licensed_clip' ? 'ok' : 'warn', ko('format', d.reel?.output_format) || '-'],
    ['영어 문구', 'ok', '정해진 틀로 생성'],
    ['세로 영상', d.reel?.render_status === 'done' ? 'ok' : 'bad', ko('renderStatus', d.reel?.render_status) || '-'],
    ['예약', job ? (job.status === 'simulated' ? 'ok' : 'bad') : 'skip', job ? ko('jobStatus', job.status) : '-'],
  ];
}

function scoreHtml(items) {
  return `<div class="score">${items.map((i) => `
    <div class="row"><span>${esc(ko('score', i.key))}</span><span class="bar"><i style="width:${(i.points / i.max) * 100}%"></i></span><b>${i.points}/${i.max}</b></div>
    <div class="row"><span></span><span class="why">${esc(i.reason_ko ?? i.reason)}</span></div>`).join('')}</div>`;
}

/**
 * The original video, as something to look at.
 *
 * Recommending a performance without a way to watch it asks the operator to trust the ranking. The
 * link and the thumbnail both come from what is already stored — the thumbnail is YouTube's own
 * address, never a downloaded copy — and a thumbnail that fails to load removes itself rather than
 * leaving a broken icon.
 */
function videoLink(candidateId, { thumb = true } = {}) {
  const c = state.links?.get(candidateId);
  if (!c?.official_url) return '';
  const img = thumb && c.platform_video_id
    ? `<img class="ythumb" loading="lazy" alt="" src="https://i.ytimg.com/vi/${encodeURIComponent(c.platform_video_id)}/hqdefault.jpg" onerror="this.remove()">`
    : '';
  return `<a class="ylink" href="${esc(c.official_url)}" target="_blank" rel="noopener noreferrer">${img}<span>영상 보기 ↗</span></a>`;
}

function candTable(d) {
  const pickedId = d.selection.candidate_id;
  const rows = [...d.snapshot].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
  return `<thead><tr><th>순위</th><th>영상</th><th>후보</th><th>버전</th><th>점수</th><th>클립</th></tr></thead><tbody>${rows.map((c) => {
    const tags = [c.performance_type, ...(c.arrangement_tags ?? [])].filter(Boolean).map((t) => ko('tag', t)).join(' · ');
    const clip = !c.clip ? '<span class="muted">-</span>'
      : c.clip.usable_asset_key ? '<span class="badge ok">쓸 수 있음</span>'
      : c.clip.assets.length ? `<span class="badge bad">쓸 수 없음</span><ul>${c.clip.assets.map((a) =>
        `<li>${esc((a.reasons_ko ?? a.reasons)[0] ?? '')}${a.reasons.length > 1 ? ` 외 ${a.reasons.length - 1}건` : ''}</li>`).join('')}</ul>`
      : '<span class="muted">등록된 클립 없음</span>';
    return `<tr class="${c.candidate_id === pickedId ? 'picked' : ''}">
      <td>${c.rank ?? '<span class="badge">제외</span>'}</td>
      <td>${videoLink(c.candidate_id) || '<span class="muted">-</span>'}</td>
      <td><b>${esc(c.performer_en ?? '공연자 미입력')}</b> – ${esc(c.title_en ?? c.title_ko ?? '곡 미연결')}${idTag(c.candidate_key)}
        ${c.eligible ? '' : `<ul>${c.exclusions.map((x) => `<li>${esc(x.text_ko ?? x.text)}</li>`).join('')}</ul>`}</td>
      <td>${esc(tags)}</td>
      <td>${c.score ? `<b>${c.score.total}</b>` : '-'}</td>
      <td>${clip}</td></tr>`;
  }).join('')}</tbody>`;
}

function rightsCard(d) {
  const picked = d.snapshot.find((x) => x.candidate_id === d.selection.candidate_id);
  const assets = picked?.clip?.assets ?? [];
  const head = `<h3>이번 형식과 그 이유</h3>
    <p><span class="badge ${d.reel.output_format === 'licensed_clip' ? 'info' : 'warn'}">${ko('format', d.reel.output_format)}</span></p>
    <p class="reason">${esc(d.reel.format_reason_ko ?? d.reel.format_reason)}</p>`;
  if (!assets.length) {
    return head + '<p class="muted small">이 후보에는 등록된 클립 파일이 없습니다. 공식 링크를 찾은 것만으로는 파일을 확보했거나 이용 허락을 받은 것으로 보지 않습니다.</p>';
  }
  return head + assets.map((a) => `<details class="asset" ${a.eligible ? '' : 'open'}>
    <summary>${a.personalUseOnly ? '<span class="badge bad">권리 미확인 · 개인 확인용</span>'
      : a.eligible ? '<span class="badge ok">권리 확보</span>' : '<span class="badge bad">권리 미비</span>'}
      ${a.personalUseOnly || !a.testOnly ? '' : '<span class="badge warn">테스트 소재 · 실제 게시 불가</span>'}
      <span class="k">${esc(a.asset_key)}</span></summary>
    <ul class="checks">${a.checks.map((c) => `<li class="${c.testOnly ? 'test' : c.ok ? '' : 'no'}">${esc(c.label_ko ?? c.label)}</li>`).join('')}</ul></details>`).join('');
}

function segCard(d) {
  const sug = d.suggestions ?? [];
  const head = '<h3>클립 구간 추천 <span class="muted small">승인하기 전에는 아무것도 바뀌지 않습니다</span></h3>';
  if (!sug.length) {
    return `${head}<p class="muted small">이 후보의 클립에 대한 추천이 없습니다. 권리 정보(허락 구간)를 먼저 채우거나, 곡 구조 분석을 돌려야 추천이 생깁니다.</p>`;
  }
  return head + sug.map((s) => `<div class="asset">
    <h4><span class="badge ${s.status === 'approved' ? 'ok' : s.status === 'proposed' ? 'info' : ''}">${esc(ko('suggestionStatus', s.status))}</span>
      ${s.analyzer === 'fixture' ? '<span class="badge warn">예시 데이터(실제 분석 아님)</span>' : `<span class="badge">${esc(ko('analyzer', s.analyzer))}</span>`}
      <span class="k">${esc(s.asset_key)}</span></h4>
    <dl class="kv">
      <dt>추천 구간</dt><dd><b>${esc(ko('section', s.label))}</b> ${mmss(s.suggested_start_sec)}–${mmss(s.suggested_end_sec)}
        (${(s.suggested_end_sec - s.suggested_start_sec).toFixed(1)}초)${s.bpm ? ` · 빠르기(BPM) ${s.bpm}` : ''}</dd>
      <dt>지금 쓰는 구간</dt><dd>${mmss(s.current_start_sec)}–${mmss(s.current_end_sec)}</dd>
      <dt>근거</dt><dd class="small">${esc(s.notes)}</dd>
    </dl>
    ${s.status === 'proposed' ? `<div class="actions"><button class="btn" data-approve="${s.id}">이 구간으로 바꾸고 다시 만들기</button><button class="btn ghost" data-reject="${s.id}">그대로 두기</button></div>` : ''}
  </div>`).join('') + '<p class="small muted">자동 분석으로 찾은 구간은 공식 타임스탬프가 아니므로 캡션의 ▶ 시점 표시에는 쓰지 않습니다.</p>';
}

/**
 * The one thing the operator checks on every post: that the official source is in the caption, and
 * which address it is. Shown in the open, not behind a <details>, and never only as a tick mark.
 */
function officialSourceLine(d) {
  const url = d.reel?.official_link;
  if (!url || !/^https?:\/\//.test(url)) {
    return '<p class="reason"><span class="badge bad">공식 출처 링크 없음</span> 캡션이 원본을 가리킬 수 없습니다.</p>';
  }
  return `<p class="reason"><span class="badge ok">공식 출처 링크 있음</span>
    <a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a></p>`;
}

function jobCard(d) {
  const job = d.jobs?.[0];
  if (!job) {
    return `<h3>다음에 할 일</h3><p>영상 제작이 끝나지 않아 예약을 만들지 않았습니다. <b>같은 날짜로 다시 실행</b>하면 이어서 처리합니다.</p>
      ${officialSourceLine(d)}
      ${d.reel.render_error ? `<details><summary class="small muted">실패 내용 보기</summary><p class="reason">${esc(d.reel.render_error)}</p></details>` : ''}`;
  }
  const p = job.plan ?? {};
  return `<h3>다음에 할 일 <span class="badge ${job.status === 'simulated' ? 'ok' : 'bad'}">${esc(ko('jobStatus', job.status))}</span></h3>
    <p class="reason">${esc(job.expected_status_ko ?? job.expected_status)}</p>
    <dl class="kv">
      <dt>올릴 시각</dt><dd>${esc(p.scheduled_local ?? '')}</dd>
      <dt>올리는 방식</dt><dd>${esc(ko('mode', job.mode))} — 실제로 올라가지 않습니다</dd>
    </dl>
    ${officialSourceLine(d)}
    <details><summary class="small muted">예행 연습 점검 내역 보기</summary>
      <ul class="checks">${(p.checks ?? []).map((c) => `<li class="${c.ok ? '' : 'no'}">${esc(c.label_ko ?? c.label)}</li>`).join('')}</ul>
      <h4 class="small muted" style="margin:14px 0 6px">실제로 올릴 때 확인할 것</h4>
      <ul class="checks">${(p.live_readiness ?? []).map((c) => `<li class="test">${esc(c.ko ?? c.en ?? c)}</li>`).join('')}</ul>
      <dl class="kv" style="margin-top:12px">
        <dt>영상 파일</dt><dd class="k">${esc(p.file ?? '')}</dd>
        <dt>예약 시각(UTC)</dt><dd class="k">${esc(job.scheduled_at)}</dd>
        <dt>외부 게시물 ID</dt><dd class="muted">없음 — 예행 연습은 ID나 조회수를 만들지 않습니다</dd>
      </dl></details>`;
}

function mockHtml(d) {
  const c = d.candidate;
  const key = c.performance_type === 'cover' ? 'cover' : (c.arrangement_tags.find((t) => ACC[t]) ?? 'live');
  const lines = d.reel.caption.split('\n');
  const label = (lines[0].match(/\(([^)]+)\)\s*$/) || [])[1] ?? '';
  const why = (lines.find((l) => l.startsWith('Why watch: ')) ?? '').replace('Why watch: ', '');
  const ts = (lines.find((l) => l.startsWith('▶')) ?? '').replace('▶ The song starts at ', 'Song starts at ').replace('.', '');
  return `<div class="mock" style="--acc:${ACC[key]}">
    <div class="hd"><span>${esc(state.overview.account.displayName)}</span><span>LIVE VERSIONS &amp; COVERS</span></div>
    <span class="tag">${esc(label.toUpperCase())}</span>
    <div class="hl">${esc(d.reel.title_en)}</div>
    <div class="pl">${esc(c.performer_en)} – ${esc(c.title_en)}</div>
    ${c.performer_ko || c.title_ko ? `<div class="ko">${esc(c.performer_ko ?? '')} – ${esc(c.title_ko ?? '')}</div>` : ''}
    <div class="wl">WHY THIS VERSION</div><div class="wy">${esc(why)}</div>
    ${ts ? `<div class="ts">▶ ${esc(ts)}</div>` : ''}
    <div class="ft">${esc(c.program_name ?? '')} · Full official video in caption</div></div>`;
}

const CROP_STEPS = [
  { v: 0, label: '왼쪽' }, { v: 0.25, label: '왼쪽 조금' }, { v: 0.5, label: '가운데' },
  { v: 0.75, label: '오른쪽 조금' }, { v: 1, label: '오른쪽' },
];
const CROPY_STEPS = [
  { v: 0, label: '위' }, { v: 0.25, label: '위쪽' }, { v: 0.5, label: '가운데' },
  { v: 0.75, label: '아래쪽' }, { v: 1, label: '아래' },
];
const nearestStep = (steps, v) => steps.reduce((a, s) => (Math.abs(s.v - v) < Math.abs(a.v - v) ? s : a), steps[2]);

/**
 * How much of the frame the video takes, and which part of a wide shot is kept.
 *
 * Rendering takes tens of seconds, so nothing happens until the operator presses the button — moving
 * the slider only changes what would be rendered. The slider is hidden for a template that does not
 * crop, because there would be nothing for it to do.
 */
function shapeCard(d) {
  const r = d.reel;
  const all = (state.overview?.templates ?? []).filter((t) => t.format === r.output_format);
  if (all.length < 2) return '';
  const current = r.template_id ?? all[0].id;
  const sel = all.find((t) => t.id === current) ?? all[0];
  const zoom = r.zoom == null ? 1 : Number(r.zoom);
  const nx = nearestStep(CROP_STEPS, r.crop_x == null ? 0.5 : Number(r.crop_x));
  const ny = nearestStep(CROPY_STEPS, r.crop_y == null ? 0.5 : Number(r.crop_y));

  return `<div class="shape" id="shapeCard" data-reel="${r.id}">
    <h4 class="small muted" style="margin:16px 0 8px">영상 모양</h4>
    <div class="tabs shapes">${all.map((t) => `<button data-shape="${t.id}" class="${t.id === current ? 'on' : ''}" title="${esc(t.description ?? '')}">${esc(t.name ?? ko('template', t.id) ?? t.id)}</button>`).join('')}</div>
    <p class="small muted" id="shapeDesc">${esc(sel.description ?? '')}</p>

    <div class="fld inline" id="zoomRow" ${sel.crops ? '' : 'hidden'}>
      <label for="zoomX">확대 <span class="muted" id="zoomLabel">${zoom.toFixed(1)}배</span></label>
      <input type="range" id="zoomX" min="10" max="25" step="1" value="${Math.round(zoom * 10)}">
    </div>
    <div class="fld inline" id="cropRow" ${sel.crops ? '' : 'hidden'}>
      <label for="cropX">좌우 <span class="muted" id="cropLabel">${esc(nx.label)}</span></label>
      <input type="range" id="cropX" min="0" max="4" step="1" value="${CROP_STEPS.indexOf(nx)}">
    </div>
    <div class="fld inline" id="cropYRow" ${sel.crops && zoom > 1 ? '' : 'hidden'}>
      <label for="cropY">위아래 <span class="muted" id="cropYLabel">${esc(ny.label)}</span></label>
      <input type="range" id="cropY" min="0" max="4" step="1" value="${CROPY_STEPS.indexOf(ny)}">
      <span class="fhelp">확대했을 때만 쓸 수 있습니다.</span>
    </div>

    <div class="cropPreview" id="cropPreview" ${sel.crops ? '' : 'hidden'}>
      <img id="cropImg" alt="미리보기">
      <p class="small muted">슬라이더를 움직이면 여기 그림만 바뀝니다. 영상은 아래 버튼을 눌러야 만들어집니다.</p>
    </div>

    <div class="actions"><button class="btn" id="reshapeBtn">이 모양으로 영상 만들기</button></div>
    <div class="upstate" id="shapeState"></div></div>`;
}

/**
 * Aiming the crop. Moving a slider redraws one still frame and nothing else — the full render takes
 * tens of seconds, so it happens only when the button is pressed.
 */
function wireShape(d) {
  const card = $('#shapeCard');
  if (!card) return;
  const all = (state.overview?.templates ?? []).filter((t) => t.format === d.reel.output_format);
  let chosen = d.reel.template_id ?? all[0]?.id;
  const crops = () => Boolean(all.find((t) => t.id === chosen)?.crops);
  const framing = () => ({
    zoom: Number($('#zoomX')?.value ?? 10) / 10,
    cropX: CROP_STEPS[Number($('#cropX')?.value ?? 2)].v,
    cropY: CROPY_STEPS[Number($('#cropY')?.value ?? 2)].v,
  });

  // The slider fires on every pixel of travel; only the last position in 150ms is worth a frame.
  let timer = null, seq = 0;
  const refreshPreview = () => {
    if (!crops()) { $('#cropPreview').hidden = true; return; }
    $('#cropPreview').hidden = false;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const mine = ++seq;
      const f = framing();
      const q = `template=${encodeURIComponent(chosen)}&cropX=${f.cropX}&cropY=${f.cropY}&zoom=${f.zoom}`;
      try {
        const r = await fetch(`/api/reel/${d.reel.id}/crop-preview?${q}`);
        if (!r.ok || mine !== seq) return;          // a newer move already won
        const blob = await r.blob();
        if (mine !== seq) return;
        const img = $('#cropImg');
        if (img.dataset.url) URL.revokeObjectURL(img.dataset.url);
        img.dataset.url = URL.createObjectURL(blob);
        img.src = img.dataset.url;
      } catch { /* a preview that fails to load is not worth interrupting the operator for */ }
    }, 150);
  };

  card.querySelectorAll('[data-shape]').forEach((b) => b.addEventListener('click', () => {
    chosen = b.dataset.shape;
    card.querySelectorAll('[data-shape]').forEach((x) => x.classList.toggle('on', x === b));
    const t = all.find((x) => x.id === chosen);
    $('#shapeDesc').textContent = t?.description ?? '';
    for (const id of ['#zoomRow', '#cropRow']) $(id).hidden = !t?.crops;
    $('#cropYRow').hidden = !t?.crops || framing().zoom <= 1;
    refreshPreview();
  }));

  const onSlide = (id, labelId, steps) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener('input', () => {
      if (steps) $(labelId).textContent = steps[Number(el.value)].label;
      else {
        $(labelId).textContent = `${(Number(el.value) / 10).toFixed(1)}배`;
        $('#cropYRow').hidden = !crops() || Number(el.value) <= 10;   // up/down only matters when zoomed
      }
      refreshPreview();
    });
  };
  onSlide('#zoomX', '#zoomLabel', null);
  onSlide('#cropX', '#cropLabel', CROP_STEPS);
  onSlide('#cropY', '#cropYLabel', CROPY_STEPS);
  refreshPreview();

  $('#reshapeBtn').addEventListener('click', async () => {
    const btn = $('#reshapeBtn');
    const was = btn.textContent;
    btn.disabled = true; btn.textContent = '영상을 다시 만들고 있습니다…';
    $('#shapeState').classList.remove('err');
    $('#shapeState').textContent = '수십 초 걸립니다. 이 창을 그대로 두세요.';
    try {
      const r = await api(`/api/reel/${d.reel.id}/template`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ template_id: chosen, ...framing() }),
      });
      if (r.render_status !== 'done') throw new Error(r.render_error || `영상 제작이 ${ko('renderStatus', r.render_status)} 상태입니다`);
      notice(`${ko('template', r.template_id) || r.template_id} 모양으로 다시 만들었습니다. 같은 릴스 #${r.reel_id}이고, 다시 고르지 않았습니다.`);
      await loadOverview();
      await showDay(d.selection.operating_date);
    } catch (e) {
      // Same reason as the save button in create.js: this button is in the middle of a long page and
      // #notice is at the top of it, so clearing the line here read as "nothing happened".
      $('#shapeState').textContent = `다시 만들지 못했습니다: ${e.message}`;
      $('#shapeState').classList.add('err');
      notice(`다시 만들지 못했습니다: ${e.message}`, true);
      btn.disabled = false; btn.textContent = was;
    }
  });
}

function previewCard(d) {
  const r = d.reel;
  const hasVideo = r.render_status === 'done' && r.video_url;
  return `<h3>완성된 세로 영상</h3>
    <div class="tabs"><button data-tab="mp4" class="${hasVideo ? 'on' : ''}" ${hasVideo ? '' : 'disabled'}>완성본</button><button data-tab="html" class="${hasVideo ? '' : 'on'}">구성 미리보기</button></div>
    <div class="phone" id="phone">${hasVideo ? `<video src="${r.video_url}" poster="${r.poster_url}" controls loop playsinline></video>` : mockHtml(d)}</div>
    <p class="small muted">${hasVideo ? '이 영상이 그대로 올라갑니다.' : `아직 영상이 없습니다 (${esc(ko('renderStatus', r.render_status))}) — 구성만 보여 줍니다.`}</p>
    ${shapeCard(d)}
    <div class="actions"><button class="btn" id="exportBtn" data-reel="${r.id}" ${hasVideo ? '' : 'disabled'}>영상 내보내기</button></div>
    <p class="small muted">${hasVideo
      ? '영상·첫 화면·캡션·설명을 이 릴스만의 폴더에 모아 둡니다. 다른 릴스를 내보낸 폴더는 지워지지 않습니다.'
      : `영상이 완성되지 않아 내보낼 수 없습니다 (${esc(ko('renderStatus', r.render_status))}). 같은 날짜를 다시 실행하면 이어서 만듭니다.`}</p>
    <div class="upstate paths" id="exportResult"></div>
    <details><summary class="small muted">제작 정보</summary><dl class="kv">
      <dt>디자인 틀</dt><dd>${esc(ko('template', r.template_id) || '-')}</dd>
      <dt>파일</dt><dd class="k">${esc(r.output_path ?? '없음')}</dd></dl></details>`;
}

function captionCard(d) {
  return `<h3>인스타그램에 올릴 글</h3>
    <p class="small muted">아래 글은 <b>영어 그대로</b> 올라갑니다. 해외 팬이 보는 계정이라 번역하지 않습니다.</p>
    <p class="small muted" style="margin-top:10px">첫 화면에 크게 뜨는 제목</p><p><b>${esc(d.reel.title_en)}</b></p>
    <div class="caption" id="captionText">${esc(d.reel.caption)}</div>
    <div class="actions"><button class="btn" id="copyCaption">글 복사하기</button>
      <a class="btn ghost" href="${esc(d.reel.official_link)}" target="_blank" rel="noopener noreferrer">공식 원본 ↗</a>
      <a class="btn ghost" href="${esc(d.reel.guide_page_path)}" target="_blank">원본 안내 페이지 ↗</a></div>`;
}

async function showDay(date) {
  state.current = date;
  document.querySelectorAll('#dayList button').forEach((b) => b.classList.toggle('active', b.dataset.date === date));
  let d;
  try { d = await api(`/api/day/${date}`); } catch (e) {
    $('#detail').innerHTML = `<section class="empty"><h1>${date}</h1>
      <p>이 날짜는 아직 실행하지 않았습니다. 왼쪽 <b>운영 기록</b>에서 날짜를 ${date}로 맞추고 <b>오늘의 추천 받기</b>를 누르면 선곡부터 영상까지 한 번에 진행됩니다.</p></section>`;
    return;
  }
  const root = $('#detail');
  root.innerHTML = '';
  root.append($('#tplDay').content.cloneNode(true));
  const ref = (n) => root.querySelector(`[data-ref="${n}"]`);
  ref('flow').innerHTML = flowSteps(d).map(([t, cls, v]) => `<div class="step ${cls}"><b>${t}</b>${esc(v)}</div>`).join('');
  // Comparison and score moved to the left: they are the record of why, not something to read daily.
  const sideCands = $('#sideCands');
  if (sideCands) sideCands.innerHTML = `<div class="table-wrap"><table class="cands">${candTable(d)}</table></div>`;
  $('#ruleVer').textContent = `· 선곡 규칙 ${d.selection.rule_version}`;
  const s = d.selection;

  if (s.status === 'skipped') {
    ref('selCard').innerHTML = `<h3>${date} · 올리지 않습니다</h3>
      <div class="skipbox">${esc(s.skip_reason_ko ?? s.skip_reason)}</div>`;
    ['rightsCard', 'segCard', 'jobCard', 'previewCard', 'captionCard'].forEach((n) => ref(n).remove());
    root.querySelector('.cols').style.gridTemplateColumns = '1fr';
    return;
  }

  const rev = TERMS.revision(s.revision);
  ref('selCard').innerHTML = `<h3>${date} · 오늘 올릴 것 <span class="badge ok">${s.score}/100점</span> ${rev ? `<span class="badge info">${rev}</span>` : ''}</h3>
    <p style="margin:0"><b style="font-size:17px">${esc(d.candidate.performer_en)} – ${esc(d.candidate.title_en)}</b>
      <span class="muted">${esc(d.candidate.performer_ko ?? '')} ${d.candidate.title_ko ? `– ${esc(d.candidate.title_ko)}` : ''}</span></p>
    <p class="small muted" style="margin:4px 0 0">${esc(d.candidate.program_name ?? '')} · 공식 공개 ${esc(TERMS.day(d.candidate.published_at))}</p>
    ${videoLink(d.candidate.id)}
    <div class="reason">${esc(s.reason_ko ?? s.reason)}</div>
    <details style="margin-top:10px"><summary class="small muted">점수를 어떻게 매겼는지 보기</summary>${scoreHtml(s.score_breakdown.items)}
      <p class="small muted" style="margin-top:8px">선곡 규칙 ${esc(s.rule_version)} · 후보 식별자 ${esc(d.candidate.candidate_key)}</p></details>`;
  ref('rightsCard').innerHTML = rightsCard(d);
  ref('segCard').innerHTML = segCard(d);
  root.querySelectorAll('[data-approve],[data-reject]').forEach((b) => b.addEventListener('click', async () => {
    const id = b.dataset.approve ?? b.dataset.reject;
    const act = b.dataset.approve ? 'approve' : 'reject';
    b.disabled = true; b.textContent = act === 'approve' ? '다시 만드는 중…' : '처리 중…';
    try {
      const r = await api(`/api/suggestions/${id}/${act}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      notice(act === 'approve'
        ? `구간을 바꾸고 영상을 다시 만들었습니다. 다시 만든 날짜: ${r.rerunDates.join(', ') || '없음 (이 클립을 쓰는 릴스가 아직 없습니다)'}`
        : '추천을 쓰지 않기로 했습니다. 구간은 그대로입니다.');
      await loadOverview(); await showDay(date);
    } catch (e) { notice(e.message, true); }
  }));
  ref('jobCard').innerHTML = jobCard(d);
  ref('previewCard').innerHTML = previewCard(d);
  ref('captionCard').innerHTML = captionCard(d);
  root.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => {
    root.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('on', x === b));
    $('#phone').innerHTML = b.dataset.tab === 'mp4' ? `<video src="${d.reel.video_url}" poster="${d.reel.poster_url}" controls loop playsinline></video>` : mockHtml(d);
  }));
  wireShape(d);
  const exportBtn = $('#exportBtn');
  if (exportBtn && !exportBtn.disabled) {
    exportBtn.addEventListener('click', async () => {
      const was = exportBtn.textContent;
      exportBtn.disabled = true; exportBtn.textContent = '내보내는 중…';
      try {
        const r = await api('/api/export', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reelId: Number(exportBtn.dataset.reel) }),
        });
        // The path is the point of the button, so it is shown verbatim and left on screen to copy.
        $('#exportResult').classList.remove('err');
        $('#exportResult').textContent = `${r.dir}\n${r.files.map((f) => `  ${f.name}  ${size(f.bytes)}`).join('\n')}`;
        notice('내보냈습니다. 아래 경로를 복사해 탐색기 주소창에 붙여 넣으면 폴더가 열립니다.');
      } catch (e) {
        // The last button on the page: its failure must not be reported only at the top of the page.
        $('#exportResult').textContent = `내보내지 못했습니다: ${e.message}`;
        $('#exportResult').classList.add('err');
        notice(`내보내지 못했습니다: ${e.message}`, true);
      } finally {
        exportBtn.disabled = false; exportBtn.textContent = was;
      }
    });
  }
  $('#copyCaption').addEventListener('click', async (e) => {
    try { await navigator.clipboard.writeText(d.reel.caption); e.target.textContent = '복사했습니다 ✓'; }
    catch { const r = document.createRange(); r.selectNodeContents($('#captionText')); getSelection().removeAllRanges(); getSelection().addRange(r); e.target.textContent = '선택됨 — Ctrl+C 를 누르세요'; }
  });
}

document.addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (chip) { $('#runDate').value = chip.dataset.date; run(chip.dataset.date); return; }
  const day = e.target.closest('#dayList button');
  if (day) showDay(day.dataset.date);
});
$('#runForm').addEventListener('submit', (e) => { e.preventDefault(); run($('#runDate').value, $('#reselect').checked); });

loadOverview().then(() => {
  const first = state.overview.selections[0];
  if (first) showDay(first.operating_date);
  else $('#detail').innerHTML = emptyState();
}).catch((e) => notice(e.message, true));
