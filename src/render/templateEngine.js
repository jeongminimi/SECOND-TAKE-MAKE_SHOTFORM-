'use strict';
/**
 * JSON reel templates (templates/reels/<id>.json) → FFmpeg drawtext/drawbox chain.
 *
 * Element types: text, pill, label, box, list, clipCues, scrim.
 * Layout: `y` sets the cursor, `gap` moves it relative to the previous element, `minY` floors it.
 *         Skipped elements (`if` binding empty) don't move the cursor, and neither does a `scrim`,
 *         which is a backdrop at its own absolute position.
 * Over video: `scrim` darkens a band so text stays readable; `shadow: true` on a text element adds a
 *         drop shadow. Both matter only for templates whose video fills the frame.
 * Timing: `show: [start, end]` (seconds) draws only in that window with fade in/out;
 *         `fadeIn: s` fades in from s and stays. Neither → static.
 * Colors: "accent" | "bg" | "white" | "#RRGGBB".
 */
const fs = require('node:fs');
const path = require('node:path');
const { fv } = require('./ffmpeg');
const { ROOT } = require('../config');

const TEMPLATE_DIR = path.join(ROOT, 'templates', 'reels');
const TYPES = new Set(['text', 'pill', 'label', 'box', 'list', 'clipCues', 'scrim']);
const FADE = 0.35;
const BG = '0x101014';

function loadTemplate(id) {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`Invalid template id: ${id}`);
  const file = path.join(TEMPLATE_DIR, `${id}.json`);
  if (!fs.existsSync(file)) throw new Error(`Template not found: templates/reels/${id}.json`);
  const t = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (t.id !== id) throw new Error(`Template ${file}: id field "${t.id}" does not match file name`);
  if (!['original_graphic', 'licensed_clip'].includes(t.format)) throw new Error(`Template ${id}: unknown format ${t.format}`);
  for (const [i, el] of (t.elements ?? []).entries()) {
    if (!TYPES.has(el.type)) throw new Error(`Template ${id}: element ${i} has unknown type "${el.type}"`);
  }
  return t;
}

function listTemplates() {
  return fs.readdirSync(TEMPLATE_DIR).filter((f) => f.endsWith('.json')).map((f) => loadTemplate(f.replace(/\.json$/, '')));
}

/** Deterministic rotation: operating date (days since epoch) modulo the configured list for the format. */
function pickTemplate(cfg, format, operatingDate) {
  const list = cfg.render.templates?.[format];
  if (!list?.length) throw new Error(`No templates configured for ${format} (render.templates.${format})`);
  const day = Math.floor(Date.parse(`${operatingDate}T00:00:00Z`) / 86400000);
  return list[day % list.length];
}

function charWeight(ch) { return /[ᄀ-ᇿ　-鿿가-힯豈-﫿]/.test(ch) ? 1.8 : 1; }
function textWidth(s) { return [...String(s)].reduce((a, ch) => a + charWeight(ch), 0); }

