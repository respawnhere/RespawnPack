// Hosted embeddings via any OpenAI-compatible endpoint (OpenAI, Voyage, together, etc.).
// Configure baseUrl + model + the env var holding the key. Batches in one request.
/** @param {{model?:string, baseUrl?:string, apiKeyEnv?:string, dim?:number}} [o] */
export function openaiEmbedder({ model = 'text-embedding-3-small', baseUrl = 'https://api.openai.com/v1', apiKeyEnv = 'OPENAI_API_KEY', dim = 1536 } = {}) {
  return {
    dim,
    id: `openai:${model}`,
    /** @param {string[]} texts @returns {Promise<number[][]>} */
    async embed(texts) {
      const key = process.env[apiKeyEnv];
      if (!key) throw new Error(`openai embeddings: missing env ${apiKeyEnv}`);
      const r = await fetch(`${baseUrl.replace(/\/$/, '')}/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, input: texts.map(String) }),
      });
      if (!r.ok) throw new Error(`openai embeddings HTTP ${r.status}`);
      const j = await r.json();
      return j.data.map((d) => d.embedding);
    },
  };
}
