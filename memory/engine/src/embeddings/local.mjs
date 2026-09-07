import { createHash } from 'node:crypto';

// Zero-config, offline, DETERMINISTIC embedder — feature-hashed bag-of-tokens, L2-normalized.
// Not semantic: it captures lexical overlap only. It exists so the engine runs and tests with
// no API key / no Ollama. Configure a real provider (ollama/openai) for retrieval quality.
/** @param {number} dim */
export function localEmbedder(dim = 256) {
  return {
    dim,
    id: `local:hash-${dim}`,
    /** @param {string[]} texts @returns {Promise<number[][]>} */
    async embed(texts) {
      return texts.map((t) => {
        const v = new Float32Array(dim);
        const toks = String(t).toLowerCase().match(/[a-z0-9_]+/g) || [];
        for (const tok of toks) {
          const h = createHash('md5').update(tok).digest();
          const idx = ((h[0] << 8) | h[1]) % dim;
          v[idx] += (h[2] & 1) ? 1 : -1;
        }
        let n = 0;
        for (let i = 0; i < dim; i++) n += v[i] * v[i];
        n = Math.sqrt(n) || 1;
        const out = new Array(dim);
        for (let i = 0; i < dim; i++) out[i] = v[i] / n;
        return out;
      });
    },
  };
}
