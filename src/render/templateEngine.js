'use strict';
/**
 * JSON reel templates (templates/reels/<id>.json) → FFmpeg drawtext/drawbox chain.
 *
 * Element types: text, pill, label, box, list, clipCues.
 * Layout: `y` sets the cursor, `gap` moves it relative to the previous element, `minY` floors it.
 *         Skipped elements (`if` binding empty) don't move the cursor.
 * Timing: `show: [start, end]` (seconds) draws only in that window with fade in/out;
 *         `fadeIn: s` fades in from s and stays. Neither → static.
 * Colors: "accent" | "bg" | "white" | "#RRGGBB".
 */
const fs = require('node:fs');
const path = require('node:path');
const { fv } = require('./ffmpeg');
const { ROOT } = require('../config');

const TEMPLATE_DIR = path.join(ROOT, 'templates', 'reels');
const TYPES = new Set(['text', 'pill', 'label', 'box', 'list', 'clipCues']);
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
  if (/^#[0-9a-fA-F]{6}$/.test(c)) return '0x' + c.slice(1).toUpperCase();
  throw new Error(`Unsupported color "${c}"`);
}

/** Visibility window → { enable, alpha } expressions (or nulls when static). */
function timing(el, duration) {
  if (el.show) {
    const [a, b] = el.show;
    const fin = a > 0 ? `if(lt(t,${a + FADE}),(t-${a})/${FADE},` : '';
    const fout = b < duration ? `if(gt(t,${b - FADE}),max(0,(${b}-t)/${FADE}),1)` : '1';
    return { enable: `between(t,${a},${b})`, alpha: `${fin}${fout}${a > 0 ? ')' : ''}` };
  }
  if (el.fadeIn != null) return { enable: null, alpha: `min(1,max(0,(t-${el.fadeIn})/0.5))` };
  return { enable: null, alpha: null };
}

class FilterBuilder {
  constructor(workDir, font) { this.workDir = workDir; this.font = font; this.n = 0; this.parts = []; }
  text(str, { size, color: col = 'white', x, y, alpha = null, enable = null, box = null }) {
    const name = `t${this.n++}.txt`;
    fs.writeFileSync(path.join(this.workDir, name), String(str), 'utf8');
    let f = `drawtext=fontfile=${fv(this.font)}:textfile=${name}:expansion=none:fontsize=${size}:fontcolor=${col}:x=${x}:y=${y}`;
    if (box) f += `:box=1:boxcolor=${box.color}:boxborderw=${box.border ?? 14}`;
    if (alpha) f += `:alpha=${fv(alpha)}`;
    if (enable) f += `:enable=${fv(enable)}`;
    this.parts.push(f);
  }
  box(x, y, w, h, col, enable = null) {
    this.parts.push(`drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=${col}:t=fill` + (enable ? `:enable=${fv(enable)}` : ''));
  }
  chain() { return this.parts.join(',\n'); }
}

/**
 * Draws every template element. `data` holds the bindings (headline, why, cues, clipCues …).
 * Returns a layout report (which elements were drawn, final cursor) for tests and debugging.
 */
function drawTemplate(fb, tpl, data, { accent, duration, margin = 90 }) {
  let cursor = 0;
  const drawn = [];
  for (const el of tpl.elements) {
    const value = el.bind ? data[el.bind] : el.value;
    if ((el.if && !data[el.if]) || (el.bind && (value == null || value === '' || (Array.isArray(value) && !value.length)))) continue;
    if (typeof el.y === 'number') cursor = el.y;
    else if (typeof el.gap === 'number') cursor += el.gap;
    if (typeof el.minY === 'number') cursor = Math.max(cursor, el.minY);
    const x = el.x === 'right' ? `w-tw-${margin}` : (el.x ?? margin);
    const { enable, alpha } = timing(el, duration);
    const size = el.size ?? 40;
    const pitch = Math.round(size * (el.pitch ?? 1.2));
    const col = color(el.color ?? (el.type === 'pill' ? 'accent' : 'white'), accent);
    let h = 0;

    if (el.type === 'text') {
      const lines = wrap(`${el.prefix ?? ''}${value}`, el.wrap);
      lines.forEach((l, i) => fb.text(l, { size, color: col, x, y: cursor + i * pitch, alpha, enable,
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
      fb.text(value, { size, color: col === 'white' ? accent : col, x: (typeof x === 'number' ? x : margin) + 26, y: cursor + 4, alpha, enable });
      h = Math.round(size * 1.35);
    } else if (el.type === 'box') {
      fb.box(x, cursor, el.w, el.h, col, enable);
      h = el.h;
    } else if (el.type === 'list') {
      const labelW = Math.round(size * 0.62 * 5 + 30); // room for "12:34"
      for (const item of value) {
        const lines = wrap(item.text, el.wrap);
        fb.text(item.label, { size, color: color(el.labelColor ?? 'accent', accent), x, y: cursor + h, alpha, enable });
        lines.forEach((l, i) => fb.text(l, { size, color: col, x: (typeof x === 'number' ? x : margin) + labelW, y: cursor + h + i * pitch, alpha, enable }));
        h += lines.length * pitch + (el.itemGap ?? 24);
      }
    } else if (el.type === 'clipCues') {
      // Each cue pops up at its moment inside the clip (t = cue time - clip start) for `holdSec`.
      for (const q of value) {
        const a = Math.max(0, q.t), b = Math.min(duration, q.t + (el.holdSec ?? 2.8));
        if (b <= a) continue;
        const tm = timing({ show: [a, b] }, duration);
        fb.text(`${q.label}  ${q.text}`, { size, color: col, x, y: cursor, alpha: tm.alpha, enable: tm.enable,
          box: { color: `${BG}@0.72`, border: 16 } });
      }
      h = pitch;
    }
    drawn.push({ type: el.type, bind: el.bind ?? null, y: cursor, h });
    cursor += h;
  }
  return { drawn, cursor };
}

module.exports = { loadTemplate, listTemplates, pickTemplate, drawTemplate, FilterBuilder, wrap, textWidth, timing, BG, TEMPLATE_DIR };
