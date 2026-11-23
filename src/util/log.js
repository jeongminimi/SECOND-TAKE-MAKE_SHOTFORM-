'use strict';
/** Minimal logger that redacts anything that looks like a token or key before printing. */
const SECRET_PATTERNS = [
  /\b(EAA[A-Za-z0-9]{20,})\b/g,                         // Meta access tokens
  /\b(IGQ[A-Za-z0-9_-]{20,})\b/g,                       // Instagram tokens
  /(access_token|token|api[_-]?key|secret|password)(["'\s:=]+)([^\s"'&]+)/gi,
];

function redact(s) {
  let out = String(s);
  out = out.replace(SECRET_PATTERNS[0], '[REDACTED]').replace(SECRET_PATTERNS[1], '[REDACTED]');
  out = out.replace(SECRET_PATTERNS[2], (_, k, sep) => `${k}${sep}[REDACTED]`);
  return out;
}

let quiet = false;
module.exports = {
  setQuiet(v) { quiet = v; },
  info(msg) { if (!quiet) console.log(redact(msg)); },
  warn(msg) { if (!quiet) console.warn(redact(msg)); },
  redact,
};
