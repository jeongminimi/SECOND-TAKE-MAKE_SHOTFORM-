'use strict';
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ACC = { cover: '#2EC4B6', band: '#FF5A3C', acoustic: '#F2B134', piano: '#F2B134', unplugged: '#F2B134', orchestra: '#9B7BFF', jazz: '#6FA8FF', live: '#E8E8EE' };
const SCORE_LABEL = { versionDifference: '버전의 차이', englishInfo: '영어 소개 정보', timeliness: '소개할 시점', recentDiversity: '최근 콘텐츠와의 차이' };
const FORMAT_LABEL = { licensed_clip: '공연 클립형', original_graphic: '자체 그래픽형' };

let state = { overview: null, current: null };

async function api(path, opts) {
  const r = await fetch(path, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

function notice(msg, err = false) {
  const n = $('#notice');
  if (!msg) { n.hidden = true; return; }
  n.hidden = false; n.className = 'notice' + (err ? ' err' : ''); n.textContent = msg;
}

async function loadOverview() {
  const o = await api('/api/overview');
  state.overview = o;
  $('#brandName').textContent = o.account.displayName;
  $('#brandConcept').textContent = `${o.account.concept} · ${o.account.handle}`;
  if (!$('#runDate').value) $('#runDate').value = Object.keys(o.scenarioDates)[0] ?? o.today;
  $('#scenarios').innerHTML = Object.entries(o.scenarioDates).map(([d, t]) =>
    `<button class="chip" data-date="${d}"><b>${d}</b>${esc(t)}</button>`).join('');
  const list = $('#dayList');
  list.innerHTML = o.selections.length ? o.selections.map((s) => `
    <li><button data-date="${s.operating_date}" class="${state.current === s.operating_date ? 'active' : ''}">
      <span class="d">${s.operating_date} ${s.revision > 1 ? `· rev ${s.revision}` : ''}</span>
      <span>${s.status === 'skipped' ? '<span class="badge">건너뜀</span>' : `<span class="badge ${s.output_format === 'licensed_clip' ? 'info' : 'warn'}">${FORMAT_LABEL[s.output_format] ?? '-'}</span> <span class="badge">${s.score}점</span>`}</span>
      <span class="t">${esc(s.title_en ?? s.skip_reason ?? '')}</span>
    </button></li>`).join('') : '<li class="muted">아직 실행 기록이 없습니다.</li>';
  const sn = $('#serverNote');
  sn.hidden = !o.expressFallback;
  sn.textContent = 'ⓘ Express 미설치 — 내장 호환 서버로 실행 중입니다. `npm install` 후 다시 시작하면 Express로 동작합니다.';
}

async function run(date, reselect = false) {
  const btn = $('#runBtn');
  btn.disabled = true; btn.textContent = '실행 중…';
  try {
    const r = await api('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date, reselect }) });
    notice(r.selectionReused ? `${date}: 이미 실행된 날짜입니다. 기존 선곡${r.reelCreated ? '' : '·릴스'}를 재사용했습니다${r.rendered ? ' (실패한 렌더링 이어서 처리)' : ''}. 새 기록은 만들지 않았습니다.` : `${date}: ${reselect ? '재선곡 완료' : '새로 실행했습니다'}.`);
    state.current = date;
    await loadOverview();
    await showDay(date);
  } catch (e) {
    notice(`${date}: ${e.message}`, true);
  } finally {
    btn.disabled = false; btn.textContent = '파이프라인 실행';
    $('#reselect').checked = false;
  }
}

function flowSteps(d) {
  const s = d.selection;
  const job = d.jobs?.[0];
  if (s.status === 'skipped') {
    return [['후보 입력', 'ok', `${d.snapshot.length}개 후보`], ['자동 선곡', 'bad', '적격 후보 없음 → 건너뜀'], ['권한 판정', 'skip', '-'], ['영어 문구', 'skip', '-'], ['9:16 영상', 'skip', '-'], ['예약 발행', 'skip', '발행 안 함']];
  }
  const elig = d.snapshot.filter((x) => x.eligible).length;
  return [
    ['후보 입력', 'ok', `${d.snapshot.length}개 중 ${elig}개 적격`],
    ['자동 선곡', 'ok', `${d.candidate.performer_en} · ${s.score}점`],
    ['권한 판정', d.reel?.output_format === 'licensed_clip' ? 'ok' : 'warn', FORMAT_LABEL[d.reel?.output_format] ?? '-'],
    ['영어 문구', 'ok', '결정적 템플릿'],
    ['9:16 영상', d.reel?.render_status === 'done' ? 'ok' : 'bad', d.reel?.render_status ?? '-'],
    ['예약 발행', job ? (job.status === 'simulated' ? 'ok' : 'bad') : 'skip', job ? `드라이런 ${job.status}` : '-'],
  ];
}

function scoreHtml(items) {
  return `<div class="score">${items.map((i) => `
    <div class="row"><span>${SCORE_LABEL[i.key] ?? i.key}</span><span class="bar"><i style="width:${(i.points / i.max) * 100}%"></i></span><b>${i.points}/${i.max}</b></div>
    <div class="row"><span></span><span class="why">${esc(i.reason)}</span></div>`).join('')}</div>`;
}

function candTable(d) {
  const pickedId = d.selection.candidate_id;
  const rows = [...d.snapshot].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
  return `<thead><tr><th>순위</th><th>후보</th><th>버전</th><th>점수</th><th>클립</th></tr></thead><tbody>${rows.map((c) => {
    const tags = [c.performance_type, ...(c.arrangement_tags ?? [])].filter(Boolean).join(' · ');
    const clip = !c.clip ? '<span class="muted">-</span>'
      : c.clip.usable_asset_key ? `<span class="badge ok">사용 가능</span> <span class="k">${esc(c.clip.usable_asset_key)}</span>`
      : c.clip.assets.length ? `<span class="badge bad">사용 불가</span><ul>${c.clip.assets.map((a) => `<li>${esc(a.asset_key)}: ${esc(a.reasons[0])}${a.reasons.length > 1 ? ` 외 ${a.reasons.length - 1}건` : ''}</li>`).join('')}</ul>`
      : '<span class="muted">등록된 클립 없음</span>';
    return `<tr class="${c.candidate_id === pickedId ? 'picked' : ''}">
      <td>${c.rank ?? '<span class="badge">제외</span>'}</td>
      <td><b>${esc(c.performer_en ?? '?')}</b> – ${esc(c.title_en ?? c.title_ko ?? '?')}<div class="k">${esc(c.candidate_key)}</div>
        ${c.eligible ? '' : `<ul>${c.exclusions.map((x) => `<li>${esc(x.text)}</li>`).join('')}</ul>`}</td>
      <td>${esc(tags)}</td>
      <td>${c.score ? `<b>${c.score.total}</b>` : '-'}</td>
      <td>${clip}</td></tr>`;
  }).join('')}</tbody>`;
}

function rightsCard(d) {
  const picked = d.snapshot.find((x) => x.candidate_id === d.selection.candidate_id);
  const assets = picked?.clip?.assets ?? [];
  return `<h3>권한 판정 · 제작 형식</h3>
    <p><span class="badge ${d.reel.output_format === 'licensed_clip' ? 'info' : 'warn'}">${FORMAT_LABEL[d.reel.output_format]}</span> ${esc(d.reel.format_reason)}</p>
    ${assets.length ? assets.map((a) => `<div class="asset"><h4>${esc(a.asset_key)} ${a.eligible ? '<span class="badge ok">적격</span>' : '<span class="badge bad">부적격</span>'} ${a.testOnly ? '<span class="badge warn">테스트 소재 · 실제 게시 불가</span>' : ''}</h4>
      <ul class="checks">${a.checks.map((c) => `<li class="${c.testOnly ? 'test' : c.ok ? '' : 'no'}">${esc(c.label)}</li>`).join('')}</ul></div>`).join('')
      : '<p class="muted">이 후보에는 등록된 클립 파일이 없습니다. 공식 링크만으로는 파일 확보·이용 허락으로 보지 않습니다.</p>'}`;
}

const fmtT = (x) => { const s = Math.round(x * 10) / 10; return `${Math.floor(s / 60)}:${String((s % 60).toFixed(1)).padStart(4, '0')}`; };

function segCard(d) {
  const sug = d.suggestions ?? [];
  const head = `<h3>클립 구간 추천 <span class="muted small">곡 구조 분석(all-in-one) · 승인 전에는 아무것도 바뀌지 않음</span></h3>`;
  if (!sug.length) return `${head}<p class="muted">이 후보의 클립에 대한 추천이 없습니다. <code>npm run analyze</code>로 분석하거나, 권리 정보(허락 구간)를 먼저 채워야 합니다.</p>`;
  return head + sug.map((s) => `<div class="asset">
    <h4>${esc(s.asset_key)} <span class="badge ${s.status === 'approved' ? 'ok' : s.status === 'proposed' ? 'info' : ''}">${esc(s.status)}</span>
      ${s.analyzer === 'fixture' ? '<span class="badge warn">픽스처 · 실제 모델 결과 아님</span>' : '<span class="badge">all-in-one</span>'}</h4>
    <dl class="kv">
      <dt>추천 구간</dt><dd><b>${esc(s.label)}</b> ${fmtT(s.suggested_start_sec)}–${fmtT(s.suggested_end_sec)} (${(s.suggested_end_sec - s.suggested_start_sec).toFixed(1)}초)${s.bpm ? ` · ${s.bpm} BPM` : ''}</dd>
      <dt>현재 사용 구간</dt><dd>${fmtT(s.current_start_sec)}–${fmtT(s.current_end_sec)}</dd>
      <dt>근거</dt><dd class="small">${esc(s.notes)}</dd>
    </dl>
    ${s.status === 'proposed' ? `<div class="actions"><button class="btn" data-approve="${s.id}">승인하고 다시 렌더링</button><button class="btn ghost" data-reject="${s.id}">거절</button></div>` : ''}
  </div>`).join('') + '<p class="small muted">자동 분석 구간은 공식 타임스탬프가 아니므로 캡션의 ▶ 시점 표시에 쓰지 않습니다.</p>';
}

function jobCard(d) {
  const job = d.jobs?.[0];
  if (!job) return `<h3>예약 발행 (드라이런)</h3><p class="muted">렌더링이 끝나지 않아 예약 작업을 만들지 않았습니다. 같은 날짜를 다시 실행하면 이어서 처리합니다.</p>${d.reel.render_error ? `<p class="reason">${esc(d.reel.render_error)}</p>` : ''}`;
  const p = job.plan ?? {};
  return `<h3>예약 발행 (드라이런) <span class="badge ${job.status === 'simulated' ? 'ok' : 'bad'}">${job.status}</span></h3>
    <dl class="kv">
      <dt>예약 시각 (UTC)</dt><dd>${esc(job.scheduled_at)}</dd>
      <dt>운영 기준</dt><dd>${esc(p.scheduled_local)}</dd>
      <dt>사용할 파일</dt><dd>${esc(p.file)}</dd>
      <dt>예상 상태</dt><dd>${esc(job.expected_status)}</dd>
      <dt>외부 게시물 ID</dt><dd class="muted">없음 (드라이런은 ID·조회수를 만들지 않음)</dd>
    </dl>
    <h4 class="small muted" style="margin:14px 0 6px">드라이런 점검</h4>
    <ul class="checks">${(p.checks ?? []).map((c) => `<li class="${c.ok ? '' : 'no'}">${esc(c.label)}</li>`).join('')}</ul>
    <h4 class="small muted" style="margin:14px 0 6px">실제 발행 시 확인 사항</h4>
    <ul class="checks">${(p.live_readiness ?? []).map((c) => `<li class="test">${esc(c)}</li>`).join('')}</ul>`;
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

function previewCard(d) {
  const r = d.reel;
  const hasVideo = r.render_status === 'done' && r.video_url;
  return `<h3>9:16 미리보기</h3>
    <div class="tabs"><button data-tab="mp4" class="${hasVideo ? 'on' : ''}" ${hasVideo ? '' : 'disabled'}>MP4 출력</button><button data-tab="html" class="${hasVideo ? '' : 'on'}">HTML 미리보기</button></div>
    <div class="phone" id="phone">${hasVideo ? `<video src="${r.video_url}" poster="${r.poster_url}" controls loop playsinline></video>` : mockHtml(d)}</div>
    <p class="small muted">템플릿 <b>${esc(r.template_id ?? '-')}</b> · ${hasVideo ? `실제 렌더링된 MP4 · ${esc(r.output_path)}` : `MP4 없음 (렌더링 ${esc(r.render_status)}) — HTML 미리보기만 표시`}</p>`;
}

function captionCard(d) {
  return `<h3>영어 캡션</h3>
    <p class="small muted">첫 화면 제목</p><p><b>${esc(d.reel.title_en)}</b></p>
    <div class="caption" id="captionText">${esc(d.reel.caption)}</div>
    <div class="actions"><button class="btn" id="copyCaption">캡션 복사</button>
      <a class="btn ghost" href="${esc(d.reel.official_link)}" target="_blank" rel="noopener noreferrer">공식 원본 ↗</a>
      <a class="btn ghost" href="${esc(d.reel.guide_page_path)}" target="_blank">원본 안내 페이지 ↗</a></div>`;
}

async function showDay(date) {
  state.current = date;
  document.querySelectorAll('#dayList button').forEach((b) => b.classList.toggle('active', b.dataset.date === date));
  let d;
  try { d = await api(`/api/day/${date}`); } catch (e) {
    $('#detail').innerHTML = `<section class="empty"><h1>${date}</h1><p>${esc(e.message)}. 위에서 이 날짜로 파이프라인을 실행하세요.</p></section>`;
    return;
  }
  const root = $('#detail');
  root.innerHTML = '';
  root.append($('#tplDay').content.cloneNode(true));
  const ref = (n) => root.querySelector(`[data-ref="${n}"]`);
  ref('flow').innerHTML = flowSteps(d).map(([t, cls, v]) => `<div class="step ${cls}"><b>${t}</b>${esc(v)}</div>`).join('');
  ref('ruleVer').textContent = `· 선곡 규칙 ${d.selection.rule_version}`;
  ref('candTable').innerHTML = candTable(d);
  const s = d.selection;
  if (s.status === 'skipped') {
    ref('selCard').innerHTML = `<h3>${date} · 선곡 결과 <span class="badge">건너뜀</span></h3><div class="skipbox">${esc(s.skip_reason)}</div>`;
    ['rightsCard', 'segCard', 'jobCard', 'previewCard', 'captionCard'].forEach((n) => ref(n).remove());
    root.querySelector('.cols').style.gridTemplateColumns = '1fr';
    return;
  }
  ref('selCard').innerHTML = `<h3>${date} · 선택된 후보 <span class="badge ok">${s.score}/100</span> ${s.revision > 1 ? `<span class="badge info">rev ${s.revision}</span>` : ''}</h3>
    <p style="margin:0"><b style="font-size:17px">${esc(d.candidate.performer_en)} – ${esc(d.candidate.title_en)}</b> <span class="muted">${esc(d.candidate.performer_ko ?? '')} – ${esc(d.candidate.title_ko ?? '')}</span></p>
    <p class="small muted" style="margin:4px 0 0">${esc(d.candidate.program_name)} · 공식 게시 ${esc(d.candidate.published_at)} · ${esc(d.candidate.video_title)}</p>
    ${scoreHtml(s.score_breakdown.items)}
    <div class="reason">${esc(s.reason)}</div>`;
  ref('rightsCard').innerHTML = rightsCard(d);
  ref('segCard').innerHTML = segCard(d);
  root.querySelectorAll('[data-approve],[data-reject]').forEach((b) => b.addEventListener('click', async () => {
    const id = b.dataset.approve ?? b.dataset.reject;
    const act = b.dataset.approve ? 'approve' : 'reject';
    b.disabled = true; b.textContent = act === 'approve' ? '렌더링 중…' : '처리 중…';
    try {
      const r = await api(`/api/suggestions/${id}/${act}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      notice(act === 'approve' ? `구간 승인 완료. 다시 렌더링한 날짜: ${r.rerunDates.join(', ') || '없음 (이 클립을 쓰는 릴스가 아직 없음)'}` : '추천을 거절했습니다.');
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
  $('#copyCaption').addEventListener('click', async (e) => {
    try { await navigator.clipboard.writeText(d.reel.caption); e.target.textContent = '복사됨 ✓'; }
    catch { const r = document.createRange(); r.selectNodeContents($('#captionText')); getSelection().removeAllRanges(); getSelection().addRange(r); e.target.textContent = '선택됨 — Ctrl+C'; }
  });
}

document.addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (chip) { $('#runDate').value = chip.dataset.date; run(chip.dataset.date); return; }
  const day = e.target.closest('#dayList button');
  if (day) showDay(day.dataset.date);
});
$('#runForm').addEventListener('submit', (e) => { e.preventDefault(); run($('#runDate').value, $('#reselect').checked); });

loadOverview().then(() => { const first = state.overview.selections[0]; if (first) showDay(first.operating_date); })
  .catch((e) => notice(e.message, true));
