'use strict';
/**
 * 9:16 화면을 브라우저에서 그대로 합성한다 — 영상이 그 안에서 재생되고, 글자는 그 자리에서 고친다.
 *
 * What this draws is what src/render/renderReel.js will render: the same template JSON, the same
 * coordinates, the same crop maths. Nothing here invents a layout — it reads the template the server
 * sends and mirrors drawTemplate()'s cursor rules (margin 90, pitch 1.2×, pill width, scrim band).
 *
 * The frame is built at the real 1080×1920 and then scaled with one CSS transform, so a coordinate in
 * the template is the same number here as in the filter. No per-element arithmetic can drift.
 *
 * It is a preview, not the renderer. Two things can differ by a hair:
 *  - where a long line wraps, because FFmpeg and the browser measure text differently;
 *  - a pixel or two of vertical placement, for the same reason.
 * That is why 「실제 결과 확인」 stays on screen: it asks the server for a real frame.
 */

const W = 1080, H = 1920, MARGIN = 90;
const BGC = '#101014';
const ACCENTS = { cover: '#2EC4B6', band: '#FF5A3C', acoustic: '#F2B134', piano: '#F2B134', unplugged: '#F2B134', orchestra: '#9B7BFF', jazz: '#6FA8FF', live: '#E8E8EE' };

/** The same character weighting the renderer wraps by: CJK is 1.8 columns wide. */
const charWeight = (ch) => (/[ᄀ-ᇿ　-鿿가-힯豈-﫿]/.test(ch) ? 1.8 : 1);
const textWidth = (s) => [...String(s)].reduce((a, ch) => a + charWeight(ch), 0);

function wrapText(text, maxChars) {
  if (!maxChars) return [String(text)];
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (textWidth(next) > maxChars && cur) { lines.push(cur); cur = w; } else cur = next;
  }
  if (cur) lines.push(cur);
  return lines;
}

const colorOf = (c, accent) => {
  if (!c || c === 'white') return '#FFFFFF';
  if (c === 'accent') return accent;
  if (c === 'bg') return BGC;
  if (c === 'black') return '#000000';
  return c;
};

