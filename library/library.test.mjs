// RespawnPack library content-scan — a SkillSpector-style CI gate over library/, the one place in the repo
// where third-party-authored content physically lives (today the compliance checklists + reference PDFs;
// more may be vendored later). node:test + node:assert only (zero new dependencies), matching the style of
// skills/skills.test.mjs and install/install.test.mjs.
//
// WHY THIS EXISTS: vendored text is two liabilities at once. It is an INJECTION surface — a forked skill or
// a pasted regulatory excerpt could carry "ignore previous instructions", a javascript: link, or an encoded
// payload — and a PROVENANCE surface — redistribution is only sound if we can point at where each vendored
// file came from and under what license. The runtime injection-scan hook already scans such content the
// moment an agent READS it; this suite mechanizes the SAME discipline at CI time over the files at rest, so a
// bad vendored file lands as a red build, not a surprise mid-session.
//
// SINGLE SOURCE OF TRUTH: the injection + unsafe-link signatures are IMPORTED from hooks/injection-scan.js —
// the exact lists the runtime hook fires on — never re-listed here, so the CI gate and the runtime scanner
// cannot drift apart. The executable/encoded-payload signatures are a content-at-rest concern the runtime
// hook does not cover, so they are defined locally, below.
//
// VERIFIED PROVENANCE CONVENTION (checked against the real tree, not assumed): ATTRIBUTION.md describes a
// vendored file as carrying a `SOURCE:` header, but the actual library checklists use a Markdown blockquote
// provenance line — `> Source: <url> · retrieved <date> · <license> …` — as line 2, right under the H1. This
// suite asserts that REAL convention (and tolerates the bare `SOURCE:` form ATTRIBUTION.md documents, for
// forward-compat). README.md / SOURCES.md are index/manifest files and are exempt — a README navigates, and
// SOURCES.md IS the manifest that cites the binary PDFs (which cannot carry a Markdown header themselves).
//
// ALLOWLIST DISCIPLINE: every KNOWN_* allowlist ships EMPTY and is SHRINK-ONLY (same ratchet as
// skills.test.mjs). A genuine pre-existing violation is added as an entry with a `PRE-EXISTING:` justification
// for the merge boundary to adjudicate — content is NEVER edited to pass, and the imported hook signatures are
// NEVER loosened to pass. Local payload patterns' PRECISION may be tuned (they are this suite's own), but the
// hook's imported patterns are immutable here.
//
// Run:
//   node --test library/library.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import injectionScan from '../hooks/injection-scan.js'; // CJS module, imported for its exported signature lists

// The hook exports its two signature families separately so this gate can address them as distinct checks.
const { INJECTION_PATTERNS, UNSAFE_LINK_PATTERNS } = injectionScan;

const SELF = fileURLToPath(import.meta.url);
const LIBRARY_DIR = path.dirname(SELF); // this suite lives at library/library.test.mjs, so its dir IS library/

// --- walk library/ recursively, classify each file as text or binary -----------------------------------
function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git') continue; // never vendored content
      out.push(...walk(abs));
    } else if (e.isFile()) {
      out.push(abs);
    }
  }
  return out;
}

// A file is binary if it has a known-binary extension OR contains a NUL byte anywhere. Both are needed: a
// PDF can carry well over 8 KB of NUL-free ASCII (metadata + xref) before its first compressed stream, so a
// small-window NUL sniff misclassifies it as text — and a PDF's stream bytes, decoded as UTF-8, produce long
// base64-ish runs that would false-trip the payload scan. The whole-file NUL check is the extension-agnostic
// backstop so a mis-named binary payload still classifies as binary rather than dodging into the text scans.
const BINARY_EXT = /\.(?:pdf|png|jpe?g|gif|webp|ico|bmp|tiff?|svgz|zip|gz|tgz|tar|7z|rar|woff2?|ttf|otf|eot|mp[34]|wav|ogg|mov|avi|mkv|webm|exe|dll|so|dylib|bin|wasm|class|jar)$/i;
const isBinary = (relPath, buf) => BINARY_EXT.test(relPath) || buf.includes(0);

// This suite (and any future *.test.* tooling placed under library/) is not vendored content — exclude it,
// or it would trip the provenance check on its own missing `> Source:` header.
const ALL_FILES = walk(LIBRARY_DIR).filter((abs) => abs !== SELF && !/\.test\.(mjs|cjs|js)$/i.test(abs));

const TEXT_FILES = [];
const BINARY_FILES = [];
for (const abs of ALL_FILES) {
  const buf = fs.readFileSync(abs);
  const relPath = path.relative(LIBRARY_DIR, abs).split(path.sep).join('/'); // posix-normalized for stable keys
  if (isBinary(relPath, buf)) BINARY_FILES.push({ abs, relPath });
  else TEXT_FILES.push({ abs, relPath, content: buf.toString('utf8') });
}

