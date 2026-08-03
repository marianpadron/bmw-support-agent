export interface KnowledgeChunk {
  id: string;
  title: string;
  topic: string; // "ignition-coils" | "spark-plugs" | "safety" | ...
  vehicle: string; // "BMW X4 35i (N55)" or "all"
  source: string; // "BMW TIS manual", "YouTube: <channel> — <video>"
  content: string; // 100–300 words, self-contained
}

export interface RetrievalResult {
  chunk: KnowledgeChunk;
  score: number;
}

export interface KnowledgeRetriever {
  search(query: string, k?: number): Promise<RetrievalResult[]>;
}