/** `(H-h)/2` in a template's video.y, evaluated the way the overlay filter would. */
function evalY(y, boxH) {
  if (typeof y === 'number') return y;
  const s = String(y ?? 0);
  if (/^\(H-h\)\/2$/.test(s)) return Math.round((H - boxH) / 2);
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Where the video sits and how much of it shows — the browser half of clipFilter()/fillBox().
 *
 * fullBleed and `fit: cover` scale the picture up until it covers the box (times zoom) and then take
 * the box out of it at cropX/cropY. `contain` scales to the full width and centres it, which is why
 * zoom and the crops do nothing there — exactly as the filter ignores them.
 */
function videoLayout(tpl, { zoom = 1, cropX = 0.5, cropY = 0.5 } = {}, natural = { w: 16, h: 9 }) {
  const v = tpl.video ?? {};
  const fullBleed = v.fullBleed === true;
  const boxW = W;
  const boxH = fullBleed ? H : (v.height ?? Math.round((W * natural.h) / natural.w));
  const boxY = fullBleed ? 0 : evalY(v.y, boxH);
  const cover = fullBleed || v.fit === 'cover';

  if (!cover) {
    const h = Math.round((W * natural.h) / natural.w);
    return { box: { x: 0, y: evalY(v.y, h), w: W, h }, video: { x: 0, y: 0, w: W, h }, cover: false };
  }
  const z = Math.min(2.5, Math.max(1, Number(zoom) || 1));
  const targetW = boxW * z, targetH = boxH * z;
  const s = Math.max(targetW / natural.w, targetH / natural.h);
  const w = Math.round(natural.w * s), h = Math.round(natural.h * s);
  return {
    box: { x: 0, y: boxY, w: boxW, h: boxH },
    video: { x: Math.round(-(w - boxW) * cropX), y: Math.round(-(h - boxH) * cropY), w, h },
    cover: true,
  };
}

/** A bottom/top scrim as one CSS gradient instead of the renderer's twelve strips. Same band, same edge. */
function scrimStyle(el, accent) {
  const col = colorOf(el.color ?? 'black', accent);
  const op = el.opacity ?? 0.45;
  const dir = el.from === 'top' ? 'to bottom' : 'to top';
  const rgba = (a) => (col === '#000000'
    ? `rgba(0,0,0,${a})`
    : `color-mix(in srgb, ${col} ${Math.round(a * 100)}%, transparent)`);
  if (el.from !== 'bottom' && el.from !== 'top') return `background:${rgba(op)}`;
  return `background:linear-gradient(${dir}, ${rgba(op)}, ${rgba(0)})`;
}

const EDITABLE = {
  tag: 'tag_text', headline: 'title_text', performerLine: 'performer_text',
  koLine: 'ko_text', why: 'why_text', footer: 'footer_text', credit: 'credit_text',
};
/** Shown in a slot that is still empty, so there is something to see and something to click. */
const PLACEHOLDER = {
  tag: 'COVER', headline: '큰 제목을 여기에', performerLine: '공연자 – 곡명',
  koLine: '한글 줄 (선택)', why: '한 줄 소개 (선택)', footer: '아래 출처 줄 (선택)',
  credit: 'Source: 출처',
};

/**
 * Builds the frame's inner HTML at true 1080×1920 and returns it.
 *
 * A slot the operator has filled is drawn exactly as the renderer will draw it. A slot still empty is
 * drawn as a faint example (`ghosts`), because otherwise there is nothing on screen to show where the
 * text goes or to click. The renderer draws none of those examples — 「실제 결과 확인」 and turning
 * 「예시 글씨 보기」 off both show the picture without them.
 */
function composeHtml(tpl, data, { accent, ghosts = true }) {
  let cursor = 0;
  const out = [];
  const at = (x, y, extra = '') => `position:absolute;left:${x}px;top:${y}px;${extra}`;

  for (const el of tpl.elements) {
    const field = el.bind ? EDITABLE[el.bind] : null;
    const raw = el.bind ? data[el.bind] : el.value;
    const empty = raw == null || raw === '' || (Array.isArray(raw) && !raw.length);
    // Cues belong to a candidate; the editor has none, so there is nothing to draw for them.
    if (el.type === 'clipCues' || el.type === 'list') continue;
    if (el.if && !data[el.if]) continue;
    if (empty && !(field && ghosts)) continue;
    const ghost = empty;
    const value = ghost ? (PLACEHOLDER[el.bind] ?? '') : raw;
    if (ghost && !value) continue;

    if (el.type === 'scrim') {
      out.push(`<div class="cs-el" style="${at(0, el.y ?? 0, `width:${W}px;height:${el.h ?? 0}px;${scrimStyle(el, accent)}`)}"></div>`);
      continue;
    }
    if (typeof el.y === 'number') cursor = el.y;
    else if (typeof el.gap === 'number') cursor += el.gap;
    if (typeof el.minY === 'number') cursor = Math.max(cursor, el.minY);

    const size = el.size ?? 40;
    const pitch = Math.round(size * (el.pitch ?? 1.2));
    const col = colorOf(el.color ?? (el.type === 'pill' ? 'accent' : 'white'), accent);
    const right = el.x === 'right';
    const x = right ? MARGIN : (typeof el.x === 'number' ? el.x : MARGIN);
    const shadow = el.shadow ? 'text-shadow:3px 3px 0 rgba(0,0,0,.85);' : '';
    // Clicking a line sends the cursor to its block on the right; it is never edited in place.
    const edit = field ? ` data-field="${field}" data-bind="${el.bind}" title="오른쪽 칸에서 고칩니다"` : '';
    const cls = `cs-el${field ? ' cs-click' : ''}${ghost ? ' cs-ghost' : ''}`;
    let h = 0;

    if (el.type === 'text') {
      const lines = wrapText(`${el.prefix ?? ''}${value}`, el.wrap);
      h = lines.length * pitch;
      const style = at(right ? 0 : x, cursor - Math.round((pitch - size) / 2),
        `${right ? `width:${W - MARGIN}px;text-align:right;` : `max-width:${W - x - MARGIN}px;`}`
        + `font-size:${size}px;line-height:${pitch}px;color:${col};${shadow}`);
      out.push(`<div class="${cls}" style="${style}"${edit}>${esc(lines.join('\n'))}</div>`);
    } else if (el.type === 'pill') {
      const pw = Math.min(Math.round(textWidth(value) * size * 0.62 + 64), 900);
      const ph = Math.round(size * 2);
      h = ph;
      out.push(`<div class="cs-el" style="${at(x, cursor, `width:${pw}px;height:${ph}px;background:${col};`)}"></div>`);
      out.push(`<div class="${cls}" style="${at(x + 32, cursor + Math.round((ph - size) / 2) - 2,
        `font-size:${size}px;line-height:${size}px;color:${colorOf(el.textColor ?? 'bg', accent)};`)}"${edit}>${esc(value)}</div>`);
    } else if (el.type === 'label') {
      h = Math.round(size * 1.35);
      out.push(`<div class="cs-el" style="${at(x, cursor, `width:6px;height:${h}px;background:${accent};`)}"></div>`);
      out.push(`<div class="${cls}" style="${at(x + 26, cursor + 4, `font-size:${size}px;line-height:${pitch}px;color:${col === '#FFFFFF' ? accent : col};${shadow}`)}"${edit}>${esc(value)}</div>`);
    } else if (el.type === 'box') {
      h = el.h ?? 0;
      out.push(`<div class="cs-el" style="${at(x, cursor, `width:${el.w ?? W}px;height:${h}px;background:${col};`)}"></div>`);
    }
    cursor += h;
  }
  return out.join('');
}

/** The accent the renderer would use, from what the operator typed in the little box. */
function accentFor(tagText) {
  const t = String(tagText ?? '').toLowerCase();
  if (t.includes('cover')) return ACCENTS.cover;
  for (const key of ['band', 'acoustic', 'piano', 'unplugged', 'orchestra', 'jazz']) {
    if (t.includes(key)) return ACCENTS[key];
  }
  return ACCENTS.live;
}

/**
 * Lays the whole frame out: the picture box (with the <video> moved into it) and the text over it.
 * The same <video> element is reused so playback never stops when the shape changes.
 */
/**
 * Where the picture gets cut when it is not being played as a reel.
 *
 * A reel plays at the full 9:16, but the feed shows about the middle 4:5 of it and the profile grid
 * about the middle square. Text that sits outside those is still in the video — it is simply not
 * visible in those two places. These are guides, not a rule: Instagram decides the real crop.
 */
function guidesHtml() {
  const band = (h, label, cls) => {
    const top = Math.round((H - h) / 2);
    return `<div class="cs-guide ${cls}" style="left:0;top:${top}px;width:${W}px;height:${h}px">
      <span class="cs-guideTag">${label}</span></div>`;
  };
  return band(Math.round(W * 5 / 4), '피드에서 보이는 범위 (4:5)', 'g45') + band(W, '격자 썸네일 (1:1)', 'g11');
}

function composeFrame(host, { tpl, data, framing, videoEl, natural, ghosts = true, guides = false }) {
  const accent = accentFor(data.tag);
  const lay = videoLayout(tpl, framing, natural);
  host.innerHTML = `<div class="cs-vbox" style="left:${lay.box.x}px;top:${lay.box.y}px;width:${lay.box.w}px;height:${lay.box.h}px"></div>${composeHtml(tpl, data, { accent, ghosts })}${guides ? guidesHtml() : ''}`;
  const vbox = host.querySelector('.cs-vbox');
  vbox.appendChild(videoEl);
  Object.assign(videoEl.style, {
    position: 'absolute',
    left: `${lay.video.x}px`, top: `${lay.video.y}px`,
    width: `${lay.video.w}px`, height: `${lay.video.h}px`,
    objectFit: 'fill',
  });
  return lay;
}

window.Compose = { composeFrame, composeHtml, guidesHtml, videoLayout, wrapText, textWidth, accentFor, EDITABLE, W, H, MARGIN };
