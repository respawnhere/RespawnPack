// Local-but-real embeddings via Ollama (no cloud, no API key). The dim is whatever the
// model returns (probed at engine init), so the `dim` here is only a hint.
/** @param {{model?:string, baseUrl?:string, dim?:number}} [o] */
export function ollamaEmbedder({ model = 'nomic-embed-text', baseUrl = 'http://localhost:11434', dim = 768 } = {}) {
  return {
    dim,
    id: `ollama:${model}`,
    /** @param {string[]} texts @returns {Promise<number[][]>} */
    async embed(texts) {
      const out = [];
      for (const t of texts) {
        const r = await fetch(`${baseUrl}/api/embeddings`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model, prompt: String(t) }),
        });
        if (!r.ok) throw new Error(`ollama embeddings HTTP ${r.status} (is \`ollama serve\` running with \`ollama pull ${model}\`?)`);
        const j = await r.json();
        if (!Array.isArray(j.embedding)) throw new Error('ollama: no embedding in response');
        out.push(j.embedding);
      }
      return out;
    },
  };
}
