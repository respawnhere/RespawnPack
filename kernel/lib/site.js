/*
 * RespawnPack · kernel/lib/site.js — render a repository's own markdown the way it was meant to be read.
 *
 * ⛔ WHY A RENDERER IN THE PACK AND NOT A DEPENDENCY. Owner decision 20
 * (owner decision 20): the rework runs unattended, and downloading or
 * vendoring a markdown library is an action the owner approves, not one a builder takes on its own. So
 * the subset below is written here and fenced by goldens taken from every project archetype the pack
 * knows. The interface is ONE function on purpose: if the owner later prefers `marked` (MIT), the swap
 * is local to `renderMarkdown` and nothing else in the pack has to move.
 *
 * ⛔ THE SAFETY PROPERTY THIS FILE OWES THE REST OF THE SITE. Raw HTML in a source document is ESCAPED,
 * never passed through. A `<script>` in a tracked document becomes text and is displayed, not executed;
 * a link whose destination carries a scheme outside the allow list is not made into a link at all, it is
 * left as the escaped text a reader can see and judge. The site verb (task O-4b) serves this output on
 * loopback, so "no source document can inject markup into the page" is the property its server rests on,
 * and it is a property of THIS function rather than of a sanitiser bolted on afterwards.
 *
 * ⛔ NOTHING IS DROPPED. Every construct the subset does not model is rendered as escaped paragraph
 * text: a reference link, a footnote, an HTML block, a directive syntax borrowed from another tool. A
 * renderer that silently swallows what it does not understand produces a document that says less than
 * its source, which is DF-011's shape (see `kernel/lib/render.js`'s header) applied to prose. The one
 * deliberate exception is the HTML comment, which markdown authors already expect to be invisible.
 *
 * ⛔ DETERMINISM IS A REQUIREMENT. This module reads no file, no clock, no environment and no random
 * source. The same input yields the same bytes in this process and in the next one, which is what makes
 * a golden a fence rather than a snapshot to be re-blessed on every run, and what lets O-4b claim a
 * rebuild is byte-identical. Nothing it emits carries an absolute path or a timestamp.
 *
 * ⛔ THE PACK'S OWN MARKERS ARE READ FROM `render.js`, NEVER RETYPED (anti-drift item 7). `GEN_OPEN`,
 * `GEN_CLOSE`, `NOTE_OPEN` and `NOTE_CLOSE` are imported below and the `data-marker` name is parsed out
 * of the imported constant, so a marker whose spelling changes in `render.js` changes here with it or
 * fails loudly at load. A generated block this renderer failed to recognise would reach the page as an
 * ordinary comment plus loose prose, i.e. a reader would not be told which half of the document a human
 * may edit — the exact distinction those markers exist to draw.
 *
 * ⛔ `renderMarkdown` READS TEXT AND RETURNS TEXT (anti-drift item 53's premise). It opens no file, takes
 * no output directory and knows nothing about a page. Everything with a path or a socket in it lives
 * BELOW the "THE SITE" banner further down: `buildSite`, which turns a repository's documents into a
 * directory of pages, and `serve`, which puts that directory on the loopback interface. The split is
 * what lets the goldens fence the exact bytes the build writes, and it is why this half must stay
 * callable with a string and nothing else.
 *
 * API:
 *   renderMarkdown(text, opts = {}) → { html, title, headings }
 *     opts.linkRewrite  default true; rewrites RELATIVE `.md` links to `.html` (query and fragment
 *                       preserved) and leaves absolute URLs (any scheme, and protocol-relative `//`)
 *                       exactly as written.
 *     html              block-level HTML, no document wrapper — O-4b supplies <html>, <head> and CSS.
 *     title             the first H1's plain text, or null when the document has no H1.
 *     headings          [{ level, id, text }] in document order, ids matching the anchors in `html`.
 *
 * THE SUBSET, and where it knowingly departs from CommonMark. Departures are listed because an
 * undocumented departure is a bug report waiting to be filed twice:
 *   · ATX headings 1-6 (up to three spaces of indent, optional closing #s) with slug anchors. SETEXT
 *     headings are NOT modelled, so a line of `---` under a paragraph is a thematic break.
 *   · Paragraphs, with hard breaks from two or more trailing spaces or a trailing backslash.
 *   · Emphasis and strong with `*`, `_`, `**`, `__`. `_` will not open or close inside a word, so
 *     `snake_case_name` is left alone. The delimiter matcher is a forward scan, not CommonMark's
 *     delimiter stack: it nests correctly (`*a **b** c*`) but a few pathological runs differ.
 *   · Inline code with any backtick run length; links and images with an optional title; autolinks in
 *     angle brackets. Reference links (`[a][b]`) are NOT modelled and render as escaped text.
 *   · Ordered and unordered lists nesting by indentation, task-list items, blockquotes with lazy
 *     paragraph continuation, thematic breaks.
 *   · Fenced code, backtick and tilde, any fence length; the info string's FIRST word becomes
 *     `class="language-<x>"` on the `<code>`; contents are escaped and never highlighted. Indented code
 *     blocks (four spaces at a block start).
 *   · GFM tables with per-column alignment and `\|` inside a cell. Cell counts are padded or truncated
 *     to the header's, as GFM does.
 *   · HTML comments are dropped; an UNTERMINATED comment is escaped text, so nothing is lost.
 *   · Mermaid fences render for a browser AND for a reader with no browser (see `diagram` below).
 *   · Character entities are NOT decoded: `&amp;` in the source is text meaning "&amp;", and every `&`
 *     is escaped. This is deliberate. Decoding entities would give a document one more way to spell
 *     `<script>`, and the safety property above is worth more than round-tripping an entity.
 *   · Tabs are expanded to four spaces before parsing, so indentation is counted in spaces everywhere.
 *   · A list renders the same whether CommonMark would call it tight or loose: an item that holds one
 *     paragraph puts that text straight in the `<li>`, and an item that holds several blocks renders
 *     them as blocks. Nothing is lost either way, and the reader is spared a `<p>` per bullet.
 */
const { GEN_OPEN, GEN_CLOSE, NOTE_OPEN, NOTE_CLOSE } = require('./render.js');

/*
 * The name that lands in `data-marker`, parsed out of render.js's own constant rather than typed here.
 * Throwing at load is deliberate: a marker whose shape changed is a change to the one contract
 * anti-drift item 7 names, and it should stop this module rather than quietly render a generated block
 * as loose prose.
 */
function markerName(open) {
  const m = /<!--\s*(RESPAWNPACK:[A-Z]+)\b/.exec(String(open));
  if (!m) {
    throw new Error(`kernel/lib/site.js: ${JSON.stringify(String(open))} came from kernel/lib/render.js `
      + 'but is not the "<!-- RESPAWNPACK:NAME ... -->" shape this renderer recognises — re-aim the marker '
      + 'parser here rather than retyping the constant, which anti-drift item 7 forbids');
  }
  return m[1];
}

const MARKERS = [
  { open: GEN_OPEN, close: GEN_CLOSE, cls: 'generated', name: markerName(GEN_OPEN) },
  { open: NOTE_OPEN, close: NOTE_CLOSE, cls: 'note', name: markerName(NOTE_OPEN) },
];

// --- escaping ---------------------------------------------------------------------------------------

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };

/**
 * Text and attribute escaping, ONE function for both so no call site can pick the weaker one. The
 * apostrophe is deliberately not escaped: every attribute this module emits is double-quoted and `"`
 * is escaped, so `'` cannot end one, and leaving it alone keeps a page of English prose readable in
 * the goldens a reviewer actually has to read.
 */
function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ESCAPES[c]);
}

