// A faster drop-in for makefun-site 1.0.0 (make.fun's own static site generator).
//
// run(input) returns exactly the output tree makefun-site 1.0.0's build returns
// for one case's { site, templates, files }: every page's index.html, the index
// and tag pages, build-report.txt and each static file, byte for byte.
//
// Written from the makefun-site README and its behaviour, as an independent
// implementation. Where speed matters it differs from the reference in method,
// never in result: front matter is scanned without splitting the whole source,
// Markdown is rendered in one pass without building a token list, slugs are
// cached per case, templates are compiled to plain JavaScript functions once
// per case (with a small tree-walking interpreter as fallback when code
// generation is unavailable), and output is gathered in arrays and joined
// once instead of concatenated string by string.

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** HTML escape table. */
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Scanner for the escape table's characters (shared; every use resets it). */
const SPC = /[&<>"']/g;

/** `s` with & < > " ' escaped; the input itself when it holds none of them. */
function esc(s) {
  SPC.lastIndex = 0;
  let m;
  let out = null;
  let last = 0;
  while ((m = SPC.exec(s)) !== null) {
    if (out === null) out = [];
    if (m.index > last) out.push(s.slice(last, m.index));
    out.push(ESC[m[0]]);
    last = m.index + 1;
  }
  if (out === null) return s;
  if (last < s.length) out.push(s.slice(last));
  SPC.lastIndex = 0;
  return out.join('');
}

/** The escaped form of s[a..b) pushed onto `out` (nothing pushed when empty). */
function escInto(out, s, a, b) {
  SPC.lastIndex = a;
  let last = a;
  let m;
  while ((m = SPC.exec(s)) !== null) {
    if (m.index >= b) break;
    if (m.index > last) out.push(s.slice(last, m.index));
    out.push(ESC[m[0]]);
    last = m.index + 1;
  }
  if (last < b) out.push(s.slice(last, b));
  SPC.lastIndex = 0;
}

/** Whether a UTF-16 code unit is whitespace in JavaScript's \s sense. */
function isWsCode(c) {
  return (
    c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 ||
    c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f ||
    c === 0x3000 || c === 0xfeff
  );
}

/** isWsCode, with the six ASCII whitespaces first: they decide nearly every character, and a rarer Unicode whitespace is checked only when the code is at least 0xa0. */
function isWsFast(c) {
  return c === 32 || c === 10 || c === 9 || c === 13 || c === 11 || c === 12 || (c >= 0xa0 && isWsCode(c));
}

/** The most characters a slug keeps before a collision suffix. */
const SLUG_MAX = 64;

/** The slug of `text`, exactly as makefun-site defines it (no cache here). */
function slugify(text) {
  let plain = text;
  // NFKD is the identity on ASCII, and ASCII holds no combining marks, so a
  // pure-ASCII string skips the (slow) normalisation and mark stripping.
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  if (!ascii) plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const c = plain.charCodeAt(i);
    let keep = -1;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === -1) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let i = 0;
  const len = text.length;
  while (i < len) {
    while (i < len && isWsFast(text.charCodeAt(i))) i++;
    if (i >= len) break;
    n++;
    while (i < len && !isWsFast(text.charCodeAt(i))) i++;
  }
  return n;
}

/** The directory of a path ('' at the root). */
const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `rel` (a link's path, "/"-separated) from the directory `dir`, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  const segs = rel.split('/');
  for (let k = 0; k < segs.length; k++) {
    const seg = segs[k];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

// ---------------------------------------------------------------- front matter

/** The keys a source's front matter may give. */
const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or a bare one. */
function stringOf(raw) {
  if (raw[0] === '"') {
    if (raw.length < 2 || raw[raw.length - 1] !== '"') return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) {
          return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        }
        out += n;
        i++;
      } else if (c === '"') {
        return { error: 'a quoted string holds a stray quote' };
      } else out += c;
    }
    return { value: out };
  }
  if (raw[0] === '[') return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** Whether `s` is all [a-z0-9-]. */
function isName(s) {
  if (s.length === 0) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return false;
  }
  return true;
}

