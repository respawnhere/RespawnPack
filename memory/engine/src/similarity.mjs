// Lesson 5: near-duplicate detection for `rmem doctor`. A small, dependency-free Jaro-Winkler
// string similarity — NOT a search-ranking signal (search/recall stay hybrid vector+FTS; see
// retrieve.mjs) and NOT MinHash/LSH (that solves auto-extraction-scale noise this hand-curated
// graph doesn't have). Deliberately tiny; used only by doctor.mjs's read-only, flag-only
// nearDuplicates check.

/** Jaro similarity in [0,1]. */
function jaro(a, b) {
  if (a === b) return 1;
  const al = a.length, bl = b.length;
  if (!al || !bl) return 0;
  const matchDist = Math.max(0, Math.floor(Math.max(al, bl) / 2) - 1);
  const aMatched = new Array(al).fill(false);
  const bMatched = new Array(bl).fill(false);
  let matches = 0;
  for (let i = 0; i < al; i++) {
    const start = Math.max(0, i - matchDist), end = Math.min(i + matchDist + 1, bl);
    for (let j = start; j < end; j++) {
      if (bMatched[j] || a[i] !== b[j]) continue;
      aMatched[i] = bMatched[j] = true;
      matches++;
      break;
    }
  }
  if (!matches) return 0;
  let t = 0, k = 0;
  for (let i = 0; i < al; i++) {
    if (!aMatched[i]) continue;
    while (!bMatched[k]) k++;
    if (a[i] !== b[k]) t++;
    k++;
  }
  t /= 2;
  return (matches / al + matches / bl + (matches - t) / matches) / 3;
}

/** Jaro-Winkler: boosts Jaro similarity for a shared prefix (up to 4 chars, scale 0.1) — better
 * than plain Jaro for our case since near-duplicate entity labels/slugs usually share a stem
 * ("redis-tls-mismatch" vs "redis-tls-missmatch"). @param {string} a @param {string} b */
export function jaroWinkler(a, b) {
  const j = jaro(a, b);
  const max = Math.min(4, a.length, b.length);
  let prefix = 0;
  while (prefix < max && a[prefix] === b[prefix]) prefix++;
  return j + prefix * 0.1 * (1 - j);
}

/** Normalized comparison text for an entity: slug (dashes -> spaces) + aliases, lowercased and
 * whitespace-collapsed — the same normalization spirit as store.mjs's observation-text dedup.
 * @param {{slug?:string, aliases?:string[]}} e */
export function comparableLabel(e) {
  const parts = [String(e.slug || '').replace(/-/g, ' '), ...((e.aliases || []).map(String))];
  return parts.join(' ').toLowerCase().trim().replace(/\s+/g, ' ');
}
