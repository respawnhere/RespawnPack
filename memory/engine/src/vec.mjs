// Validate an embedding before it reaches the pgvector `::vector` cast. A malicious or buggy
// provider (NaN/Infinity/wrong length/non-array) would otherwise abort an insert or a whole
// sync mid-rebuild. Parameterized, so this is correctness/robustness, not SQL-injection.
/** @param {unknown} v @param {number} dim @returns {string} pgvector literal */
export function toVectorLiteral(v, dim) {
  if (!Array.isArray(v) || v.length !== dim || !v.every((x) => Number.isFinite(x))) {
    throw new Error(`embeddings provider returned a malformed vector (expected ${dim} finite numbers, got ${Array.isArray(v) ? `${v.length}` : typeof v})`);
  }
  return `[${v.join(',')}]`;
}
