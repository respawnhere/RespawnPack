import { localEmbedder } from './local.mjs';
import { ollamaEmbedder } from './ollama.mjs';
import { openaiEmbedder } from './openai.mjs';

/** Factory: pick the embedder from config. Pluggable, no hard cloud default. */
export function getEmbedder(cfg) {
  const e = (cfg && cfg.embeddings) || {};
  switch (e.provider) {
    case 'ollama': return ollamaEmbedder(e);
    case 'openai': return openaiEmbedder(e);
    case 'local':
    case undefined:
    case null:
      return localEmbedder(e.dim || 256);
    default:
      throw new Error(`unknown embeddings provider: ${e.provider} (use local | ollama | openai)`);
  }
}