/** The inverse of `esc`, used only to recover a heading's plain text from its own rendered HTML. */
function unesc(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

// --- URLs -------------------------------------------------------------------------------------------

/*
 * ⛔ THE SCHEME ALLOW LIST IS THE OTHER HALF OF THE SAFETY PROPERTY. Escaping raw HTML closes the
 * `<script>` door; it does not close `[click me](javascript:...)`, which is markdown the subset
 * otherwise models perfectly. A destination whose scheme is not on this list is refused, and the
 * refusal is NOT a deletion: the link is simply not treated as a link, so its whole source lands in the
 * page as escaped text. Control characters are stripped first, because a tab inside `java script:` is
 * the same attack wearing a disguise browsers are happy to remove for it.
 */
const SAFE_SCHEMES = /^(?:https?|mailto|ftps?|tel):/i;
const HAS_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const DEL = 127;
const SPACE = 32;

/** Drop every C0 control character and DEL. Written as a loop so this file contains none of them. */
function stripControl(s) {
  let out = '';
  for (const ch of String(s)) {
    const code = ch.codePointAt(0);
    if (code < SPACE || code === DEL) continue;
    out += ch;
  }
  return out;
}

function safeUrl(raw) {
  const u = stripControl(raw).trim();
  if (!u) return '';
  if (HAS_SCHEME.test(u) && !SAFE_SCHEMES.test(u)) return null;
  return u;
}

/**
 * Relative `.md` becomes `.html`; the query and fragment ride along untouched. An absolute URL (any
 * scheme) and a protocol-relative `//host/x.md` are left exactly as written: they point at somebody
 * else's site, where the pack has no idea what is published under what name. A root-relative
 * `/docs/x.md` IS rewritten — it is the same site, just addressed from its root.
 */
function rewriteMdTarget(url) {
  if (HAS_SCHEME.test(url) || url.startsWith('//')) return url;
  const m = /^([^?#]*)([\s\S]*)$/.exec(url);
  const pathPart = m[1];
  if (!/\.md$/i.test(pathPart)) return url;
  return `${pathPart.slice(0, -3)}.html${m[2]}`;
}

// --- slugs ------------------------------------------------------------------------------------------

/*
 * Lowercase, drop everything that is not a letter, a number, a space or a hyphen, collapse the rest to
 * single hyphens. Emoji and punctuation vanish, which is what makes `## 🛑 Active constraints — ...`
 * (a heading render.js really emits) produce a readable anchor. A repeated slug takes `-1`, `-2`, so
 * two `## Notes` headings in one document still get distinct, stable, order-dependent ids.
 */
function slugify(text, used) {
  let base = String(text).toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/[\s-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!base) base = 'section';
  const seen = used.get(base);
  if (seen === undefined) {
    used.set(base, 0);
    return base;
  }
  const next = seen + 1;
  used.set(base, next);
  return `${base}-${next}`;
}

// --- inline ------------------------------------------------------------------------------------------

const PUNCTUATION = /[!-/:-@[-`{-~]/;

/** Length of the run of `ch` starting at `i`. */
function runLength(src, i, ch) {
  let n = 0;
  while (src[i + n] === ch) n += 1;
  return n;
}

/** A code span at `i`, or null. Returns { html, end } with `end` one past the closing run. */
function codeSpan(src, i) {
  const ticks = runLength(src, i, '`');
  let j = i + ticks;
  while (j < src.length) {
    if (src[j] === '`') {
      const run = runLength(src, j, '`');
      if (run === ticks) {
        let content = src.slice(i + ticks, j);
        // CommonMark's one-space strip, which is how a span holds a leading or trailing backtick.
        if (content.length > 2 && content.startsWith(' ') && content.endsWith(' ') && content.trim() !== '') {
          content = content.slice(1, -1);
        }
        return { html: `<code>${esc(content)}</code>`, end: j + run };
      }
      j += run;
      continue;
    }
    j += 1;
  }
  return null;
}

/** The index of the `]` matching the `[` at `open`, or -1. Nested brackets, escapes and code count. */
function matchBracket(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '\\') { i += 1; continue; }
    if (ch === '`') {
      const span = codeSpan(src, i);
      if (span) { i = span.end - 1; continue; }
    }
    if (ch === '[') depth += 1;
    else if (ch === ']') { depth -= 1; if (depth === 0) return i; }
  }
  return -1;
}

/**
 * The `(dest "title")` half of a link, starting at `open` (which must be `(`), or null.
 * Parentheses inside the destination are allowed as long as they balance, which is what makes
 * `[x](https://en.wikipedia.org/wiki/Foo_(bar))` a link rather than three quarters of one.
 */
function linkTarget(src, open) {
  let i = open + 1;
  while (src[i] === ' ') i += 1;
  let dest = '';
  if (src[i] === '<') {
    const close = src.indexOf('>', i + 1);
    if (close === -1) return null;
    dest = src.slice(i + 1, close);
    i = close + 1;
  } else {
    let depth = 0;
    while (i < src.length) {
      const ch = src[i];
      if (ch === '\\' && i + 1 < src.length) { dest += src[i + 1]; i += 2; continue; }
      if (ch === ' ' && depth === 0) break;
      if (ch === '(') depth += 1;
      if (ch === ')') { if (depth === 0) break; depth -= 1; }
      dest += ch;
      i += 1;
    }
  }
  while (src[i] === ' ') i += 1;
  let title = null;
  const quote = src[i];
  if (quote === '"' || quote === "'" || quote === '(') {
    const closer = quote === '(' ? ')' : quote;
    let j = i + 1;
    let buf = '';
    while (j < src.length && src[j] !== closer) {
      if (src[j] === '\\' && j + 1 < src.length) { buf += src[j + 1]; j += 2; continue; }
      buf += src[j];
      j += 1;
    }
    if (src[j] !== closer) return null;
    title = buf;
    i = j + 1;
    while (src[i] === ' ') i += 1;
  }
  if (src[i] !== ')') return null;
  return { dest, title, end: i + 1 };
}

/*
 * Emphasis without a delimiter stack. At an opening run we scan forward; a run met on the way is either
 * a closer for us, or an opener of its own whose match we skip past (which is what keeps `*a **b** c*`
 * from closing the outer emphasis on the inner one), or ordinary text. `_` additionally refuses to open
 * or close against an alphanumeric neighbour, so identifiers survive being written in prose.
 */
function isAlnum(ch) {
  return ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
}

function flanking(src, i, ch, run) {
  const before = i > 0 ? src[i - 1] : undefined;
  const after = src[i + run];
  const canOpen = after !== undefined && !/\s/.test(after) && (ch !== '_' || !isAlnum(before));
  const canClose = before !== undefined && !/\s/.test(before) && (ch !== '_' || !isAlnum(after));
  return { canOpen, canClose };
}

/** The index of the delimiter run that closes an emphasis opened at `start`, or -1. */
function findEmphasisClose(src, start, ch, use) {
  let i = start;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '`') {
      const span = codeSpan(src, i);
      if (span) { i = span.end; continue; }
    }
    if (c !== ch) { i += 1; continue; }
    const run = runLength(src, i, ch);
    const flank = flanking(src, i, ch, run);
    if (flank.canClose && run >= use) return i;
    if (flank.canOpen) {
      const innerUse = Math.min(run, 2);
      const inner = findEmphasisClose(src, i + innerUse, ch, innerUse);
      if (inner !== -1) { i = inner + runLength(src, inner, ch); continue; }
    }
    i += run;
  }
  return -1;
}

/**
 * One line (or one cell, or one heading) of markdown to HTML. Called per line so that a paragraph's
 * hard breaks stay a property of the paragraph rather than something this scanner has to guess at.
 */
function inline(src, ctx) {
  const s = String(src);
  let out = '';
  let i = 0;
  while (i < s.length) {
    const ch = s[i];

    if (ch === '\\') {
      const next = s[i + 1];
      if (next !== undefined && PUNCTUATION.test(next)) { out += esc(next); i += 2; continue; }
      out += esc(ch);
      i += 1;
      continue;
    }

    if (ch === '`') {
      const span = codeSpan(s, i);
      if (span) { out += span.html; i = span.end; continue; }
      out += esc(ch);
      i += 1;
      continue;
    }

    if (ch === '<') {
      // An inline HTML comment is dropped, exactly as a block-level one is. An UNTERMINATED one is not:
      // it falls through and is escaped, so the text a reader would otherwise lose stays on the page.
      if (s.startsWith('<!--', i)) {
        const close = s.indexOf('-->', i + 4);
        if (close !== -1) { i = close + 3; continue; }
      }
      const auto = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^<>\s]*)>/.exec(s.slice(i));
      if (auto) {
        const href = safeUrl(auto[1]);
        if (href) { out += `<a href="${esc(href)}">${esc(auto[1])}</a>`; i += auto[0].length; continue; }
      }
      const mail = /^<([^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)>/.exec(s.slice(i));
      if (mail) {
        out += `<a href="${esc(`mailto:${mail[1]}`)}">${esc(mail[1])}</a>`;
        i += mail[0].length;
        continue;
      }
      // Everything else that looks like a tag is TEXT. This is the line the site's safety rests on.
      out += esc(ch);
      i += 1;
      continue;
    }

    if (ch === '!' && s[i + 1] === '[') {
      const close = matchBracket(s, i + 1);
      if (close !== -1 && s[close + 1] === '(') {
        const target = linkTarget(s, close + 1);
        if (target) {
          const source = safeUrl(target.dest);
          if (source !== null) {
            const alt = unesc(inline(s.slice(i + 2, close), ctx).replace(/<[^>]*>/g, ''));
            const title = target.title === null ? '' : ` title="${esc(target.title)}"`;
            out += `<img src="${esc(source)}" alt="${esc(alt)}"${title} />`;
            i = target.end;
            continue;
          }
        }
      }
      out += esc(ch);
      i += 1;
      continue;
    }

    if (ch === '[') {
      const close = matchBracket(s, i);
      if (close !== -1 && s[close + 1] === '(') {
        const target = linkTarget(s, close + 1);
        if (target) {
          const safe = safeUrl(target.dest);
          if (safe !== null) {
            const href = ctx.linkRewrite ? rewriteMdTarget(safe) : safe;
            const title = target.title === null ? '' : ` title="${esc(target.title)}"`;
            out += `<a href="${esc(href)}"${title}>${inline(s.slice(i + 1, close), ctx)}</a>`;
            i = target.end;
            continue;
          }
        }
      }
      out += esc(ch);
      i += 1;
      continue;
    }

    if (ch === '*' || ch === '_') {
      const run = runLength(s, i, ch);
      const use = run >= 2 ? 2 : 1;
      if (flanking(s, i, ch, run).canOpen) {
        const close = findEmphasisClose(s, i + use, ch, use);
        if (close !== -1) {
          const closeRun = runLength(s, close, ch);
          const contentEnd = close + closeRun - use;
          if (contentEnd > i + use) {
            const tag = use === 2 ? 'strong' : 'em';
            out += `<${tag}>${inline(s.slice(i + use, contentEnd), ctx)}</${tag}>`;
            i = close + closeRun;
            continue;
          }
        }
      }
      out += esc(s.slice(i, i + run));
      i += run;
      continue;
    }

    out += esc(ch);
    i += 1;
  }
  return out;
}

/** A heading's or a title's plain text: the real inline render with its tags and escapes removed. */
function plainOf(src, ctx) {
  return unesc(inline(src, ctx).replace(/<[^>]*>/g, '')).trim();
}

