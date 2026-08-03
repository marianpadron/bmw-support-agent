import { knowledgeBase } from "./kb";
import type { KnowledgeChunk, KnowledgeRetriever, RetrievalResult } from "./types";

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "can", "do", "does",
  "for", "from", "has", "have", "how", "i", "if", "in", "is", "it", "its",
  "my", "of", "on", "or", "so", "that", "the", "then", "there", "this", "to",
  "was", "what", "when", "where", "which", "will", "with", "you", "your",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/[\s-]+/)
    .filter((token) => token.length > 1 && !STOPWORDS.has(token));
}

const TITLE_WEIGHT = 3;
const TOPIC_WEIGHT = 2;
const CONTENT_WEIGHT = 1;

function scoreChunk(queryTokens: string[], chunk: KnowledgeChunk): number {
  const titleTokens = new Set(tokenize(chunk.title));
  const topicTokens = new Set(tokenize(`${chunk.topic} ${chunk.vehicle}`));
  const contentTokens = new Set(tokenize(chunk.content));

  let score = 0;
  for (const token of new Set(queryTokens)) {
    if (titleTokens.has(token)) score += TITLE_WEIGHT;
    if (topicTokens.has(token)) score += TOPIC_WEIGHT;
    if (contentTokens.has(token)) score += CONTENT_WEIGHT;
  }
  return score;
}

class KeywordRetriever implements KnowledgeRetriever {
  constructor(private readonly chunks: KnowledgeChunk[]) {}

  async search(query: string, k = 3): Promise<RetrievalResult[]> {
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return [];

    return this.chunks
      .map((chunk) => ({ chunk, score: scoreChunk(queryTokens, chunk) }))
      .filter((result) => result.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }
}

export function createRetriever(): KnowledgeRetriever {
  return new KeywordRetriever(knowledgeBase);
}