function wrap(text, maxChars) {
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

function color(c, accent) {
  if (!c || c === 'white') return 'white';
  if (c === 'accent') return accent;
  if (c === 'bg') return BG;
  if (c === 'black') return 'black';
  if (/^#[0-9a-fA-F]{6}$/.test(c)) return '0x' + c.slice(1).toUpperCase();
  throw new Error(`Unsupported color "${c}"`);
}

/**
 * Visibility window → { enable, alpha } expressions (or nulls when static).
 *
 * `noFade` is for a one-frame preview: a fade-in evaluated at t=0 is fully transparent, so the very
 * text the operator is checking for collisions would be missing from the picture. Timed elements
 * (`show`) keep their window — they genuinely are not on screen at that moment.
 */
function timing(el, duration, noFade = false) {
  if (el.show) {
    const [a, b] = el.show;
    const fin = a > 0 ? `if(lt(t,${a + FADE}),(t-${a})/${FADE},` : '';
    const fout = b < duration ? `if(gt(t,${b - FADE}),max(0,(${b}-t)/${FADE}),1)` : '1';
    return { enable: `between(t,${a},${b})`, alpha: `${fin}${fout}${a > 0 ? ')' : ''}` };
  }
  if (el.fadeIn != null) return { enable: null, alpha: noFade ? null : `min(1,max(0,(t-${el.fadeIn})/0.5))` };
  return { enable: null, alpha: null };
}

class FilterBuilder {
  constructor(workDir, font) { this.workDir = workDir; this.font = font; this.n = 0; this.parts = []; }
  text(str, { size, color: col = 'white', x, y, alpha = null, enable = null, box = null, shadow = null }) {
    const name = `t${this.n++}.txt`;
    fs.writeFileSync(path.join(this.workDir, name), String(str), 'utf8');
    let f = `drawtext=fontfile=${fv(this.font)}:textfile=${name}:expansion=none:fontsize=${size}:fontcolor=${col}:x=${x}:y=${y}`;
    if (box) f += `:box=1:boxcolor=${box.color}:boxborderw=${box.border ?? 14}`;
    // Over a video frame, white text on a bright shot disappears without one.
    if (shadow) f += `:shadowcolor=${shadow.color}:shadowx=${shadow.x}:shadowy=${shadow.y}`;
    if (alpha) f += `:alpha=${fv(alpha)}`;
    if (enable) f += `:enable=${fv(enable)}`;
    this.parts.push(f);
  }
  box(x, y, w, h, col, enable = null) {
    this.parts.push(`drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=${col}:t=fill` + (enable ? `:enable=${fv(enable)}` : ''));
  }
  chain() { return this.parts.join(',\n'); }
}

const round2 = (n) => Math.round(n * 100) / 100;
const SHADOW_DEFAULT = { color: 'black@0.85', x: 3, y: 3 };

/** `shadow: true` → the default drop shadow; `shadow: {color,x,y}` → that, with the rest defaulted. */
function shadowOf(el) {
  if (!el.shadow) return null;
  return el.shadow === true ? SHADOW_DEFAULT : { ...SHADOW_DEFAULT, ...el.shadow };
}

// Enough strips that the steps stop reading as lines across the picture. Four was visibly banded.
const SCRIM_BANDS = 12;

/**
 * A darkening band so text stays readable over a video frame.
 *
 * `from: "bottom"|"top"` draws it as a stepped gradient instead of a flat block: the band is split
 * into {SCRIM_BANDS} strips whose opacity ramps towards that edge, which reads as a fade and avoids a
 * hard line across the picture. Flat blocks are still available by leaving `from` out.
 */
function drawScrim(fb, el, accent, enable) {
  const col = color(el.color ?? 'black', accent);
  const op = el.opacity ?? 0.45;
  const y = el.y ?? 0, h = el.h ?? 0;
  if (h <= 0) return;
  if (el.from !== 'bottom' && el.from !== 'top') {
    fb.box(0, y, 1080, h, `${col}@${round2(op)}`, enable);
    return;
  }
  const strip = Math.round(h / SCRIM_BANDS);
  for (let i = 0; i < SCRIM_BANDS; i++) {
    // lightest at the inner edge, full `opacity` at the edge the band fades from
    const a = op * (el.from === 'bottom' ? (i + 1) / SCRIM_BANDS : 1 - i / SCRIM_BANDS);
    const top = y + i * strip;
    fb.box(0, top, 1080, i === SCRIM_BANDS - 1 ? y + h - top : strip, `${col}@${round2(a)}`, enable);
  }
}

/**
 * Draws every template element. `data` holds the bindings (headline, why, cues, clipCues …).
 * Returns a layout report (which elements were drawn, final cursor) for tests and debugging.
 */
function drawTemplate(fb, tpl, data, { accent, duration, margin = 90, noFade = false }) {
  let cursor = 0;
  const drawn = [];
  for (const el of tpl.elements) {
    const value = el.bind ? data[el.bind] : el.value;
    if ((el.if && !data[el.if]) || (el.bind && (value == null || value === '' || (Array.isArray(value) && !value.length)))) continue;
    // A scrim sits behind whatever follows it at its own absolute y: it must not move the cursor.
    if (el.type === 'scrim') {
      drawScrim(fb, el, accent, timing(el, duration, noFade).enable);
      drawn.push({ type: 'scrim', bind: null, y: el.y ?? 0, h: 0 });
      continue;
    }
    if (typeof el.y === 'number') cursor = el.y;
    else if (typeof el.gap === 'number') cursor += el.gap;
    if (typeof el.minY === 'number') cursor = Math.max(cursor, el.minY);
    const x = el.x === 'right' ? `w-tw-${margin}` : (el.x ?? margin);
    const { enable, alpha } = timing(el, duration, noFade);
    const size = el.size ?? 40;
    const pitch = Math.round(size * (el.pitch ?? 1.2));
    const col = color(el.color ?? (el.type === 'pill' ? 'accent' : 'white'), accent);
    const shadow = shadowOf(el);
    let h = 0;

    if (el.type === 'text') {
      const lines = wrap(`${el.prefix ?? ''}${value}`, el.wrap);
      lines.forEach((l, i) => fb.text(l, { size, color: col, x, y: cursor + i * pitch, alpha, enable, shadow,
        box: el.box ? { color: color(el.box.color, accent) + `@${el.box.opacity ?? 0.6}`, border: el.box.border } : null }));
      h = lines.length * pitch;
    } else if (el.type === 'pill') {
      const w = Math.min(Math.round(textWidth(value) * size * 0.62 + 64), 900);
      const ph = Math.round(size * 2);
      fb.box(typeof x === 'number' ? x : margin, cursor, w, ph, col, enable);
      fb.text(value, { size, color: color(el.textColor ?? 'bg', accent), x: (typeof x === 'number' ? x : margin) + 32, y: cursor + Math.round((ph - size) / 2) - 2, alpha, enable });
      h = ph;
    } else if (el.type === 'label') {
      fb.box(typeof x === 'number' ? x : margin, cursor, 6, Math.round(size * 1.35), color('accent', accent), enable);
      fb.text(value, { size, color: col === 'white' ? accent : col, x: (typeof x === 'number' ? x : margin) + 26, y: cursor + 4, alpha, enable, shadow });
      h = Math.round(size * 1.35);
    } else if (el.type === 'box') {
      fb.box(x, cursor, el.w, el.h, col, enable);
      h = el.h;
    } else if (el.type === 'list') {
      const labelW = Math.round(size * 0.62 * 5 + 30); // room for "12:34"
      for (const item of value) {
        const lines = wrap(item.text, el.wrap);
        fb.text(item.label, { size, color: color(el.labelColor ?? 'accent', accent), x, y: cursor + h, alpha, enable, shadow });
        lines.forEach((l, i) => fb.text(l, { size, color: col, x: (typeof x === 'number' ? x : margin) + labelW, y: cursor + h + i * pitch, alpha, enable, shadow }));
        h += lines.length * pitch + (el.itemGap ?? 24);
      }
    } else if (el.type === 'clipCues') {
      // Each cue pops up at its moment inside the clip (t = cue time - clip start) for `holdSec`.
      for (const q of value) {
        const a = Math.max(0, q.t), b = Math.min(duration, q.t + (el.holdSec ?? 2.8));
        if (b <= a) continue;
        const tm = timing({ show: [a, b] }, duration);
        fb.text(`${q.label}  ${q.text}`, { size, color: col, x, y: cursor, alpha: tm.alpha, enable: tm.enable, shadow,
          box: { color: `${BG}@0.72`, border: 16 } });
      }
      h = pitch;
    }
    drawn.push({ type: el.type, bind: el.bind ?? null, y: cursor, h });
    cursor += h;
  }
  return { drawn, cursor };
}

module.exports = { loadTemplate, listTemplates, pickTemplate, drawTemplate, FilterBuilder, wrap, textWidth, timing, shadowOf, BG, TEMPLATE_DIR };
