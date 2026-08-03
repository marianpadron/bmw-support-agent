// Shared by server code (agent.ts) and client components (Chat.tsx).
// Server: set AGENT_DEBUG=false to silence. Client: set NEXT_PUBLIC_DEBUG=false
// (only NEXT_PUBLIC_-prefixed vars are inlined into the browser bundle).
// On by default so `npm run dev` shows the agent's reasoning in the terminal
// and the client's state updates in the browser console.
const DEBUG =
  process.env.AGENT_DEBUG !== "false" && process.env.NEXT_PUBLIC_DEBUG !== "false";

export function debug(label: string, data?: unknown) {
  if (!DEBUG) return;
  if (data === undefined) {
    console.log(`[agent] ${label}`);
  } else {
    console.log(`[agent] ${label}`, data);
  }
}