// --- block-level recognisers --------------------------------------------------------------------------

const RE_ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const RE_FENCE = /^( {0,3})(`{3,}|~{3,})[ \t]*(.*)$/;
const RE_HR = /^ {0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/;
const RE_QUOTE = /^ {0,3}>/;
const RE_LIST = /^( {0,3})([-*+]|\d{1,9}[.)])(?:([ \t]+)(.*)|[ \t]*$)/;
const RE_COMMENT = /^ {0,3}<!--/;
const RE_INDENT_CODE = /^ {4,}\S/;
const RE_TABLE_DELIM = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const TASK_ITEM = /^\[([ xX])\](?:[ \t]+(.*))?$/;

function markerAt(line) {
  const t = line.trim();
  return MARKERS.find((m) => m.open === t) || null;
}

/** Cells of one table row, with `\|` kept as a literal pipe inside the cell it belongs to. */
function tableCells(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] === '\\' && s[i + 1] === '|') { cur += '|'; i += 1; continue; }
    if (s[i] === '|') { cells.push(cur.trim()); cur = ''; continue; }
    cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}

function isTableStart(lines, i) {
  const head = lines[i];
  const delim = lines[i + 1];
  if (head === undefined || delim === undefined) return false;
  if (!head.includes('|') || !delim.includes('-')) return false;
  if (!RE_TABLE_DELIM.test(delim)) return false;
  const width = tableCells(head).length;
  return width > 0 && width === tableCells(delim).length;
}

/** Would line `i` begin a new block? Used to end a paragraph without swallowing what follows it. */
function startsBlock(lines, i) {
  const line = lines[i];
  if (line === undefined) return true;
  if (!line.trim()) return true;
  if (markerAt(line)) return true;
  if (RE_COMMENT.test(line)) return true;
  if (RE_FENCE.test(line)) return true;
  if (RE_ATX.test(line)) return true;
  if (RE_HR.test(line)) return true;
  if (RE_QUOTE.test(line)) return true;
  if (RE_LIST.test(line)) return true;
  if (isTableStart(lines, i)) return true;
  return false;
}

// --- block-level rendering ---------------------------------------------------------------------------

function codeBlock(content, lang) {
  const body = content === '' ? '' : `${esc(content)}\n`;
  const cls = lang ? ` class="language-${esc(lang)}"` : '';
  return `<pre><code${cls}>${body}</code></pre>`;
}

/*
 * ⛔ A DIAGRAM MUST SURVIVE BOTH READERS. A `<pre class="mermaid">` alone is a blank rectangle to anyone
 * reading the built site offline, from a terminal browser, or out of the repository itself; a `<pre>` of
 * source alone throws the picture away for everyone else. So a Mermaid fence renders BOTH: the block the
 * viewer's browser turns into a diagram, and a collapsed `<details>` holding the same source, escaped.
 * O-4b pins the Mermaid script and supplies the `<noscript>` note; this function is what makes sure that
 * even when that script never loads, nothing about the document was lost.
 */
function diagram(source) {
  const src = esc(source);
  return `<div class="diagram"><pre class="mermaid">${src}</pre>`
    + `<details><summary>diagram source</summary><pre><code>${src}</code></pre></details></div>`;
}

function heading(level, raw, ctx) {
  const text = plainOf(raw, ctx);
  const id = slugify(text, ctx.slugs);
  ctx.headings.push({ level, id, text });
  if (ctx.title === null && level === 1 && text) ctx.title = text;
  return `<h${level} id="${esc(id)}">${inline(raw, ctx)}</h${level}>`;
}

function paragraph(ls, ctx) {
  const parts = [];
  for (let k = 0; k < ls.length; k += 1) {
    let line = k === 0 ? ls[k] : ls[k].replace(/^ +/, '');
    let br = false;
    if (k < ls.length - 1) {
      if (/ {2,}$/.test(line)) { br = true; }
      else if (/(?:^|[^\\])\\$/.test(line)) { br = true; line = line.slice(0, -1); }
    }
    parts.push(inline(line.replace(/\s+$/, ''), ctx) + (br ? '<br />' : ''));
  }
  return `<p>${parts.join('\n')}</p>`;
}

function table(lines, start, ctx) {
  const header = tableCells(lines[start]);
  const aligns = tableCells(lines[start + 1]).map((c) => {
    const left = c.startsWith(':');
    const right = c.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    if (left) return 'left';
    return null;
  });
  let i = start + 2;
  const rows = [];
  while (i < lines.length && lines[i].includes('|') && !startsBlock(lines, i)) {
    rows.push(tableCells(lines[i]));
    i += 1;
  }
  const cell = (tag, text, k) => {
    const a = aligns[k] ? ` style="text-align:${aligns[k]}"` : '';
    return `<${tag}${a}>${inline(text, ctx)}</${tag}>`;
  };
  const out = ['<table>', '<thead>'];
  out.push(`<tr>${header.map((c, k) => cell('th', c, k)).join('')}</tr>`);
  out.push('</thead>');
  if (rows.length) {
    out.push('<tbody>');
    for (const row of rows) {
      // GFM's own rule: a short row is padded and a long one truncated, so the table stays rectangular.
      const cells = header.map((_, k) => (row[k] === undefined ? '' : row[k]));
      out.push(`<tr>${cells.map((c, k) => cell('td', c, k)).join('')}</tr>`);
    }
    out.push('</tbody>');
  }
  out.push('</table>');
  return { html: out.join('\n'), end: i };
}

function listItemHtml(itemLines, ctx) {
  let lines = itemLines;
  let task = null;
  const m = TASK_ITEM.exec(lines[0] === undefined ? '' : lines[0]);
  if (m) {
    task = m[1] !== ' ';
    lines = [m[2] === undefined ? '' : m[2], ...lines.slice(1)];
  }
  const parts = blockParts(lines, ctx);
  let lead = '';
  if (parts.length && /^<p>[\s\S]*<\/p>$/.test(parts[0])) lead = parts.shift().slice(3, -4);
  const box = task === null ? '' : `<input type="checkbox" disabled${task ? ' checked' : ''} /> `;
  const attr = task === null ? '' : ' class="task-list-item"';
  if (!parts.length) return `<li${attr}>${box}${lead}</li>`;
  return `<li${attr}>${box}${lead}\n${parts.join('\n')}\n</li>`;
}

function indentOf(line) {
  return line.length - line.replace(/^ +/, '').length;
}

function list(lines, start, ctx) {
  const open = RE_LIST.exec(lines[start]);
  const baseIndent = open[1].length;
  const marker = open[2];
  const ordered = /\d/.test(marker);
  const delim = marker[marker.length - 1];
  const items = [];
  let i = start;
  let end = start;

  while (i < lines.length) {
    // Blank lines between items keep the list together; they only end it when what follows is not a
    // sibling item. Without this a list with air between its bullets became several one-item lists.
    let scan = i;
    while (scan < lines.length && !lines[scan].trim()) scan += 1;
    const head = scan < lines.length ? RE_LIST.exec(lines[scan]) : null;
    if (!head || head[1].length !== baseIndent) break;
    const headMarker = head[2];
    const headOrdered = /\d/.test(headMarker);
    // A change of marker family, or of bullet character, starts a NEW list — CommonMark's rule, and the
    // only way a document can deliberately put two lists next to each other.
    if (headOrdered !== ordered) break;
    if (!ordered && headMarker !== marker) break;
    if (ordered && headMarker[headMarker.length - 1] !== delim) break;
    i = scan;

    const gap = head[3] === undefined ? 1 : head[3].length;
    const contentIndent = baseIndent + headMarker.length + gap;
    const itemLines = [head[4] === undefined ? '' : head[4]];
    i += 1;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) {
        let j = i;
        while (j < lines.length && !lines[j].trim()) j += 1;
        if (j >= lines.length || indentOf(lines[j]) < contentIndent) break;
        for (let k = i; k < j; k += 1) itemLines.push('');
        i = j;
        continue;
      }
      if (indentOf(line) >= contentIndent) { itemLines.push(line.slice(contentIndent)); i += 1; continue; }
      // Lazy continuation: a wrapped paragraph line that starts no block of its own stays in the item.
      if (itemLines.length && itemLines[itemLines.length - 1].trim() && !startsBlock(lines, i)) {
        itemLines.push(line.replace(/^ +/, ''));
        i += 1;
        continue;
      }
      break;
    }
    while (itemLines.length && !itemLines[itemLines.length - 1].trim()) itemLines.pop();
    items.push(listItemHtml(itemLines, ctx));
    end = i;
  }

  const tag = ordered ? 'ol' : 'ul';
  const first = ordered ? /^\d+/.exec(marker)[0] : '1';
  const startAttr = first !== '1' ? ` start="${esc(first)}"` : '';
  return { html: [`<${tag}${startAttr}>`, ...items, `</${tag}>`].join('\n'), end };
}

function blockquote(lines, start, ctx) {
  const inner = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (RE_QUOTE.test(line)) {
      inner.push(line.replace(/^ {0,3}> ?/, ''));
      i += 1;
      continue;
    }
    if (!line.trim()) break;
    // Lazy continuation, the same rule a paragraph inside a list item gets.
    if (inner.length && inner[inner.length - 1].trim() && !startsBlock(lines, i)) {
      inner.push(line);
      i += 1;
      continue;
    }
    break;
  }
  return { html: `<blockquote>\n${blockParts(inner, ctx).join('\n')}\n</blockquote>`, end: i };
}

/**
 * The block loop. Returns the document's blocks as separate strings so a list item can unwrap a single
 * leading paragraph without having to re-parse a joined blob of HTML.
 */
function blockParts(lines, ctx) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i += 1; continue; }

    // 1. The pack's own markers, before the generic comment rule, since they ARE comments.
    const marker = markerAt(line);
    if (marker) {
      let end = i + 1;
      while (end < lines.length && lines[end].trim() !== marker.close) end += 1;
      const inner = lines.slice(i + 1, end);
      // An unclosed block still renders as a section: the document meant to open one, and closing it at
      // the end of the file loses nothing while dropping it would lose everything the block holds.
      out.push(`<section class="${marker.cls}" data-marker="${esc(marker.name)}">\n`
        + `${blockParts(inner, ctx).join('\n')}\n</section>`);
      i = end < lines.length ? end + 1 : end;
      continue;
    }

    // 2. Fenced code, before anything that could match inside it.
    const fence = RE_FENCE.exec(line);
    if (fence) {
      const indent = fence[1].length;
      const bar = fence[2];
      const info = fence[3].trim();
      // A backtick fence's info string may not contain a backtick, so a line of three backticks
      // followed by inline code is a paragraph rather than the start of a block.
      if (!(bar[0] === '`' && info.includes('`'))) {
        const closer = new RegExp(`^ {0,3}\\${bar[0]}{${bar.length},}[ \\t]*$`);
        let end = i + 1;
        while (end < lines.length && !closer.test(lines[end])) end += 1;
        const body = lines.slice(i + 1, end).map((l) => {
          let k = 0;
          while (k < indent && l[k] === ' ') k += 1;
          return l.slice(k);
        });
        const content = body.join('\n');
        const lang = (info.split(/\s+/)[0] || '').replace(/[^A-Za-z0-9_+#.-]/g, '');
        out.push(lang === 'mermaid' ? diagram(content) : codeBlock(content, lang));
        i = end < lines.length ? end + 1 : end;
        continue;
      }
    }

    // 3. ATX headings.
    const atx = RE_ATX.exec(line);
    if (atx) {
      const raw = (atx[2] === undefined ? '' : atx[2]).replace(/[ \t]+#+[ \t]*$/, '');
      out.push(heading(atx[1].length, raw, ctx));
      i += 1;
      continue;
    }

    // 4. HTML comments, dropped. An unterminated one falls through to a paragraph and is escaped.
    if (RE_COMMENT.test(line)) {
      let end = i;
      while (end < lines.length && !lines[end].includes('-->')) end += 1;
      if (end < lines.length) { i = end + 1; continue; }
    }

    // 5. Tables, before thematic breaks, so a delimiter row is never read as a rule.
    if (isTableStart(lines, i)) {
      const t = table(lines, i, ctx);
      out.push(t.html);
      i = t.end;
      continue;
    }

    // 6. Thematic breaks. Setext headings are not modelled, so a rule is always a rule.
    if (RE_HR.test(line)) { out.push('<hr />'); i += 1; continue; }

    // 7. Blockquotes.
    if (RE_QUOTE.test(line)) {
      const q = blockquote(lines, i, ctx);
      out.push(q.html);
      i = q.end;
      continue;
    }

    // 8. Indented code, BEFORE lists: at a block start four spaces is code even when what follows looks
    //    like a bullet. Inside a list item the content arrives already dedented, so a nested list never
    //    reaches this branch however deep it goes.
    if (RE_INDENT_CODE.test(line)) {
      let end = i;
      const body = [];
      while (end < lines.length && (!lines[end].trim() || RE_INDENT_CODE.test(lines[end]))) {
        body.push(lines[end].trim() ? lines[end].slice(4) : '');
        end += 1;
      }
      while (body.length && !body[body.length - 1].trim()) { body.pop(); end -= 1; }
      out.push(codeBlock(body.join('\n'), ''));
      i = end;
      continue;
    }

    // 9. Lists.
    if (RE_LIST.test(line)) {
      const l = list(lines, i, ctx);
      // A list that consumed nothing would spin here; fall through to a paragraph instead.
      if (l.end > i) { out.push(l.html); i = l.end; continue; }
    }

    // 10. A paragraph: everything up to the next blank line or block start.
    const para = [line];
    let j = i + 1;
    while (j < lines.length && !startsBlock(lines, j)) { para.push(lines[j]); j += 1; }
    out.push(paragraph(para, ctx));
    i = j;
  }
  return out;
}

/**
 * renderMarkdown — a repository's markdown as HTML a person can read.
 * See this file's header for the modelled subset, the documented departures, and the safety property.
 */
function renderMarkdown(text, opts = {}) {
  const options = opts && typeof opts === 'object' ? opts : {};
  const ctx = {
    linkRewrite: options.linkRewrite !== false,
    headings: [],
    slugs: new Map(),
    title: null,
  };
  let raw = String(text === null || text === undefined ? '' : text);
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  const lines = raw.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n');
  const parts = blockParts(lines, ctx);
  return {
    html: parts.length ? `${parts.join('\n')}\n` : '',
    title: ctx.title,
    headings: ctx.headings,
  };
}

/* ====================================================================================================
 * THE SITE (task O-4b) — a repository's own documents, browsable, and served on the loopback interface.
 *
 * Everything above this line reads a string and returns a string. Everything below it touches the
 * filesystem and a socket, and the split is deliberate: `renderMarkdown` stays callable with nothing but
 * text, so its goldens keep fencing the bytes this half writes to disk.
 *
 * ⛔ THE SITE IS A PROJECTION, NOT A SECOND SOURCE OF TRUTH (anti-drift item 53). `buildSite` READS the
 * repository's tracked documents and WRITES only under its output directory. It never edits a tracked
 * file, it has no editing surface, and it is rebuilt rather than amended. A wiki would be a second place
 * a fact could live; this is one more way to read the place it already lives.
 *
 * ⛔ AND THE DASHBOARD OBEYS THE FRESHNESS RULE EVERY OTHER READER OBEYS (anti-drift item 5). `state.html`
 * does not open `docs/derived/STATE.json`. It asks `hooks/_runtime.js`'s `readDurableState` — the same
 * two-part revision-and-content check the SessionStart hook, `status` and `doctor` all go through — and
 * on anything but CURRENT it prints the banner and WITHHOLDS every number. Withheld, never caveated: a
 * number printed beside a warning is still a number the next reader quotes.
 *
 * ⛔ A REBUILD OF AN UNCHANGED TREE IS BYTE-IDENTICAL. Nothing written here carries a timestamp, an
 * absolute path, a random id or a locale-dependent ordering. That is what makes the output diffable and
 * what makes "did the documents change" answerable by comparing two builds; it is also why the renderer
 * above is forbidden from reading a clock.
 *
 * ⛔ NOTHING IS DOWNLOADED AND NOTHING IS VENDORED (owner decision 20). `MERMAID_CDN` is a STRING that
 * lands in a page's script tag for the viewer's own browser to fetch. This pack never requests it, and a
 * page with no diagram never mentions it. When it does not load, the diagram's source is still on the
 * page inside the details block the renderer above emits, and a noscript note says so.
 *
 * ⛔ THE SERVER BINDS 127.0.0.1 AND NOTHING ELSE. Not `0.0.0.0`, not `::`, not `localhost` (which can
 * resolve to `::1` and therefore to a different socket than the one this claim is about). It serves GET
 * and HEAD out of the output directory, read-only, refuses a path that leaves it, executes nothing, and
 * reads no file outside it.
 *
 * API:
 *   buildSite(dir, { out } = {}) → { outcome, checks, pages, out }
 *     out       default `<dir>/.respawnpack/site` (gitignored). An explicit path outside the project is
 *               allowed; a path inside a directory the build READS, or one containing the project, is
 *               refused rather than written to.
 *     checks    `kernel/lib/outcome.js` rows, the same `{ outcome, check, detail, checked }` shape every
 *               other verb emits.
 *     pages     [{ source, page, title, headings, diagrams }] in document order.
 *
 *   serve({ out, port = 0, host = '127.0.0.1', log, signals = true }) → Promise<{ url, port, close }>
 * ==================================================================================================== */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { OUTCOME, result, rollup } = require('./outcome.js');
const modhealth = require('./modhealth.js');
/*
 * ⛔ ONE WRITE PRIMITIVE, THE PACK'S OWN (anti-drift item 8). Every page below goes through
 * `state.js`'s `writeAtomic` — tmp-then-rename with the Windows contention retry — so a build
 * interrupted halfway leaves whole pages behind rather than a truncated one a reader would take for the
 * document. A second rename discipline written here would be a second answer to a question this pack
 * has already answered once.
 */
const stateLib = require('./state.js');
/*
 * ⛔ THE FRESHNESS READER, REACHED ACROSS THE TREE THE WAY THE KERNEL ALREADY REACHES `hooks/` (ADR-003's
 * argument, applied again): the kernel may require from `hooks/`, the hooks may not require from the
 * kernel, and `path.resolve(__dirname, '..', '..', 'hooks', 'x.js')` is the one relative path that
 * resolves identically in this repository and in an installed target. Probed rather than hard-required,
 * because a reader that will not load must become a CANNOT_DETERMINE row on the dashboard and in the
 * verb's checks, not a stack trace that kills a build (anti-drift item 17).
 */
const RUNTIME_PATH = path.resolve(__dirname, '..', '..', 'hooks', '_runtime.js');
const runtimeHealth = modhealth.probePath(RUNTIME_PATH);
const runtimeLib = runtimeHealth.module;

/** The default output directory, relative to the project. `.respawnpack/*` is gitignored. */
const OUT_REL = path.join('.respawnpack', 'site');

/**
 * The ONE pinned diagram script, and the only external URL this pack emits.
 *
 * Pinned to an exact version on purpose: a floating tag would make two builds of the same tree render
 * differently on two days, which is the property `buildSite` spends the rest of this file defending.
 * No `integrity` attribute, and that absence is stated rather than hidden: computing a real SRI digest
 * means fetching the file, and this run downloads nothing (owner decision 20). A wrong digest would
 * silently stop every diagram from rendering, which is worse than no digest at all.
 */
const MERMAID_CDN = 'https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js';

/** The only interface the server will bind. See the header. */
const LOOPBACK = '127.0.0.1';

/*
 * What the site is a projection OF. `docs/derived/aar/*.md` and `docs/derived/LESSONS.md` are named by
 * the task and are deliberately NOT listed again here: both live under `docs/`, so the first root
 * already carries them, and a second declaration would be a second answer to "is the register in the
 * site" the day somebody moves it.
 */
const INPUT_ROOTS = ['docs', path.join('memory', 'graph')];
const INPUT_FILES = ['README.md'];

/** Never walked, at any depth, whatever an input root contains. */
const NEVER_WALK = new Set(['node_modules', '.git']);

/** Page names the site itself owns; a document may not claim one. */
const RESERVED = new Set(['index.html', 'state.html']);

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const posixOf = (p) => String(p).split(path.sep).join('/');
const firstLine = (e) => String((e && e.message) || e).split(/\r?\n/)[0];

/** Is `abs` at or below `root`? Pure path arithmetic — no filesystem access, no symlink resolution. */
function within(root, abs) {
  const rel = path.relative(root, abs);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** `fs.realpathSync` that answers `null` instead of throwing for a path that is not there. */
function realOrNull(p) {
  try { return fs.realpathSync(p); } catch { return null; }
}

/**
 * Why this output directory is refused, or null.
 *
 * ⛔ THE RULE IS "NEVER WRITE INTO WHAT YOU READ", NOT A LIST OF BAD NAMES. `docs/` is refused because
 * the build reads it, and so is `memory/graph/`, for the identical reason: a projection that writes
 * inside its own source turns the next build's input into the last build's output, and the tracked
 * document a human owns is the thing that gets overwritten. An output directory OUTSIDE the project is
 * allowed and is the reason `--out` exists.
 */
function refuseOut(projectDir, out) {
  if (within(out, projectDir)) {
    return `refusing to build into ${posixOf(out)}: it contains the project it would be built from, so the `
      + 'pages would be written over the documents they are a projection of';
  }
  for (const root of INPUT_ROOTS) {
    const abs = path.join(projectDir, root);
    if (within(abs, out)) {
      return `refusing to build into ${posixOf(path.relative(projectDir, out) || '.')}: it is inside ${posixOf(root)}/, which this build `
        + 'READS. A projection that writes inside its own source stops being a projection — pass an --out '
        + 'elsewhere, or leave it at the default .respawnpack/site/';
    }
  }
  if (within(path.join(projectDir, '.git'), out)) {
    return `refusing to build into ${posixOf(path.relative(projectDir, out) || '.')}: it is inside .git/`;
  }
  return null;
}

/**
 * Every document the site is a projection of, as sorted POSIX paths relative to `dir`.
 *
 * ⛔ A SYMLINK IS FOLLOWED ONLY WHERE IT LANDS INSIDE THE PROJECT. A link pointing out of the tree is
 * skipped and REPORTED, never followed: the site is a projection of THIS repository, and a build that
 * quietly published `/etc` because a link said so would be publishing something nobody wrote down. The
 * containment question is asked of the RESOLVED path, so a chain of links cannot walk out one step at a
 * time.
 */
function collectDocuments(dir) {
  const root = path.resolve(dir);
  const rootReal = realOrNull(root) || root;
  const found = new Map();
  const skipped = [];

  const record = (abs) => {
    const rel = posixOf(path.relative(root, abs));
    if (!rel || rel.startsWith('..')) return;
    if (!found.has(rel)) found.set(rel, abs);
  };

  const outsideLink = (abs, rel) => {
    const real = realOrNull(abs);
    if (real && within(rootReal, real)) return false;
    skipped.push({ path: posixOf(rel), why: real ? 'a symlink resolving outside the project' : 'a symlink that does not resolve' });
    return true;
  };

  /** 'dir' | 'file' | null — null meaning "not followed", with the reason recorded when there is one. */
  const kindOf = (abs, entry) => {
    if (entry.isSymbolicLink()) {
      if (outsideLink(abs, path.relative(root, abs))) return null;
      let st;
      try { st = fs.statSync(abs); } catch { return null; }
      return st.isDirectory() ? 'dir' : st.isFile() ? 'file' : null;
    }
    return entry.isDirectory() ? 'dir' : entry.isFile() ? 'file' : null;
  };

  /*
   * ⛔ EVERY DIRECTORY IS ENTERED AT MOST ONCE, BY ITS RESOLVED PATH. A link inside the project pointing
   * at one of its own ancestors is CONTAINED — it passes the containment test above, correctly — and
   * walking it would descend forever. Containment is the security rule; this is the termination rule,
   * and they are not the same rule.
   */
  const seen = new Set();
  const walk = (abs) => {
    const real = realOrNull(abs) || abs;
    if (seen.has(real)) return;
    seen.add(real);
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.slice().sort((a, b) => cmp(a.name, b.name))) {
      if (NEVER_WALK.has(entry.name)) continue;
      const child = path.join(abs, entry.name);
      const kind = kindOf(child, entry);
      if (kind === 'dir') walk(child);
      else if (kind === 'file' && /\.md$/i.test(entry.name)) record(child);
    }
  };

  const linkChecked = (rel) => {
    const abs = path.join(root, rel);
    let st;
    try { st = fs.lstatSync(abs); } catch { return null; }
    if (st.isSymbolicLink() && outsideLink(abs, rel)) return null;
    return abs;
  };

  for (const rel of INPUT_ROOTS) {
    const abs = linkChecked(rel);
    if (abs) walk(abs);
  }
  for (const rel of INPUT_FILES) {
    const abs = linkChecked(rel);
    if (abs && fs.existsSync(abs)) record(abs);
  }

  return {
    documents: [...found.keys()].sort(cmp).map((rel) => ({ rel, abs: found.get(rel) })),
    skipped: skipped.sort((a, b) => cmp(a.path, b.path)),
  };
}

/*
 * ⛔ ONE STYLESHEET, INLINE IN EVERY PAGE, AND NO SECOND FILE. A `<link rel="stylesheet">` is one more
 * request that can fail and one more path that can be wrong; a page saved on its own, mailed, or opened
 * off a USB stick still has to read. So the whole thing is here, small enough to inline everywhere and
 * bounded to what a document needs: system fonts (nothing is downloaded), an 80-character measure
 * because prose set wider is measurably harder to read, tables and code that survive a narrow window,
 * and a print rule that drops the navigation instead of printing a sidebar on paper.
 */
const STYLESHEET = `
:root { --ink:#1c1d20; --dim:#5d6067; --rule:#dfe1e6; --bg:#ffffff; --panel:#f7f8fa; --link:#0b5cad; --warn:#8a4b00; --warnbg:#fff6e5; }
@media (prefers-color-scheme: dark) {
  :root { --ink:#e6e7ea; --dim:#a0a4ad; --rule:#33363d; --bg:#16171a; --panel:#1d1f23; --link:#78b6ef; --warn:#ffce7a; --warnbg:#332a15; }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin:0; background:var(--bg); color:var(--ink); line-height:1.55;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
a { color: var(--link); }
.shell { display:flex; align-items:flex-start; gap:2rem; max-width:1180px; margin:0 auto; padding:1.5rem 1.25rem 4rem; }
.side { flex:0 0 17rem; position:sticky; top:1.5rem; font-size:.875rem; }
.side h2 { font-size:.75rem; letter-spacing:.08em; text-transform:uppercase; color:var(--dim); margin:1.25rem 0 .4rem; }
.side ul { list-style:none; margin:0; padding-left:.85rem; }
.side > ul { padding-left:0; }
.side li { margin:.15rem 0; }
.side .dir > span { color:var(--dim); font-weight:600; }
.side a.here { font-weight:700; text-decoration:none; }
main { flex:1 1 auto; min-width:0; }
.measure { max-width:80ch; }
.crumbs { font-size:.8125rem; color:var(--dim); margin:0 0 1rem; }
.crumbs a { text-decoration:none; }
h1,h2,h3,h4,h5,h6 { line-height:1.25; margin:1.8em 0 .5em; }
h1 { margin-top:0; font-size:1.9rem; }
h2 { font-size:1.4rem; border-bottom:1px solid var(--rule); padding-bottom:.2em; }
p, ul, ol, blockquote, table, pre { margin:0 0 1rem; }
blockquote { border-left:3px solid var(--rule); margin-left:0; padding-left:1rem; color:var(--dim); }
code { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace; font-size:.9em;
  background:var(--panel); padding:.1em .3em; border-radius:3px; }
pre { background:var(--panel); border:1px solid var(--rule); border-radius:6px; padding:.85rem 1rem; overflow-x:auto; }
pre code { background:none; padding:0; }
.wide { overflow-x:auto; }
table { border-collapse:collapse; width:100%; font-size:.925rem; }
th, td { border:1px solid var(--rule); padding:.4rem .6rem; text-align:left; vertical-align:top; }
th { background:var(--panel); }
hr { border:0; border-top:1px solid var(--rule); margin:2rem 0; }
img { max-width:100%; height:auto; }
.outline { border:1px solid var(--rule); border-radius:6px; background:var(--panel); padding:.6rem .9rem; font-size:.85rem; margin:0 0 1.5rem; }
.outline ol { list-style:none; margin:0; padding:0; }
.outline li.l3 { padding-left:1rem; } .outline li.l4 { padding-left:2rem; }
.outline li.l5 { padding-left:3rem; } .outline li.l6 { padding-left:4rem; }
section.generated, section.note { border-left:3px solid var(--rule); padding-left:1rem; }
section.generated::before { content:"generated — regenerate, do not edit"; display:block; font-size:.72rem; letter-spacing:.06em;
  text-transform:uppercase; color:var(--dim); margin-bottom:.4rem; }
section.note::before { content:"a human wrote this — regeneration preserves it"; display:block; font-size:.72rem; letter-spacing:.06em;
  text-transform:uppercase; color:var(--dim); margin-bottom:.4rem; }
.diagram details { margin-top:.4rem; font-size:.85rem; color:var(--dim); }
.banner { background:var(--warnbg); border:1px solid var(--warn); border-radius:6px; color:var(--warn); padding:.75rem 1rem; }
.withheld { font-weight:700; }
.foot { color:var(--dim); font-size:.8125rem; border-top:1px solid var(--rule); margin-top:3rem; padding-top:.75rem; }
@media (max-width: 62rem) { .shell { display:block; } .side { position:static; margin-bottom:2rem; } }
@media print {
  .side, .crumbs, .outline { display:none; }
  body { color:#000; background:#fff; }
  .shell { display:block; max-width:none; padding:0; }
  pre, table, blockquote { break-inside:avoid; }
  a::after { content:" (" attr(href) ")"; font-size:.8em; color:#444; }
}
`.trim();

/*
 * ⛔ THE DIAGRAM SCRIPT IS EMITTED ONLY WHERE THERE IS A DIAGRAM, AND EVERY GUARD IS DELIBERATE. A page
 * with no `<pre class="mermaid">` never names an external host at all, so a reader who opens the
 * documents that carry no picture makes no outbound request; `startOnLoad` is false and `run()` is
 * called behind a `typeof` check so that a script which never arrived leaves the page exactly as the
 * noscript note describes it, rather than throwing into the console; and `securityLevel: 'strict'`
 * keeps the diagram library from turning label text back into markup, which is the property the
 * renderer above spends its escaping on.
 */
const NOSCRIPT_NOTE = '<noscript><p class="banner">Diagrams on this page are drawn by the reader’s own browser and need '
  + 'JavaScript. Nothing is lost without it: every diagram’s source is on this page, under “diagram source”.</p></noscript>';

function diagramScripts() {
  return `<script src="${MERMAID_CDN}" defer></script>\n`
    + '<script>window.addEventListener("load",function(){var m=window.mermaid;'
    + 'if(m&&typeof m.initialize==="function"){m.initialize({startOnLoad:false,securityLevel:"strict"});'
    + 'if(typeof m.run==="function"){m.run();}}});</script>';
}

// --- navigation ---------------------------------------------------------------------------------------

/** The document set as a nested {dirs, files} tree, so the sidebar shows a repository, not a flat list. */
function treeOf(pages) {
  const root = { dirs: new Map(), files: [] };
  for (const p of pages) {
    const parts = p.href.split('/');
    const file = parts.pop();
    let node = root;
    for (const d of parts) {
      if (!node.dirs.has(d)) node.dirs.set(d, { dirs: new Map(), files: [] });
      node = node.dirs.get(d);
    }
    node.files.push({ ...p, file });
  }
  return root;
}

function renderTree(node, up, activeHref) {
  const items = [];
  for (const name of [...node.dirs.keys()].sort(cmp)) {
    items.push(`<li class="dir"><span>${esc(name)}</span>${renderTree(node.dirs.get(name), up, activeHref)}</li>`);
  }
  for (const p of node.files.slice().sort((a, b) => cmp(a.href, b.href))) {
    const here = p.href === activeHref ? ' class="here"' : '';
    items.push(`<li><a${here} href="${esc(up + p.href)}">${esc(p.title || p.file)}</a></li>`);
  }
  return items.length ? `<ul>${items.join('')}</ul>` : '';
}

function sidebar(pages, up, activeHref) {
  return '<nav class="side" aria-label="documents">'
    + `<h2>The record</h2><ul><li><a${activeHref === 'index.html' ? ' class="here"' : ''} href="${esc(`${up}index.html`)}">All documents</a></li>`
    + `<li><a${activeHref === 'state.html' ? ' class="here"' : ''} href="${esc(`${up}state.html`)}">Project state</a></li></ul>`
    + `<h2>Documents</h2>${renderTree(treeOf(pages), up, activeHref) || '<p>none</p>'}`
    + '</nav>';
}

function breadcrumbs(href, up, title) {
  const parts = href.split('/');
  const leaf = parts.pop();
  const crumbs = [`<a href="${esc(`${up}index.html`)}">The record</a>`];
  for (const d of parts) crumbs.push(esc(d));
  crumbs.push(`<strong>${esc(title || leaf)}</strong>`);
  return `<p class="crumbs">${crumbs.join(' <span aria-hidden="true">/</span> ')}</p>`;
}

/** The per-page heading outline. Level 1 is the page's own title and is not repeated in its own index. */
function outline(headings) {
  const rows = (headings || []).filter((h) => h.level >= 2 && h.level <= 6);
  if (!rows.length) return '';
  const items = rows.map((h) => `<li class="l${h.level}"><a href="#${esc(h.id)}">${esc(h.text)}</a></li>`);
  return `<nav class="outline" aria-label="on this page"><ol>${items.join('')}</ol></nav>`;
}

/**
 * One page, whole: the inline stylesheet, the sidebar, the breadcrumbs, the outline and the body.
 *
 * The parameters that vary are all derived from the page's OWN path, so two builds of the same tree
 * produce the same bytes and no page carries a fact about the machine it was built on.
 */
function layout({ title, href, bodyHtml, pages, headings, hasDiagram, footer }) {
  const depth = href.split('/').length - 1;
  const up = '../'.repeat(depth);
  return `${[
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${esc(title)}</title>`,
    `<style>\n${STYLESHEET}\n</style>`,
    '</head>',
    '<body>',
    '<div class="shell">',
    sidebar(pages, up, href),
    '<main class="measure">',
    breadcrumbs(href, up, title),
    hasDiagram ? NOSCRIPT_NOTE : '',
    outline(headings),
    bodyHtml.trimEnd(),
    `<p class="foot">${esc(footer)}</p>`,
    '</main>',
    '</div>',
    hasDiagram ? diagramScripts() : '',
    '</body>',
    '</html>',
  ].filter((l) => l !== '').join('\n')}\n`;
}

// --- the dashboard ------------------------------------------------------------------------------------

/**
 * The compiled state, through the reader every RespawnPack reader shares.
 *
 * ⛔ NEVER A RAW READ OF `docs/derived/STATE.json`. The file on disk is a projection of a revision AND of
 * a set of compiler inputs, and only `readDurableState` knows both halves. A second reader here would
 * be a second definition of "current", and the day the two disagreed this page would be the one showing
 * a number the hooks had already withheld.
 */
function readState(dir) {
  if (!runtimeLib) {
    return {
      status: 'CANNOT_DETERMINE',
      state: null,
      detail: `hooks/_runtime.js: ${runtimeHealth.detail} — the shared freshness reader could not be loaded, so nothing `
        + 'about this project’s compiled state can be established here',
    };
  }
  try {
    return runtimeLib.readDurableState(dir);
  } catch (e) {
    return { status: 'CANNOT_DETERMINE', state: null, detail: `the shared freshness reader threw: ${firstLine(e)}` };
  }
}

const COUNT_ROWS = [
  ['mandatory', 'mandatory'], ['conformant', 'conformant'], ['candidate', 'candidate'],
  ['unevidenced', 'unevidenced'], ['waived', 'waived'], ['blocked', 'blocked'],
  ['staleEvidence', 'stale evidence'], ['total', 'rows in total'],
];

function countsTable(counts) {
  const rows = COUNT_ROWS.filter(([k]) => Number.isFinite(counts[k]))
    .map(([k, label]) => `<tr><th scope="row">${esc(label)}</th><td data-count="${esc(k)}">${esc(String(counts[k]))}</td></tr>`);
  return rows.length ? `<div class="wide"><table><tbody>${rows.join('')}</tbody></table></div>` : '';
}

function listOf(items) {
  return items.length ? `<ul>${items.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : '<p>none recorded</p>';
}

