import { createRetriever } from "../src/lib/knowledge/keywordRetriever";

const queries = [
  "I have a BMW X4 35i and need to replace my ignition coils. How do I do it?",
  "The rubber boot from my ignition coil broke and is stuck around the spark plug in cylinder 6. I can't reach it and don't have the right tools.",
  "my tire keeps losing air but I can't find a puncture",
  "how do I fix my transmission myself",
];

async function main() {
  const retriever = createRetriever();

  for (const query of queries) {
    const results = await retriever.search(query);
    console.log(`\nQuery: ${query}`);
    if (results.length === 0) {
      console.log("  (no results)");
      continue;
    }
    for (const { chunk, score } of results) {
      console.log(`  [${score}] ${chunk.id} — ${chunk.title}`);
    }
  }
}

main();
