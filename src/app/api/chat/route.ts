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

  try {
    const result = await runAgent(
      messages,
      profile ?? {},
      Array.isArray(caseHistory) ? caseHistory : []
    );
    return Response.json(result);
  } catch (error) {
    console.error("Agent error:", error);
    return Response.json(
      { error: "Something went wrong while processing your request. Please try again." },
      { status: 500 }
    );
  }
}