/**
 * `state.html`'s body.
 *
 * ⛔ THE SHAPE IS `status`'s, ON PURPOSE (anti-drift item 5). Goal and milestone are TEXT and are printed
 * either way, exactly as `cmdStatus` prints them before its own freshness branch. Every NUMBER — the
 * counts, the blockers, the next unblocked work — lives behind the CURRENT branch and is replaced by the
 * word WITHHELD otherwise. Not "3 rows (may be stale)": a caveated number is still a number, and the
 * next reader quotes the number.
 */
function dashboardBody(read) {
  const st = read.state || null;
  const parts = ['<h1 id="project-state">Project state</h1>'];
  if (st && st.goal) parts.push(`<p><strong>Goal</strong> — ${esc(st.goal)} <em>(${st.goalComplete ? 'complete' : 'in progress'})</em></p>`);
  if (st && st.milestone) parts.push(`<p><strong>Milestone</strong> — ${esc(st.milestone)} <em>(${st.milestoneComplete ? 'complete' : 'in progress'})</em></p>`);

  if (read.status !== 'CURRENT') {
    const label = String(read.status || 'CANNOT_DETERMINE');
    const detail = read.detail
      || (label === 'ABSENT' ? 'this project has compiled no state — there is no docs/derived/STATE.json to read' : 'no reason recorded');
    parts.push(`<p class="banner"><strong>⚠️ state: ${esc(label)}</strong> — ${esc(detail)}</p>`);
    parts.push('<p class="withheld">rows: WITHHELD · blocked: WITHHELD · next: WITHHELD</p>');
    parts.push('<p>Every count is withheld rather than shown with a warning beside it: a number printed under a caveat is '
      + 'still a number the next reader quotes. Regenerate with <code>savepoint --write</code>, then rebuild this site.</p>');
    return { html: parts.join('\n'), label, detail };
  }

  const detail = read.detail || 'the compiled state matches its revision and every compiler input';
  parts.push(`<p class="crumbs">Current at <code>${esc(String(st.sourceRevision || '').slice(0, 7))}</code> — ${esc(detail)}</p>`);
  if (st.tracksRequirements && st.counts) {
    parts.push('<h2 id="counts">Counts</h2>');
    parts.push(countsTable(st.counts));
  } else {
    parts.push('<h2 id="counts">Counts</h2><p>This project tracks no requirement denominator, so there is nothing to count.</p>');
  }
  parts.push('<h2 id="blockers">Blockers</h2>');
  parts.push(listOf((st.blockers || []).map((b) => `${b.id}${(b.blockedBy || []).length ? ` — blocked by ${b.blockedBy.join(', ')}` : ''}${b.missingAuthority ? ` — needs ${b.missingAuthority}` : ''}`)));
  parts.push('<h2 id="next">Next unblocked work</h2>');
  parts.push(listOf((st.nextUnblockedWork || []).map((n) => `${n.id}${n.title ? ` — ${n.title}` : ''}${n.status ? ` (${n.status})` : ''}`)));
  if ((st.cannotDetermine || []).length) {
    parts.push('<h2 id="unknown">Could not be determined</h2>');
    parts.push(listOf(st.cannotDetermine.map(String)));
  }
  return { html: parts.join('\n'), label: 'CURRENT', detail };
}

