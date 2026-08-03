import { runAgent } from "../src/lib/agent";

async function main() {
  console.log("=== Flow 1: successful troubleshooting ===");
  const flow1 = await runAgent([
    {
      role: "user",
      content: "I have a BMW X4 35i and need to replace my ignition coils. How do I do it?",
    },
  ]);
  console.log("tools:", flow1.meta.toolCallsMade);
  console.log(flow1.message);

  console.log("\n=== Flow 2: escalation ===");
  const turn1: { role: "user" | "assistant"; content: string }[] = [
    {
      role: "user",
      content:
        "I was changing the ignition coils on my BMW X4 35i and the rubber boot from one coil broke off. It's stuck around the spark plug in cylinder 6, I can't reach it and don't have the right tools.",
    },
  ];
  const flow2a = await runAgent(turn1);
  console.log("tools:", flow2a.meta.toolCallsMade);
  console.log(flow2a.message);

  const flow2b = await runAgent([
    ...turn1,
    { role: "assistant", content: flow2a.message },
    { role: "user", content: "Yes, please create the case." },
  ]);
  console.log("\n--- after confirmation ---");
  console.log("tools:", flow2b.meta.toolCallsMade);
  console.log("case created:", JSON.stringify(flow2b.meta.caseCreated, null, 2));
  console.log(flow2b.message);
}

main();
