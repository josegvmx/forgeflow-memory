import { createHash } from 'node:crypto';

/**
 * sha256 of the exact text sent to the embedding model (embedding_cache.text_hash,
 * reasoning_events.embed_text_hash). Kept free of database imports so pure modules
 * (the export reader, tests) can use it without DATABASE_URL.
 */
export const textHash = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