// --- the index ----------------------------------------------------------------------------------------

function indexBody(pages, skipped) {
  const rows = pages.map((p) => `<tr><td><a href="${esc(p.href)}">${esc(p.title || p.href)}</a></td><td><code>${esc(p.rel)}</code></td></tr>`);
  const parts = [
    '<h1 id="the-record">The record</h1>',
    '<p>Every tracked document this project keeps, rendered for reading. This site is a <strong>projection</strong>: '
      + 'it is rebuilt from the files in the repository and never edited, so the document is always the source and this '
      + 'is only a way to read it.</p>',
    `<p><a href="state.html">Project state</a> — the compiled state, or the reason it cannot be shown.</p>`,
    '<h2 id="documents">Documents</h2>',
    rows.length
      ? `<div class="wide"><table><thead><tr><th>Document</th><th>Source</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`
      : '<p>This project has no documents under <code>docs/</code>, <code>memory/graph/</code> or a root <code>README.md</code>.</p>',
  ];
  if (skipped.length) {
    parts.push('<h2 id="not-followed">Not followed</h2>');
    parts.push(listOf(skipped.map((s) => `${s.path} — ${s.why}`)));
  }
  return parts.join('\n');
}

// --- the build ----------------------------------------------------------------------------------------

/** Every page goes through the pack's one atomic write, so an interrupted build never leaves half a page. */
function writePage(file, text) {
  stateLib.writeAtomic(file, text);
}