// README.md / SOURCES.md are index/manifest files — exempt from the per-file source-header requirement.
const isIndexFile = (relPath) => /(?:^|\/)(?:README|SOURCES)\.md$/i.test(relPath);

// The real convention (`> Source:` blockquote) plus the ATTRIBUTION.md-documented bare `SOURCE:` form.
const PROVENANCE_RE = /^\s{0,3}>?\s*source\s*:\s*\S/im;
const headOf = (content, lines = 15) => content.split(/\r?\n/).slice(0, lines).join('\n');

// --- executable/encoded-payload signatures (LOCAL — the runtime hook does not cover content at rest) -----
// Precision verified against the actual tree: none of these currently fire (the compliance prose has no
// "eval(", "Function(", "child_process", "<script", or "data:text/html", and no base64-ish run near the
// threshold). Precision here may be tuned since these are this suite's own patterns, unlike the imported ones.
const PAYLOAD_PATTERNS = [
  { re: /<\s*script[\s>/]/i, name: '<script> tag' },
  { re: /<\s*iframe[\s>/]/i, name: '<iframe> tag' },
  { re: /\bdata:text\/html/i, name: 'data:text/html payload URI' },
  { re: /\bchild_process\b/, name: "'child_process' (Node RCE surface)" },
  { re: /\beval\s*\(/, name: 'eval( call' },
  { re: /\b(?:new\s+)?Function\s*\(/, name: 'Function( constructor' },
  // Suspiciously long base64-ish run. Threshold 200 is deliberately high: the longest legitimate run in the
  // current tree is 44 chars (the slash-joined "Supabase/Fly/Cloudflare/Vercel/email/SMS/LLM" vendor list),
  // and 200 also clears common hash lengths (SHA-512 hex = 128) so a legitimate checksum or a small data-URI
  // icon won't false-positive — while a genuine encoded blob payload runs far longer. `/` escaped inside the
  // class for regex-literal safety.
  { re: /[A-Za-z0-9+\/]{200,}={0,2}/, name: 'suspiciously long base64-ish run (>=200 chars)' },
];

// --- shrink-only ratchet (mirrors skills.test.mjs's KNOWN_* new/stale handling) -------------------------
// Given the violation keys found this run and a pre-approved allowlist, return NEW violations (must be empty)
// and STALE allowlist entries (an allowlisted key that no longer reproduces — must be removed, not left to rot
// where it could mask a different future violation at the same key).
function ratchet(foundKeys, allowlist) {
  const found = new Set(foundKeys);
  const allow = new Set(allowlist);
  return {
    newViolations: [...found].filter((k) => !allow.has(k)),
    stale: [...allow].filter((k) => !found.has(k)),
  };
}

// Every "relPath :: signature-name" pair where a pattern fires across the text files. None of the imported or
// local patterns carry the /g flag, so .test() is stateless and safe to reuse across every file.
function matchFiles(patterns) {
  const hits = [];
  for (const f of TEXT_FILES) {
    for (const p of patterns) {
      if (p.re.test(f.content)) hits.push(`${f.relPath} :: ${p.name}`);
    }
  }
  return hits;
}

// =========================================================================================================
// sanity — a broken/empty walk would make every "zero matches" assertion below pass vacuously; fail loud first
// =========================================================================================================
test('[library] the walk finds the vendored tree and the hook signatures imported', () => {
  assert.ok(Array.isArray(INJECTION_PATTERNS) && INJECTION_PATTERNS.length > 0, 'INJECTION_PATTERNS must import from hooks/injection-scan.js (single source of truth with the runtime hook)');
  assert.ok(Array.isArray(UNSAFE_LINK_PATTERNS) && UNSAFE_LINK_PATTERNS.length > 0, 'UNSAFE_LINK_PATTERNS must import from the hook too');
  assert.ok(TEXT_FILES.length >= 20, `expected >=20 vendored text files under library/ (21 compliance checklists + index files), found ${TEXT_FILES.length} — a broken walk would vacuously pass the scans below`);
  assert.ok(TEXT_FILES.some((f) => f.relPath.endsWith('compliance/requirements/gdpr.md')), 'the gdpr.md checklist should be found (canary for the requirements/ tree)');
  assert.ok(BINARY_FILES.length >= 1, `expected at least one vendored binary (the reference PDFs), found ${BINARY_FILES.length}`);
});

// =========================================================================================================
// provenance
// =========================================================================================================
// Empty: every non-index vendored text file currently carries a `> Source:` header. A future vendored text
// file that legitimately cannot goes here (as its relPath) with a `PRE-EXISTING:` justification comment.
const KNOWN_MISSING_PROVENANCE = [];

test('[provenance] every non-index vendored text file carries a Source: header near the top', () => {
  const found = TEXT_FILES
    .filter((f) => !isIndexFile(f.relPath))
    .filter((f) => !PROVENANCE_RE.test(headOf(f.content)))
    .map((f) => f.relPath);
  const { newViolations, stale } = ratchet(found, KNOWN_MISSING_PROVENANCE);
  assert.deepEqual(newViolations, [], `vendored text file(s) missing a "> Source:" provenance header in their first 15 lines:\n${newViolations.join('\n')}`);
  assert.deepEqual(stale, [], `KNOWN_MISSING_PROVENANCE entr(y/ies) that now HAVE a header — remove from the allowlist:\n${stale.join('\n')}`);
});

// Empty: all reference PDFs are cited in library/compliance/references/SOURCES.md. A future uncited binary
// goes here (as its relPath) with a `PRE-EXISTING:` justification comment.
const KNOWN_UNCITED_BINARIES = [];

test('[provenance] every vendored binary file is cited by filename in a SOURCES manifest', () => {
  // Binaries can't carry a Markdown header, so their provenance convention is a SOURCES.md manifest that
  // cites each by filename + source link + license (verified: references/SOURCES.md does exactly this).
  const manifests = TEXT_FILES.filter((f) => /(?:^|\/)SOURCES\.md$/i.test(f.relPath)).map((f) => f.content).join('\n');
  const found = BINARY_FILES.filter((f) => !manifests.includes(path.basename(f.relPath))).map((f) => f.relPath);
  const { newViolations, stale } = ratchet(found, KNOWN_UNCITED_BINARIES);
  assert.deepEqual(newViolations, [], `vendored binary file(s) not cited by filename in any SOURCES.md manifest:\n${newViolations.join('\n')}`);
  assert.deepEqual(stale, [], `KNOWN_UNCITED_BINARIES entr(y/ies) now cited — remove from the allowlist:\n${stale.join('\n')}`);
});

// =========================================================================================================
// content safety — scanned across ALL text files (injection can hide in an index file too; only provenance
// exempts README/SOURCES)
// =========================================================================================================
// Empty: no library file trips a prompt-injection signature. Compliance checklists cite regulations (words
// like "override", "system", "notify the … subject") but none match these high-precision, deliberate-attempt
// patterns. A genuine hit goes here as `${relPath} :: ${signature name}` with a `PRE-EXISTING:` comment.
const KNOWN_FLAGGED = [];

test('[content] no vendored text file matches a prompt-injection signature (imported from the hook)', () => {
  const { newViolations, stale } = ratchet(matchFiles(INJECTION_PATTERNS), KNOWN_FLAGGED);
  assert.deepEqual(newViolations, [], `prompt-injection signature(s) found in vendored library content, NOT in KNOWN_FLAGGED:\n${newViolations.join('\n')}`);
  assert.deepEqual(stale, [], `KNOWN_FLAGGED entr(y/ies) that no longer reproduce — remove from the allowlist:\n${stale.join('\n')}`);
});

// Empty: no library link trips the unsafe-link signatures (the many cited regulatory URLs are all clean
// https, no user:pass@ and no secret-bearing query strings).
const KNOWN_UNSAFE_LINKS = [];

test('[content] no vendored text file carries an unsafe link (javascript: / user:pass@ / token-in-query)', () => {
  const { newViolations, stale } = ratchet(matchFiles(UNSAFE_LINK_PATTERNS), KNOWN_UNSAFE_LINKS);
  assert.deepEqual(newViolations, [], `unsafe link pattern(s) found in vendored content, NOT in KNOWN_UNSAFE_LINKS:\n${newViolations.join('\n')}`);
  assert.deepEqual(stale, [], `KNOWN_UNSAFE_LINKS entr(y/ies) that no longer reproduce — remove from the allowlist:\n${stale.join('\n')}`);
});

// Empty: no library file carries an executable or encoded payload (see PAYLOAD_PATTERNS precision note).
const KNOWN_PAYLOADS = [];

test('[content] no vendored text file carries an executable/encoded payload (script/eval/child_process/long-base64)', () => {
  const { newViolations, stale } = ratchet(matchFiles(PAYLOAD_PATTERNS), KNOWN_PAYLOADS);
  assert.deepEqual(newViolations, [], `executable/encoded payload signature(s) in vendored content, NOT in KNOWN_PAYLOADS:\n${newViolations.join('\n')}`);
  assert.deepEqual(stale, [], `KNOWN_PAYLOADS entr(y/ies) that no longer reproduce — remove from the allowlist:\n${stale.join('\n')}`);
});
