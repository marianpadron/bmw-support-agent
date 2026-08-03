import { runAgent, type ChatMessage, type CustomerProfile } from "@/lib/agent";

function isValidMessage(value: unknown): value is ChatMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Record<string, unknown>;
  return (
    (message.role === "user" || message.role === "assistant") &&
    typeof message.content === "string" &&
    message.content.length > 0
  );
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { messages, profile, caseHistory } = body as {
    messages?: unknown;
    profile?: CustomerProfile;
    caseHistory?: unknown;
  };
  if (!Array.isArray(messages) || messages.length === 0 || !messages.every(isValidMessage)) {
    return Response.json(
      { error: "Body must be { messages: { role: 'user' | 'assistant', content: string }[] }." },
      { status: 400 }
    );
  }

  // NDJSON stream: {type:"delta", text} events as tokens arrive, then one
  // {type:"final", message, meta} with the cleaned-up text and metadata.
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: Record<string, unknown>) =>
        controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      try {
        const result = await runAgent(
          messages,
          profile ?? {},
          Array.isArray(caseHistory) ? caseHistory : [],
          (text) => send({ type: "delta", text })
        );
        send({ type: "final", message: result.message, meta: result.meta });
      } catch (error) {
        console.error("Agent error:", error);
        send({
          type: "error",
          error: "Something went wrong while processing your request. Please try again.",
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache" },
  });
}