/**
 * Delete pages a previous build wrote and this one did not, then any directory that leaves empty.
 *
 * ⛔ WITHOUT THIS THE OUTPUT IS NOT A PROJECTION. A document deleted from the repository would keep its
 * page forever, and a reader arriving from the sidebar of an older tab would read a document that no
 * longer exists as though it did. Bounded to `.html` files this build knows how to produce, and to a
 * directory `refuseOut` has already established is not inside the project's own sources: nothing else
 * under `out` is touched, and a symlink is neither `isFile()` nor `isDirectory()` here, so none is
 * followed and none is removed.
 */
function pruneStalePages(out, written) {
  const removed = [];
  const walk = (abs) => {
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.slice().sort((a, b) => cmp(a.name, b.name))) {
      const child = path.join(abs, entry.name);
      if (entry.isDirectory()) {
        walk(child);
        try { if (!fs.readdirSync(child).length) fs.rmdirSync(child); } catch { /* not empty, or gone */ }
        continue;
      }
      if (!entry.isFile() || !/\.html$/i.test(entry.name)) continue;
      const rel = posixOf(path.relative(out, child));
      if (written.has(rel)) continue;
      try { fs.unlinkSync(child); removed.push(rel); } catch { /* already gone */ }
    }
  };
  walk(out);
  return removed.sort(cmp);
}

