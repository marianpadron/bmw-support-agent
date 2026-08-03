import { runAgent } from "../src/lib/agent";

async function main() {
  console.log("=== Session 1: customer states their vehicle ===");
  const session1 = await runAgent([
    { role: "user", content: "Hey, I have a BMW X4 35i with the N55 engine." },
  ]);
  console.log("tools:", session1.meta.toolCallsMade);
  console.log("profile learned:", session1.meta.profile);
  console.log(session1.message);

  const rememberedProfile = session1.meta.profile ?? {};

  console.log("\n=== Session 2 (fresh conversation, profile passed in): ===");
  const session2 = await runAgent(
    [{ role: "user", content: "My ignition coils need replacing, how do I do it?" }],
    rememberedProfile
  );
  console.log("tools:", session2.meta.toolCallsMade);
  console.log(session2.message.slice(0, 300));
}

main();