/** Whether `s` is a slug: [a-z0-9] runs joined by single `-`, at most 64 long. */
function isSlug(s) {
  if (s.length === 0 || s.length > 64) return false;
  let prevDash = true; // a leading dash is refused, as a trailing one is
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 45) {
      if (prevDash) return false;
      prevDash = true;
    } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) {
      prevDash = false;
    } else return false;
  }
  return !prevDash;
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      // YYYY-MM-DD, a real day from 1970-01-01 to 2099-12-31.
      let ok = raw.length === 10 && raw[4] === '-' && raw[7] === '-';
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          const c = raw.charCodeAt(i);
          if (c < 48 || c > 57) { ok = false; break; }
        }
      }
      const y = ok ? Number(raw.slice(0, 4)) : 0;
      const mo = ok ? Number(raw.slice(5, 7)) : 0;
      const d = ok ? Number(raw.slice(8, 10)) : 0;
      if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',');
      for (let i = 0; i < tags.length; i++) {
        tags[i] = tags[i].trim();
        const t = tags[i];
        if (t === '') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        for (let j = 0; j < t.length; j++) {
          const c = t[j];
          if (c === '"' || c === '[' || c === ']') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return isName(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return isSlug(raw) ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. `text` has "\n" line ends. The front matter
 * region is found by scanning for the closing line, so the (usually long)
 * body is never split into lines.
 */
export function parseFrontMatter(text) {
  if (text.length < 3 || text[0] !== '-' || text[1] !== '-' || text[2] !== '-') return { error: 'no front matter' };
  if (text.length === 3) return { error: 'the front matter is not closed' };
  if (text[3] !== '\n') return { error: 'no front matter' };
  const idx = text.indexOf('\n---\n', 3);
  let closeEnd;
  let fmEnd;
  if (idx !== -1) {
    closeEnd = idx + 5;
    fmEnd = idx;
  } else if (text.endsWith('\n---')) {
    closeEnd = text.length;
    fmEnd = text.length - 4;
  } else {
    return { error: 'the front matter is not closed' };
  }
  const data = {};
  // The front matter's own lines only, numbered from 2 (line 1 is the opener).
  let pos = 4;
  let lineNo = 2;
  while (pos <= fmEnd) {
    let e = text.indexOf('\n', pos);
    if (e === -1 || e > fmEnd) e = fmEnd;
    const a = pos;
    const b = e;
    pos = e + 1;
    // Blank (spaces and tabs only) or a comment: skipped.
    let blank = true;
    for (let j = a; j < b; j++) {
      const c = text.charCodeAt(j);
      if (c !== 32 && c !== 9) { blank = false; break; }
    }
    if (blank || text[a] === '#') {
      lineNo++;
      if (e === fmEnd) break;
      continue;
    }
    // "key: value": a key of a-z and _, a colon, one space and the value.
    const ci = text.indexOf(':', a);
    if (ci === -1 || ci >= b) return { error: `line ${lineNo} is not "key: value"` };
    let keyOk = ci > a;
    for (let j = a; j < ci && keyOk; j++) {
      const c = text.charCodeAt(j);
      if (!((c >= 97 && c <= 122) || c === 95)) keyOk = false;
    }
    if (!keyOk) return { error: `line ${lineNo} is not "key: value"` };
    const key = text.slice(a, ci);
    let raw;
    if (ci + 1 === b) raw = '';
    else if (text[ci + 1] === ' ') raw = text.slice(ci + 2, b);
    else return { error: `line ${lineNo} is not "key: value"` };
    // The value's trailing spaces and tabs are dropped.
    let rEnd = raw.length;
    while (rEnd > 0) {
      const c = raw.charCodeAt(rEnd - 1);
      if (c !== 32 && c !== 9) break;
      rEnd--;
    }
    if (rEnd !== raw.length) raw = raw.slice(0, rEnd);
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
    lineNo++;
    if (e === fmEnd) break;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(closeEnd) };
}

// ---------------------------------------------------------------- Markdown

/** Whether s[a..b) holds only spaces and tabs (or nothing). */
function isBlank(s, a, b) {
  for (let j = a; j < b; j++) {
    const c = s.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** s[a..b) with spaces and tabs dropped at both ends, as [start, end). */
function trimRange(s, a, b) {
  while (a < b && (s.charCodeAt(a) === 32 || s.charCodeAt(a) === 9)) a++;
  while (b > a && (s.charCodeAt(b - 1) === 32 || s.charCodeAt(b - 1) === 9)) b--;
  return [a, b];
}

/** A fence's language when s[a..b) opens one, else null. */
function fenceLang(s, a, b) {
  if (b - a < 3 || s.charCodeAt(a) !== 96 || s.charCodeAt(a + 1) !== 96 || s.charCodeAt(a + 2) !== 96) return null;
  let j = a + 3;
  while (j < b) {
    const c = s.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) j++;
    else break;
  }
  const lang = s.slice(a + 3, j);
  while (j < b) {
    const c = s.charCodeAt(j);
    if (c !== 32 && c !== 9) return null;
    j++;
  }
  return lang;
}

/** Whether s[a..b) closes a fence: three backticks, spaces or tabs after. */
function isFenceClose(s, a, b) {
  if (b - a < 3 || s.charCodeAt(a) !== 96 || s.charCodeAt(a + 1) !== 96 || s.charCodeAt(a + 2) !== 96) return false;
  for (let j = a + 3; j < b; j++) {
    const c = s.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text range, or null (its text is never empty). */
function headingAt(s, a, b) {
  let j = a;
  let depth = 0;
  while (j < b && s.charCodeAt(j) === 35 && depth < 6) { j++; depth++; }
  if (depth === 0) return null;
  if (j >= b || (s.charCodeAt(j) !== 32 && s.charCodeAt(j) !== 9)) return null;
  while (j < b && (s.charCodeAt(j) === 32 || s.charCodeAt(j) === 9)) j++;
  let k = b;
  while (k > j && (s.charCodeAt(k - 1) === 32 || s.charCodeAt(k - 1) === 9)) k--;
  if (k <= j) return null;
  return { depth, a: j, b: k };
}

/** Whether s[a..b) is a thematic break: `---` or `***`, spaces or tabs after. */
function isHr(s, a, b) {
  if (b - a < 3) return false;
  const c = s.charCodeAt(a);
  if (c !== 45 && c !== 42) return false;
  if (s.charCodeAt(a + 1) !== c || s.charCodeAt(a + 2) !== c) return false;
  for (let j = a + 3; j < b; j++) {
    const cc = s.charCodeAt(j);
    if (cc !== 32 && cc !== 9) return false;
  }
  return true;
}

/** A bullet item's text start in s[a..b), or -1. */
function bulletAt(s, a, b) {
  if (b - a < 2) return -1;
  const c = s.charCodeAt(a);
  if ((c === 45 || c === 42) && s.charCodeAt(a + 1) === 32) return a + 2;
  return -1;
}

/** An ordered item's number and text start in s[a..b), or null. */
function orderedAt(s, a, b) {
  let j = a;
  let digits = 0;
  while (j < b && digits < 9) {
    const c = s.charCodeAt(j);
    if (c >= 48 && c <= 57) { j++; digits++; }
    else break;
  }
  if (digits === 0) return null;
  if (j + 1 < b && s.charCodeAt(j) === 46 && s.charCodeAt(j + 1) === 32) {
    return { num: Number(s.slice(a, j)), textStart: j + 2 };
  }
  return null;
}

/** Whether s[a..b) continues a list item: two or more spaces, then a non-space. */
function isContinued(s, a, b) {
  if (b - a < 3 || s.charCodeAt(a) !== 32 || s.charCodeAt(a + 1) !== 32) return false;
  let j = a + 2;
  while (j < b && s.charCodeAt(j) === 32) j++;
  return j < b && !isWsCode(s.charCodeAt(j));
}

/** Whether s[a..b) ends a paragraph: blank, a fence, a heading or a break. Only those four can start a line that ends one, so the first character decides which test can even apply. */
function endsParagraph(s, a, b) {
  if (a === b) return true;
  const c0 = s.charCodeAt(a);
  if (c0 === 32 || c0 === 9) return isBlank(s, a, b);
  if (c0 === 96) return fenceLang(s, a, b) !== null;
  if (c0 === 35) return headingAt(s, a, b) !== null;
  if (c0 === 45 || c0 === 42) return isHr(s, a, b);
  return false;
}

/** The characters a backslash escapes. */
const ESCAPABLES = '\\`*_[]()#+-.!>';
/** A link target holding whitespace (any of it). */
const WS_RE = /\s/;

/** The first index from `from` where s holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from, end) {
  const wlen = what.length;
  for (let j = from; j <= end - wlen; j++) {
    if (s[j] === '\\' && j + 1 < end && ESCAPABLES.indexOf(s[j + 1]) !== -1) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from, end) {
  for (let j = from; j < end; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < end && ESCAPABLES.indexOf(s[j + 1]) !== -1) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (j + 1 < end && s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** The characters inline rendering must stop at: escapes, code, emphasis, links, and the escape table's. */
const INLINE_RE = /[\\`*\[&<>"']/g;

/**
 * s[a..b) rendered inline, its pieces pushed onto `out`; `link` resolves
 * targets. The native scanner jumps from one interesting character to the
 * next, so long plain runs are copied whole instead of walked char by char;
 * the plain run between two stops holds no special character by construction.
 */
function inlineRange(s, a, b, link, out) {
  let i = a;
  let seg = a;
  for (;;) {
    INLINE_RE.lastIndex = i;
    const m = INLINE_RE.exec(s);
    if (m === null || m.index >= b) break;
    const j = m.index;
    const c = m[0];
    if (c === '&' || c === '<' || c === '>' || c === '"' || c === "'") {
      if (j > seg) out.push(s.slice(seg, j));
      out.push(ESC[c]);
      i = j + 1;
      seg = i;
      continue;
    }
    if (c === '\\') {
      if (j + 1 < b && ESCAPABLES.indexOf(s[j + 1]) !== -1) {
        if (j > seg) out.push(s.slice(seg, j));
        out.push(s[j + 1]);
        i = j + 2;
        seg = i;
      } else i = j + 1; // a lone backslash stays in the plain segment
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k !== -1 && k < b && k > j + 1) {
        if (j > seg) out.push(s.slice(seg, j));
        out.push('<code>');
        escInto(out, s, j + 1, k);
        out.push('</code>');
        i = k + 1;
        seg = i;
      } else i = j + 1;
      continue;
    }
    if (c === '*') {
      if (j + 1 < b && s[j + 1] === '*') {
        const k = findUnescaped(s, '**', j + 2, b);
        if (k !== -1 && k > j + 2) {
          if (j > seg) out.push(s.slice(seg, j));
          out.push('<strong>');
          inlineRange(s, j + 2, k, link, out);
          out.push('</strong>');
          i = k + 2;
          seg = i;
        } else i = j + 2;
        continue;
      }
      const k = findSingleStar(s, j + 1, b);
      if (k !== -1 && k > j + 1) {
        if (j > seg) out.push(s.slice(seg, j));
        out.push('<em>');
        inlineRange(s, j + 1, k, link, out);
        out.push('</em>');
        i = k + 1;
        seg = i;
      } else i = j + 1;
      continue;
    }
    // c === '[': a link, when its text and target both close and the target
    // holds no whitespace; otherwise the bracket is itself.
    const k = findUnescaped(s, ']', j + 1, b);
    let m2 = -1;
    if (k !== -1 && k + 1 < b && s[k + 1] === '(') m2 = s.indexOf(')', k + 2);
    if (m2 !== -1 && m2 < b) {
      const target = s.slice(k + 2, m2);
      if (target !== '' && !WS_RE.test(target)) {
        if (j > seg) out.push(s.slice(seg, j));
        out.push('<a href="');
        out.push(esc(link(target)));
        out.push('">');
        inlineRange(s, j + 1, k, link, out);
        out.push('</a>');
        i = m2 + 1;
        seg = i;
        continue;
      }
    }
    i = j + 1;
  }
  if (seg < b) out.push(s.slice(seg, b));
}

/** A list block starting at line `i`: its HTML and the next line's start. */
function listBlock(src, i, n, isOrdered, start, link) {
  const items = [];
  while (i <= n) {
    let e2 = src.indexOf('\n', i);
    if (e2 === -1) e2 = n;
    if (isOrdered) {
      const o = orderedAt(src, i, e2);
      if (o !== null) {
        const [ta, tb] = trimRange(src, o.textStart, e2);
        items.push(ta < tb ? src.slice(ta, tb) : '');
        i = e2 + 1;
        if (e2 === n) break;
        continue;
      }
    } else {
      const b0 = bulletAt(src, i, e2);
      if (b0 !== -1) {
        const [ta, tb] = trimRange(src, b0, e2);
        items.push(ta < tb ? src.slice(ta, tb) : '');
        i = e2 + 1;
        if (e2 === n) break;
        continue;
      }
    }
    if (isContinued(src, i, e2)) {
      const [ta, tb] = trimRange(src, i, e2);
      items[items.length - 1] += '\n' + src.slice(ta, tb);
      i = e2 + 1;
      if (e2 === n) break;
      continue;
    }
    break;
  }
  const tag = isOrdered ? 'ol' : 'ul';
  const open = isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
  const out = [`${open}\n`];
  for (const item of items) {
    out.push('<li>');
    inlineRange(item, 0, item.length, link, out);
    out.push('</li>\n');
  }
  out.push(`</${tag}>`);
  return [out.join(''), i];
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the
 * last), its table of contents and its excerpt. `link` resolves link targets;
 * `slug` is the case's cached slug function.
 */
export function renderMarkdown(src, link, slug) {
  const n = src.length;
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  while (i <= n) {
    let e = src.indexOf('\n', i);
    if (e === -1) e = n;
    if (e === i) {
      i = e + 1; // an empty line
      continue;
    }
    // The first character decides which block this line can even start, so
    // most lines are never scanned by tests they cannot pass.
    const c0 = src.charCodeAt(i);
    if (c0 === 32 || c0 === 9) {
      if (isBlank(src, i, e)) {
        i = e + 1;
        continue;
      }
      // An indented line is a paragraph line: fall through.
    } else if (c0 === 96) { // '`'
      const lang = fenceLang(src, i, e);
      if (lang !== null) {
        const parts = ['<pre><code'];
        if (lang !== '') {
          parts.push(' class="language-');
          parts.push(esc(lang));
          parts.push('"');
        }
        parts.push('>');
        i = e + 1;
        while (i <= n) {
          let e2 = src.indexOf('\n', i);
          if (e2 === -1) e2 = n;
          if (isFenceClose(src, i, e2)) {
            i = e2 + 1;
            break;
          }
          escInto(parts, src, i, e2);
          parts.push('\n');
          i = e2 + 1;
          if (e2 === n) break;
        }
        parts.push('</code></pre>');
        blocks.push(parts.join(''));
        continue;
      }
    } else if (c0 === 35) { // '#'
      const heading = headingAt(src, i, e);
      if (heading !== null) {
        const id = uniqueSlug(slug(src.slice(heading.a, heading.b)), ids);
        const out = [`<h${heading.depth} id="${id}">`];
        inlineRange(src, heading.a, heading.b, link, out);
        out.push(`</h${heading.depth}>`);
        blocks.push(out.join(''));
        if (heading.depth === 2 || heading.depth === 3) {
          toc.push({ level: heading.depth, id, html: out.slice(1, out.length - 1).join('') });
        }
        i = e + 1;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) { // '-' or '*'
      if (isHr(src, i, e)) {
        blocks.push('<hr>');
        i = e + 1;
        continue;
      }
      if (bulletAt(src, i, e) !== -1) {
        const [html, ni] = listBlock(src, i, n, false, 1, link);
        blocks.push(html);
        i = ni;
        continue;
      }
    } else if (c0 === 62) { // '>'
      const lines = [];
      while (i <= n) {
        let e2 = src.indexOf('\n', i);
        if (e2 === -1) e2 = n;
        if (src.charCodeAt(i) !== 62) break;
        let a = i + 1;
        if (a < e2 && src.charCodeAt(a) === 32) a++;
        const [ta, tb] = trimRange(src, a, e2);
        if (ta < tb) lines.push(src.slice(ta, tb));
        i = e2 + 1;
        if (e2 === n) break;
      }
      if (lines.length === 0) {
        blocks.push('<blockquote>\n</blockquote>');
      } else {
        const text = lines.join('\n');
        const out = ['<blockquote>\n<p>'];
        inlineRange(text, 0, text.length, link, out);
        out.push('</p>\n</blockquote>');
        blocks.push(out.join(''));
      }
      continue;
    } else if (c0 >= 48 && c0 <= 57) { // a digit
      const o = orderedAt(src, i, e);
      if (o !== null) {
        const [html, ni] = listBlock(src, i, n, true, o.num, link);
        blocks.push(html);
        i = ni;
        continue;
      }
    }
    // A paragraph: this line and the ones after it, up to a blank line, a
    // fence, a heading or a thematic break.
    const parts = [];
    let single = null; // [a, b) when the paragraph is one line: render in place
    {
      const [ta, tb] = trimRange(src, i, e);
      single = [ta, tb];
      i = e + 1;
    }
    while (i <= n) {
      let e2 = src.indexOf('\n', i);
      if (e2 === -1) e2 = n;
      if (endsParagraph(src, i, e2)) break;
      const [ta, tb] = trimRange(src, i, e2);
      if (single !== null) {
        parts.push(src.slice(single[0], single[1]));
        single = null;
      }
      parts.push(src.slice(ta, tb));
      i = e2 + 1;
      if (e2 === n) break;
    }
    let html;
    if (single !== null) {
      const out = ['<p>'];
      inlineRange(src, single[0], single[1], link, out);
      out.push('</p>');
      html = out.join('');
    } else {
      const text = parts.join('\n');
      const out = ['<p>'];
      inlineRange(text, 0, text.length, link, out);
      out.push('</p>');
      html = out.join('');
    }
    if (excerpt === null) excerpt = html.slice(3, -4);
    blocks.push(html);
  }
  return { html: blocks.map((b) => `${b}\n`).join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- Templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = isBlank(src, lineStart, open) && isBlank(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path`'s first name in the scope chain, or undefined. */
function lk1(S, name) {
  let s = S;
  while (s !== null) {
    if (Object.hasOwn(s.v, name)) return s.v[name];
    s = s.p;
  }
  return undefined;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lk(S, path) {
  let s = S;
  while (s !== null && !Object.hasOwn(s.v, path[0])) s = s.p;
  if (s === null) return undefined;
  let v = s.v[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function txt(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let s = '';
    for (let i = 0; i < v.length; i++) {
      if (i > 0) s += ', ';
      s += txt(v[i]);
    }
    return s;
  }
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

// ------------------------------------------------------- compiling templates

/** The lookup expression for `path` in scope variable `sv`. */
function lookupExpr(path, sv, ctx) {
  if (path.length === 1) return `L1(${sv},${JSON.stringify(path[0])})`;
  const key = path.join('.');
  let idx = ctx.paths.get(key);
  if (idx === undefined) {
    idx = ctx.paths.size;
    ctx.paths.set(key, idx);
  }
  return `L(${sv},P${idx})`;
}

/** JavaScript source rendering `nodes` in scope variable `sv`, pushing onto O. */
function genNodes(nodes, sv, ctx) {
  let s = '';
  for (const n of nodes) {
    if (n.kind === 'text') s += `O.push(${JSON.stringify(n.text)});`;
    else if (n.kind === 'var' || n.kind === 'raw') {
      const e = lookupExpr(n.path, sv, ctx);
      s += n.kind === 'var' ? `O.push(E(X(${e})));` : `O.push(X(${e}));`;
    } else if (n.kind === 'if') {
      const e = lookupExpr(n.path, sv, ctx);
      s += `if(Y(${e})${n.not ? '===false' : '!==false'}){${genNodes(n.then, sv, ctx)}}`;
      if (n.else !== null) s += `else{${genNodes(n.else, sv, ctx)}}`;
    } else if (n.kind === 'for') {
      const id = ctx.counter.n++;
      const e = lookupExpr(n.path, sv, ctx);
      const fv = `S${id}`;
      const kv = `k${id}`;
      const xv = `x${id}`;
      s += `{const ${xv}=${e};if(Array.isArray(${xv})){for(let ${kv}=0;${kv}<${xv}.length;${kv}++){const ${fv}={v:{[${JSON.stringify(n.name)}]:${xv}[${kv}],loop:{index:${kv}+1,first:${kv}===0,last:${kv}===${xv}.length-1,length:${xv}.length}},p:${sv}};${genNodes(n.body, fv, ctx)}}}}`;
    } else if (n.kind === 'include') {
      const id = ctx.counter.n++;
      s += `if(D<${INCLUDE_DEPTH}){const t${id}=T[${JSON.stringify(n.name)}];if(t${id}!==undefined)t${id}(${sv},O,D+1);}`;
    }
  }
  return s;
}

/**
 * All parsed templates compiled at once into functions (S, O, D) on the
 * templates object T, which they close over for includes. Returns the object
 * of functions, or throws when code generation is unavailable.
 */
function compileAll(T, parsed) {
  const ctx = { paths: new Map(), counter: { n: 0 } };
  const bodies = [];
  for (const [name, nodes] of parsed) {
    bodies.push(`${JSON.stringify(name)}:function(S,O,D){${genNodes(nodes, 'S', ctx)}}`);
  }
  let decls = '';
  for (const [key, idx] of ctx.paths) decls += `const P${idx}=${JSON.stringify(key.split('.'))};`;
  const src = `"use strict";${decls}return {${bodies.join(',')}};`;
  const factory = new Function('T', 'E', 'X', 'L1', 'L', 'Y', src);
  return factory(T, esc, txt, lk1, lk, truthy);
}

// ------------------------------------------------- the tree-walking fallback

/** `nodes` rendered in `scope` ({ v, p }), its pieces pushed onto `out`. */
function renderNodes(nodes, scope, parsed, depth, out) {
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        out.push(esc(txt(lk(scope, n.path))));
        break;
      case 'raw':
        out.push(txt(lk(scope, n.path)));
        break;
      case 'if': {
        const v = truthy(lk(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, parsed, depth, out);
        break;
      }
      case 'for': {
        const xs = lk(scope, n.path);
        if (!Array.isArray(xs)) break;
        for (let k = 0; k < xs.length; k++) {
          renderNodes(n.body, { v: { [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } }, p: scope }, parsed, depth, out);
        }
        break;
      }
      case 'include': {
        const t = parsed.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, scope, parsed, depth + 1, out);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- the build

/** A page's link record as templates read it. */
const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

/** One site's output tree: path -> text. */
export function run(input) {
  // Slugs are cached for this case alone: titles and tags repeat a lot.
  const slugCache = new Map();
  const slug = (t) => {
    let s = slugCache.get(t);
    if (s === undefined) {
      s = slugify(t);
      slugCache.set(t, s);
    }
    return s;
  };

  // 1. Templates, parsed in code-unit order of their name; one that does not
  // parse is reported and left out. Then compiled, once, for this case.
  const report = [];
  const parsed = new Map();
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      parsed.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const T = {};
  let compiled = null;
  try {
    compiled = compileAll(T, parsed);
    Object.assign(T, compiled);
  } catch {
    compiled = null;
  }

  // 2. The sources, in code-unit order of their paths, line ends made "\n".
  const files = [...input.files].sort((a, b) => byCodeUnits(a.path, b.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      sources.push({ path: f.path, text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n') });
    } else statics.push({ path: f.path, content: f.content });
  }

  // 3. Each source's front matter, in that order: a refused source is
  // reported and dropped, and so is a draft. The checks run in order, and
  // the first one that fails is the one reported.
  const kept = [];
  const bySource = new Map();
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!parsed.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 4. Each page's output directory and url: its slug made unique in its
  // directory, in source order.
  const base = input.site.base_url.replace(/\/+$/, '');
  const taken = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? ['posts', 'tags', 'page'] : []);
      taken.set(dir, set);
    }
    s.slug = uniqueSlug(s.data.slug !== undefined ? s.data.slug : slug(s.data.title), set);
    s.outDir = dir === '' ? s.slug : `${dir}/${s.slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 5. Each body's Markdown, its links resolved to the pages and static
  // files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  const schemeRe = /^[A-Za-z][A-Za-z0-9+.-]*:/;
  for (const s of kept) {
    const dir = dirOf(s.path);
    const link = (target) => {
      if (schemeRe.test(target) || target[0] === '/' || target[0] === '#') return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
      if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.body, link, slug);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.reading = Math.max(1, Math.ceil(wordsOf(s.body) / 200));
  }

  // 6. The posts, newest first and then by slug; each post's neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 7. The tags: grouped by their slug, each named as first met in the
  // posts' order, ordered by count and then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const sl = slug(name);
      if (!seen.has(sl)) {
        seen.add(sl);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const sl = slug(name);
      let tag = bySlug.get(sl);
      if (tag === undefined) {
        tag = { name, slug: sl, url: `${base}/tags/${sl}/`, posts: [] };
        bySlug.set(sl, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const sl = slug(name);
        return bySlug.get(sl) ?? { name, slug: sl, url: '', posts: [] };
      });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 8. Every page through its layout, the index pages and the tag pages
  // through theirs, then each static file at its own path.
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: s.reading,
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const output = {};
  const render = (name, vars) => {
    const scope = { v: { site, tags: allTags, recent, ...vars }, p: null };
    if (compiled !== null) {
      const fn = compiled[name];
      if (fn === undefined) return null;
      const O = [];
      fn(scope, O, 0);
      return O.join('');
    }
    const nodes = parsed.get(name);
    if (nodes === undefined) return null;
    const O = [];
    renderNodes(nodes, scope, parsed, 0, O);
    return O.join('');
  };
  const pageOf = (s) => ({
    ...cardOf(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 9. The report: every refusal, draft, broken link and template that did
  // not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pagesCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pagesCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