const ABSOLUTE_HREF = /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:|\/\/|\/|#|mailto:)/;

/** Where a relative href on `fromHref` lands, as a page path, or null when it leaves the site. */
function resolveHref(fromHref, href) {
  const clean = href.split('#')[0].split('?')[0];
  if (!clean || ABSOLUTE_HREF.test(clean) || !/\.html$/i.test(clean)) return null;
  const dir = path.posix.dirname(fromHref);
  const joined = path.posix.normalize(path.posix.join(dir === '.' ? '' : dir, clean));
  return joined.startsWith('..') ? null : joined;
}

/**
 * Build the site.
 *
 * ⛔ IT WRITES ONLY UNDER `out`, AND THAT IS THE CLAIM THE REST OF THE PACK RESTS ON. Nothing here opens
 * a tracked file for writing, runs git, or touches `docs/`. The only paths passed to a write are built
 * by joining `out` with a page path derived from a document's own relative path, and `refuseOut` has
 * already refused an `out` that could reach back into the sources.
 */
function buildSite(dir, opts = {}) {
  const projectDir = path.resolve(dir);
  const options = opts && typeof opts === 'object' ? opts : {};
  const requested = options.out === undefined || options.out === null || options.out === '' ? null : String(options.out);
  const out = requested === null ? path.join(projectDir, OUT_REL) : path.resolve(projectDir, requested);
  const checks = [];

  const refusal = refuseOut(projectDir, out);
  if (refusal) {
    checks.push(result(OUTCOME.FAIL, 'site:out', refusal, { domain: 'integrity', subject: posixOf(out) }));
    return { outcome: rollup(checks), checks, pages: [], out };
  }

  const { documents, skipped } = collectDocuments(projectDir);

  const pages = [];
  const byHref = new Map();
  const sources = new Set(documents.map((d) => d.rel));
  const refused = [];
  for (const doc of documents) {
    const href = doc.rel.replace(/\.md$/i, '.html');
    if (RESERVED.has(href)) {
      refused.push(`${doc.rel} renders to ${href}, which is the site's own page`);
      continue;
    }
    if (byHref.has(href)) {
      refused.push(`${doc.rel} and ${byHref.get(href).rel} both render to ${href}`);
      continue;
    }
    let text;
    try { text = fs.readFileSync(doc.abs, 'utf8'); }
    catch (e) { refused.push(`${doc.rel} could not be read: ${firstLine(e)}`); continue; }
    const rendered = renderMarkdown(text);
    const page = {
      rel: doc.rel,
      href,
      title: rendered.title || href.split('/').pop().replace(/\.html$/i, ''),
      headings: rendered.headings,
      html: rendered.html,
      diagrams: (rendered.html.match(/<pre class="mermaid">/g) || []).length,
    };
    byHref.set(href, page);
    pages.push(page);
  }

  // The dashboard, through the shared reader. Computed before anything is written so a broken reader
  // becomes a row rather than a half-built site.
  const read = readState(projectDir);
  const dashboard = dashboardBody(read);

  const written = new Set();
  const writeFailures = [];
  const emit = (href, text) => {
    try {
      writePage(path.join(out, ...href.split('/')), text);
      written.add(href);
    } catch (e) {
      writeFailures.push(`${href}: ${firstLine(e)}`);
    }
  };

  for (const page of pages) {
    emit(page.href, layout({
      title: page.title,
      href: page.href,
      bodyHtml: page.html,
      pages,
      headings: page.headings,
      hasDiagram: page.diagrams > 0,
      footer: `Rendered from ${page.rel}. This page is a projection: change the document, then rebuild.`,
    }));
  }
  emit('index.html', layout({
    title: 'The record',
    href: 'index.html',
    bodyHtml: indexBody(pages, skipped),
    pages,
    headings: [],
    hasDiagram: false,
    footer: 'Built by `respawnpack site` from this repository’s own documents. Rebuilt, never edited.',
  }));
  emit('state.html', layout({
    title: 'Project state',
    href: 'state.html',
    bodyHtml: dashboard.html,
    pages,
    headings: [],
    hasDiagram: false,
    footer: 'The compiled state is read through the same freshness rule every RespawnPack reader uses.',
  }));

  const pruned = pruneStalePages(out, written);

  // --- rows ---------------------------------------------------------------------------------------
  const skippedNote = skipped.length ? ` · ${skipped.length} path(s) not followed: ${skipped.map((s) => s.path).join(', ')}` : '';
  if (refused.length || writeFailures.length) {
    checks.push(result(OUTCOME.FAIL, 'site:pages',
      `${[...refused, ...writeFailures].join(' · ')}${skippedNote}`,
      { domain: 'integrity', checked: documents.length }));
  } else if (!pages.length) {
    checks.push(result(OUTCOME.CANNOT_DETERMINE, 'site:pages',
      `no document was found under ${INPUT_ROOTS.map(posixOf).map((r) => `${r}/`).join(', ')} or as a root ${INPUT_FILES.join(', ')} — `
      + `there is nothing to project, which is not the same as a site that built cleanly${skippedNote}`,
      { domain: 'integrity', checked: 0 }));
  } else {
    checks.push(result(OUTCOME.PASS, 'site:pages',
      `${pages.length} document(s) rendered${pruned.length ? `, ${pruned.length} stale page(s) removed` : ''}${skippedNote}`,
      { domain: 'integrity', checked: pages.length }));
  }

  let links = 0;
  const dangling = [];
  const outside = [];
  for (const page of pages) {
    for (const m of page.html.matchAll(/href="([^"]*)"/g)) {
      const target = resolveHref(page.href, m[1]);
      if (target === null) continue;
      links += 1;
      if (byHref.has(target) || RESERVED.has(target)) continue;
      const asSource = target.replace(/\.html$/i, '.md');
      if (sources.has(asSource)) dangling.push(`${page.rel} → ${target}`);
      else outside.push(`${page.rel} → ${target}`);
    }
  }
  if (dangling.length) {
    checks.push(result(OUTCOME.FAIL, 'site:links',
      `${dangling.length} link(s) point at a document this build READ and did not publish: ${dangling.slice(0, 5).join(', ')}`,
      { domain: 'integrity', checked: links }));
  } else if (!links) {
    checks.push(result(OUTCOME.NOT_APPLICABLE, 'site:links',
      'no document links to another, so there is no cross-reference to resolve', { domain: 'integrity', checked: 0 }));
  } else {
    /*
     * ⛔ A LINK LEAVING THE SITE IS A FACT ABOUT THE SOURCE, NOT A BUILD FAILURE. The site is a
     * projection of a NAMED set of documents, so a document that links to `../hooks/README.md` is
     * linking somewhere this site never claimed to carry. Counted and named rather than silently
     * rewritten, because rewriting it would hide the one thing a reader needs to know when the page
     * 404s.
     */
    checks.push(result(OUTCOME.PASS, 'site:links',
      `${links - outside.length} of ${links} cross-reference(s) resolve to a published page`
      + `${outside.length ? `; ${outside.length} point outside the document set this site covers` : ''}`,
      { domain: 'integrity', checked: links }));
  }

  checks.push(result(OUTCOME.PASS, 'site:output',
    `${written.size} file(s) under ${posixOf(path.relative(projectDir, out) || out)}`,
    { domain: 'integrity', checked: written.size, subject: posixOf(out) }));

  /*
   * ⛔ THE ROW SAYS WHAT THE PROJECTION IS, NOT WHETHER THE PAGE RENDERED. `status` returns
   * CANNOT_DETERMINE for a state that is not current and so does this, from the same reader and the same
   * verdict: a dashboard that had to withhold its numbers has established nothing about the project, and
   * calling the build green because the HTML came out would be exactly the "the machinery ran, therefore
   * things are fine" reading the four-outcome vocabulary exists to refuse.
   */
  if (dashboard.label === 'CURRENT') {
    checks.push(result(OUTCOME.PASS, 'state:STATE.json', dashboard.detail, { domain: 'integrity', checked: 1, label: 'CURRENT' }));
  } else {
    checks.push(result(OUTCOME.CANNOT_DETERMINE, 'state:STATE.json',
      `${dashboard.detail} · the dashboard shows the banner and withholds every number`,
      { domain: 'integrity', label: dashboard.label }));
  }

  return {
    outcome: rollup(checks),
    checks,
    out,
    pages: pages.map((p) => ({ source: p.rel, page: p.href, title: p.title, headings: p.headings.length, diagrams: p.diagrams })),
    written: [...written].sort(cmp),
    pruned,
    skipped,
    state: dashboard.label,
  };
}

