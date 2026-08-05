export { OllamaEmbeddingClient, type OllamaClientConfig } from './client.js';
export {
  OllamaChatClient,
  DEFAULT_CHAT_MODEL,
  type OllamaChatConfig,
  type ChatMessage,
} from './chat.js';
export { checkOllamaHealth, type OllamaHealthStatus } from './health.js';
export type { EmbeddingRequest, EmbeddingResponse, OllamaTagsResponse } from './types.js';