// --- the loopback server ------------------------------------------------------------------------------

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

/**
 * Serve a built site, read-only, on 127.0.0.1 and nothing else.
 *
 * ⛔ THE HOST IS CHECKED BEFORE A SOCKET EXISTS. `0.0.0.0`, `::`, a LAN address and even `localhost` are
 * refused: the first three publish the repository's documents to the network, and the last one is
 * ambiguous (it can resolve to `::1`), so accepting it would make the claim in this file's header
 * something nobody could check. One literal, refused everywhere else.
 *
 * ⛔ AND IT EXECUTES NOTHING. There is no CGI path, no directory listing, no template evaluated at
 * request time, and no `child_process` anywhere below. It reads a file inside `out` and writes its bytes
 * to a socket, or it refuses.
 */
function serve(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const log = typeof opts.log === 'function' ? opts.log : (line) => process.stdout.write(`${line}\n`);
  const signals = opts.signals !== false;

  return new Promise((resolve, reject) => {
    const host = opts.host === undefined || opts.host === null ? LOOPBACK : String(opts.host);
    if (host !== LOOPBACK) {
      reject(new Error(`refusing to bind ${JSON.stringify(host)}: \`respawnpack site --serve\` binds ${LOOPBACK} and nothing else. `
        + 'This is a local viewer for one person’s own repository, and a site reachable from the network is a decision '
        + 'nobody made by starting a viewer.'));
      return;
    }
    const port = opts.port === undefined || opts.port === null || opts.port === '' ? 0 : Number(opts.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      reject(new Error(`not a port: ${JSON.stringify(opts.port)} — expected an integer between 0 and 65535 (0 asks the OS for a free one)`));
      return;
    }
    const outReal = opts.out ? realOrNull(path.resolve(String(opts.out))) : null;
    if (!outReal) {
      reject(new Error(`there is no built site at ${opts.out ? posixOf(path.resolve(String(opts.out))) : '(no --out given)'} — run \`respawnpack site\` first`));
      return;
    }
    let st;
    try { st = fs.statSync(outReal); } catch { st = null; }
    if (!st || !st.isDirectory()) {
      reject(new Error(`${posixOf(outReal)} is not a directory, so there is no site to serve`));
      return;
    }

    const server = http.createServer((req, res) => {
      const head = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
      const deny = (code, why) => {
        res.writeHead(code, { ...head, 'content-type': 'text/plain; charset=utf-8' });
        res.end(req.method === 'HEAD' ? undefined : `${code} ${why}\n`);
      };
      if (req.method !== 'GET' && req.method !== 'HEAD') { deny(405, 'this server answers GET and HEAD only'); return; }

      /*
       * ⛔ THE RAW PATH IS INSPECTED BEFORE ANY NORMALISER TOUCHES IT. `new URL(...).pathname` would
       * quietly collapse `/a/../../etc` into `/etc` and hand this code a path that looks innocent — the
       * refusal would still hold on containment, but the request that TRIED to escape would be
       * indistinguishable from one that never did. So the segments are read as sent, `.` and `..` are
       * refused outright in both their literal and percent-encoded spellings, and containment is then
       * checked again on the resolved path as the belt to that brace.
       */
      const raw = String(req.url || '/');
      const cut = Math.min(...[raw.indexOf('?'), raw.indexOf('#')].filter((i) => i >= 0).concat([raw.length]));
      let decoded;
      try { decoded = decodeURIComponent(raw.slice(0, cut)); }
      catch { deny(400, 'the request path is not valid percent-encoding'); return; }
      if (decoded.includes('\0') || decoded.includes('\\')) { deny(403, 'refused: the request path carries a separator or byte this server does not serve'); return; }
      const segments = decoded.split('/').filter((s) => s !== '');
      if (segments.some((s) => s === '.' || s === '..')) { deny(403, 'refused: path traversal'); return; }

      let abs = path.join(outReal, ...segments);
      if (!within(outReal, abs)) { deny(403, 'refused: that path is outside the built site'); return; }
      let stat;
      try { stat = fs.statSync(abs); } catch { stat = null; }
      if (stat && stat.isDirectory()) {
        abs = path.join(abs, 'index.html');
        try { stat = fs.statSync(abs); } catch { stat = null; }
      }
      if (!stat || !stat.isFile()) { deny(404, 'no such page in this site'); return; }
      // The resolved path, because a symlink placed inside `out` is still a way out of it.
      const real = realOrNull(abs);
      if (!real || !within(outReal, real)) { deny(403, 'refused: that path resolves outside the built site'); return; }

      let body;
      try { body = fs.readFileSync(real); }
      catch (e) { deny(500, `could not read that page: ${firstLine(e)}`); return; }
      res.writeHead(200, {
        ...head,
        'content-type': CONTENT_TYPES[path.extname(real).toLowerCase()] || 'application/octet-stream',
        'content-length': body.length,
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    });

    let closing = null;
    const onSigint = () => { log('  stopping the site server'); close(); };
    function close() {
      if (closing) return closing;
      if (signals) process.removeListener('SIGINT', onSigint);
      closing = new Promise((done) => {
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
        server.close(() => done());
      });
      return closing;
    }

    server.once('error', (e) => reject(e));
    server.listen(port, LOOPBACK, () => {
      const addr = server.address();
      const url = `http://${LOOPBACK}:${addr.port}/`;
      if (signals) process.on('SIGINT', onSigint);
      log(`  serving ${posixOf(outReal)} at ${url}`);
      log('  loopback only — nothing outside this machine can reach it. Ctrl-C to stop.');
      resolve({ url, port: addr.port, address: addr.address, server, close });
    });
  });
}

module.exports = { renderMarkdown, buildSite, serve, MERMAID_CDN, LOOPBACK };
