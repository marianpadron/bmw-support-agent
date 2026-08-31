import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { ServiceCase } from "./cases";
import { executeTool, toolDefinitions, type ToolContext } from "./tools";
import { debug } from "./debug";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

// The client persists this in localStorage today, so it only survives on one browser/device.
// A production version would key this by an authenticated user/customer ID in a database
// (e.g. Postgres, or a CRM record) so the vehicle and history follow the person across
// devices and sessions, not just the local browser.
export interface CustomerProfile {
  vehicle?: string;
}

export interface CaseProposal {
  vehicle: string;
  summary: string;
  severity: "low" | "medium" | "high";
}

export interface AgentResult {
  message: string;
  meta: {
    toolCallsMade: string[];
    caseCreated?: ServiceCase;
    proposedCase?: CaseProposal;
    nextStepOptions?: CaseProposal;
    profile?: CustomerProfile;
    feedbackRequested?: boolean;
    vehicleToConfirm?: string;
  };
}

// Provider gateway: both providers speak the OpenAI chat-completions dialect
// (Gemini via its OpenAI-compatibility endpoint), so the same client, loop,
// and tool schemas work for either. Switch with LLM_PROVIDER=gemini|groq.
const PROVIDERS = {
  gemini: {
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
    apiKeyEnv: "GEMINI_API_KEY",
    defaultModel: "gemini-flash-latest",
  },
  groq: {
    baseURL: "https://api.groq.com/openai/v1",
    apiKeyEnv: "GROQ_API_KEY",
    defaultModel: "openai/gpt-oss-120b",
  },
} as const;

const PROVIDER = PROVIDERS[(process.env.LLM_PROVIDER as keyof typeof PROVIDERS) ?? "gemini"];
const MODEL = process.env.LLM_MODEL ?? PROVIDER.defaultModel;
const MAX_ITERATIONS = 5;

const SYSTEM_PROMPT = `
  You are a BMW maintenance support specialist. You help BMW owners troubleshoot and perform maintenance on their vehicles.

  GROUNDING RULES:

  * Always call search_knowledge_base before answering any technical question.
  * Base procedures, torque specs, part details, and diagnostics ONLY on retrieved knowledge.
  * If the knowledge base does not cover something, say so plainly. Never invent torque values, part numbers, or procedures.
  * Only answer questions about BMW vehicles and general car maintenance. Politely decline anything else.

  VEHICLE IDENTIFICATION:

  * Before troubleshooting or providing maintenance instructions, always verify which vehicle the user is asking about.
  * If a KNOWN CUSTOMER VEHICLE is on file but the user has not restated it in this conversation, call confirm_vehicle with that vehicle — the UI shows Yes/No buttons. Ask one short confirmation question and end your turn. Never assume the saved vehicle is the one they mean now.
  * Once the user confirms (button or message), proceed and do not ask again in this conversation.
  * If the user says it is a different vehicle, ask which vehicle, then call remember_vehicle with the correction.
  * If no vehicle is known at all, ask the user to specify it before proceeding.
  * If additional vehicle information is required by the knowledge base to identify the correct procedure (such as model year, engine, generation, or drivetrain), ask for the necessary information.
  * Do not assume the vehicle model, engine, year, or configuration.
  * If the specified BMW model/configuration does not exist in the knowledge base, tell the user that the knowledge base does not contain information for that vehicle and create a service request.
  * Never provide instructions based on a similar BMW model when the requested model/configuration is not supported by the knowledge base.

  RESPONSE FLOW FOR REPORTED ISSUES (symptoms, problems, "my car is doing X"):

  * Search the knowledge base first, as always.
  * Your first response after retrieving knowledge must contain ONLY a brief diagnosis summary: 2-3 sentences on what is likely happening and why. Do NOT include step-by-step instructions, tool lists, or repair tables in this response.
  * End that summary with your recommendation: one or two sentences saying whether this looks like something the customer can reasonably tackle themselves (mention the difficulty) or whether you recommend professional service. Base the recommendation on the retrieved knowledge (difficulty, tools required, safety notes, professional-only designations).
  * In that same turn, call offer_next_steps so the customer can choose between creating a service case or attempting the fix themselves. The choice is always theirs — your recommendation guides, it does not decide.
  * If the customer chooses to fix it themselves (via button or their own message), THEN provide the full step-by-step instructions from the knowledge base.
  * If the customer chooses a service case, the UI creates it automatically.
  * EXCEPTIONS — skip offer_next_steps:
    * Direct how-to requests ("how do I replace my ignition coils?") get the full procedure immediately.
    * Safety risks, professional-only repairs, knowledge-base gaps, or a customer who already said they lack the tools: use propose_service_case instead, since DIY is not an appropriate option.
  * ALWAYS after delivering step-by-step instructions (whether from a DIY choice or a direct how-to request): end your response with one short sentence reminding the customer that if they get stuck or run into trouble at any point, you can create a service case to have a technician help. Never omit this closing reminder.
  * If the customer later says they are stuck, something broke, or they cannot complete a step, call propose_service_case.

  FOLLOW-UP QUESTION RULES:

  * If you do not have enough information from the user to identify the correct information or procedure in the knowledge base, ask a follow-up question.
  * You may ask a maximum of 2 follow-up questions during a troubleshooting interaction before escalation.
  * Questions should be targeted and necessary to determine what information or procedure applies.
  * After the maximum of 2 follow-up questions, if you still cannot determine the appropriate solution from the knowledge base, do not continue guessing or asking additional questions. Explain that you cannot determine the correct solution and create a service request.
  * Once sufficient information has been provided, call search_knowledge_base and use the retrieved information to determine the appropriate response.

  KNOWLEDGE BASE FAILURE / ESCALATION:

  * If the knowledge base does not contain enough information to safely or confidently resolve the user's issue, do not guess or provide unsupported instructions.
  * If the issue cannot be resolved using the retrieved knowledge after the allowed follow-up questions, create a service request.
  * Recommend creating a service case when:

    * The knowledge base cannot resolve the issue.
    * The customer lacks the tools or ability to safely complete the repair.
    * The issue involves a safety risk (brakes, airbags, fuel system, electrical burning smells).
    * The knowledge base explicitly identifies the repair as professional-only.
  * Ask the customer to confirm before calling create_service_case.
  * After creating a service case, tell the user the case ID and briefly explain what happens next.

  PROFESSIONAL-ONLY REPAIRS:

  * For issues the knowledge base marks as professional-only (brakes, transmission, airbags, engine internals), do not provide DIY instructions.
  * Explain that the repair requires professional service and offer to create a service case.
  * Do not override the knowledge base's professional-only designation.

  OFF-TOPIC REQUESTS:

  * Only assist with BMW vehicles, BMW maintenance, troubleshooting, repairs, and general car maintenance.
  * If the user asks questions or provides prompts unrelated to maintaining, troubleshooting, or repairing a vehicle, politely explain that you are unable to assist with that request.
  * For an unrelated request, do not attempt to answer the question or continue the unrelated conversation.
  * Inform the user that you will create a service request to assist with their needs.
  * Ask for confirmation before calling create_service_case, consistent with the escalation rules.

  SERVICE REQUEST BEHAVIOR:

  * When escalation is warranted, call propose_service_case — this shows the customer Yes/No confirmation buttons in the chat UI. Do not ask for confirmation in plain text, and do not call create_service_case in the same turn.
  * Alongside the proposal, briefly explain why the service request is necessary.
  * The UI handles the customer's button choice; the case is created automatically if they accept. Only call create_service_case directly if the customer explicitly asks for a case in their own written message (e.g. "yes, create the case").
  * If the customer declines, continue helping within the knowledge base's limits and do not re-propose unless circumstances change.
  * When a case has been created, provide the case ID and explain the next step.
  * When the customer asks about their previous, existing, or open service requests, call get_service_case_history and summarize each case in plain text (ID, vehicle, issue, status, date). If there are none, say so plainly.

  FEEDBACK:

  * After delivering full step-by-step repair instructions, or after confirming a service case was created, call request_feedback in that same turn so the customer can rate the experience.
  * Do not ask for a rating in your text; the UI shows the rating buttons.
  * Do not call request_feedback after clarifying questions, partial answers, or diagnosis summaries.

  STYLE:

  * Respond in plain conversational text only. Never use markdown formatting: no asterisks for bold or italics, no # headings, no tables, no bullet-point symbols, no code blocks, no horizontal rules.
  * Be conversational, clear, and practical.
  * Use simple numbered steps for procedures, written as plain lines like "1. Remove the plastic cover." — nothing more elaborate.
  * Keep responses focused on the user's specific issue.
  * Mention relevant safety precautions from the knowledge base alongside procedures.
  * Do not overwhelm the user with unnecessary technical information.
  * Never fabricate information when the knowledge base does not provide an answer.

`;

const SAFETY_PATTERNS: { pattern: RegExp; concern: string }[] = [
  { pattern: /fuel (leak|smell|odor)|smell(s|ing)? (of )?(gas|gasoline|fuel)/i, concern: "possible fuel leak" },
  { pattern: /brake(s)? (fail|failed|failing|not work|went out|to the floor)/i, concern: "brake failure" },
  { pattern: /airbag/i, concern: "airbag system involvement" },
  { pattern: /(smoke|burning smell) .*(driving|engine|hood)|(engine|hood).* (smoke|burning)/i, concern: "smoke or burning while operating" },
];

function detectSafetyConcern(message: string): string | undefined {
  return SAFETY_PATTERNS.find(({ pattern }) => pattern.test(message))?.concern;
}

function toProviderMessages(messages: ChatMessage[]): ChatCompletionMessageParam[] {
  return messages.map((m) => ({ role: m.role, content: m.content }));
}


function truncate(value: unknown, max = 300): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// The prompt forbids markdown, but models still slip it in occasionally.
// This strips the common syntax while leaving the words untouched.
export function stripMarkdown(text: string): string {
  return (
    text
      // fenced code blocks: keep the inner content
      .replace(/```[a-z]*\n?([\s\S]*?)```/gi, "$1")
      // inline code
      .replace(/`([^`]+)`/g, "$1")
      // bold / italics (**text**, *text*, __text__, _text_)
      .replace(/(\*\*|__)(.*?)\1/g, "$2")
      .replace(/(^|\s)[*_]([^*_\n]+)[*_](?=[\s.,;:!?)]|$)/gm, "$1$2")
      // headings: "### Title" -> "Title"
      .replace(/^#{1,6}\s+/gm, "")
      // links: [label](url) -> label
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      // bullet markers: "- item" / "* item" / "+ item" -> "item"
      .replace(/^\s*[-*+]\s+/gm, "")
      // blockquotes
      .replace(/^>\s?/gm, "")
      // horizontal rules on their own line
      .replace(/^[ \t]*([-*_][ \t]*){3,}$/gm, "")
      // table rows: drop separator lines, turn "| a | b |" into "a  b"
      .replace(/^\s*\|?[\s:|-]+\|[\s:|-]*$/gm, "")
      .replace(/^\s*\|(.+)\|\s*$/gm, (_, row: string) =>
        row
          .split("|")
          .map((cell: string) => cell.trim())
          .filter(Boolean)
          .join("  ")
      )
      // collapse the blank-line pileup left behind
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

interface AssembledTurn {
  content: string;
  toolCalls: {
    id: string;
    name: string;
    arguments: string;
    // Gemini (via its OpenAI-compat endpoint) attaches a thought signature in
    // extra_content and requires it to be echoed back with the tool call in
    // the follow-up request — dropping it gets a 400.
    extraContent?: unknown;
  }[];
}

// Every call streams: we can't know a turn is final until we see whether it
// contains tool calls, so tool-call deltas are assembled silently while any
// text deltas are forwarded to onDelta as they arrive.
// Also retries on "tool_use_failed" (a malformed model tool call — a model
// output problem, not a request problem), but only if nothing was streamed yet.
async function streamCompletion(
  client: OpenAI,
  conversation: ChatCompletionMessageParam[],
  onDelta?: (text: string) => void,
  retries = 2
): Promise<AssembledTurn> {
  for (let attempt = 0; ; attempt++) {
    let content = "";
    const toolCalls: AssembledTurn["toolCalls"] = [];
    try {
      const stream = await client.chat.completions.create({
        model: MODEL,
        messages: conversation,
        tools: toolDefinitions,
        tool_choice: "auto",
        stream: true,
        // Explicit output budget: Gemini counts thinking tokens toward the
        // cap, and the provider default can truncate long procedures.
        max_tokens: 8192,
      });
      let finishReason: string | null = null;
      for await (const chunk of stream) {
        if (chunk.choices[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason;
        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;
        if (delta.content) {
          content += delta.content;
          onDelta?.(delta.content);
        }
        for (const tc of delta.tool_calls ?? []) {
          // Groq/OpenAI fragment calls and identify them by `index`; Gemini's
          // compat endpoint omits `index` and sends each call whole with an
          // `id` — treat an id (or the very first delta) as a new call.
          let i: number;
          if (typeof tc.index === "number") {
            i = tc.index;
          } else if (tc.id || toolCalls.length === 0) {
            i = toolCalls.length;
          } else {
            i = toolCalls.length - 1;
          }
          toolCalls[i] ??= { id: "", name: "", arguments: "" };
          if (tc.id) toolCalls[i].id = tc.id;
          if (tc.function?.name) toolCalls[i].name += tc.function.name;
          if (tc.function?.arguments) toolCalls[i].arguments += tc.function.arguments;
          const extra = (tc as { extra_content?: unknown }).extra_content;
          if (extra) toolCalls[i].extraContent = extra;
        }
      }
      if (finishReason && finishReason !== "stop" && finishReason !== "tool_calls") {
        debug(`WARNING: stream ended with finish_reason=${finishReason} (output may be truncated)`);
      }
      return {
        content,
        // Gemini's compat endpoint may omit tool-call ids; the follow-up
        // request needs matching non-empty ids, so synthesize them.
        toolCalls: toolCalls
          .filter(Boolean)
          .map((c, i) => ({ ...c, id: c.id || `call_${i}` })),
      };
    } catch (error) {
      const code = (error as { error?: { error?: { code?: string } } })?.error?.error?.code;
      if (code === "tool_use_failed" && attempt < retries && content.length === 0) {
        debug(`tool_use_failed from model, retrying (attempt ${attempt + 1}/${retries})`);
        continue;
      }
      throw error;
    }
  }
}

export async function runAgent(
  messages: ChatMessage[],
  profile: CustomerProfile = {},
  caseHistory: ServiceCase[] = [],
  onDelta?: (text: string) => void
): Promise<AgentResult> {
  const client = new OpenAI({
    apiKey: process.env[PROVIDER.apiKeyEnv],
    baseURL: PROVIDER.baseURL,
  });

  debug("incoming user message", messages.at(-1)?.content);

  const lastUserMessage = messages.filter((m) => m.role === "user").at(-1);
  const safetyConcern = lastUserMessage && detectSafetyConcern(lastUserMessage.content);
  if (safetyConcern) debug("safety concern detected", safetyConcern);

  let systemPrompt = safetyConcern
    ? `${SYSTEM_PROMPT}\n\nSAFETY ALERT: the customer's latest message indicates ${safetyConcern}. Prioritize safety guidance (stop driving if applicable), keep troubleshooting minimal, and offer to create a high-severity service case.`
    : SYSTEM_PROMPT;
  if (profile.vehicle) {
    systemPrompt += `\n\nKNOWN CUSTOMER VEHICLE: ${profile.vehicle}`;
    debug("known vehicle from profile", profile.vehicle);
  }

  const conversation: ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    ...toProviderMessages(messages),
  ];

  const meta: AgentResult["meta"] = { toolCallsMade: [] };

  const spoken: string[] = [];

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    debug(`--- iteration ${i + 1}/${MAX_ITERATIONS}: calling LLM (streaming) ---`);

    let firstDeltaOfTurn = true;
    const turnDelta = onDelta
      ? (text: string) => {
          if (firstDeltaOfTurn && spoken.length > 0) onDelta("\n\n");
          firstDeltaOfTurn = false;
          onDelta(text);
        }
      : undefined;

    const turn = await streamCompletion(client, conversation, turnDelta);

    if (turn.toolCalls.length === 0) {
      debug("model returned final answer (no tool calls)", truncate(turn.content));
      const fullReply = [...spoken, turn.content].filter(Boolean).join("\n\n");
      return { message: stripMarkdown(fullReply), meta };
    }

    if (turn.content.trim()) spoken.push(turn.content);

    debug(
      `model requested ${turn.toolCalls.length} tool call(s)`,
      turn.toolCalls.map((c) => c.name)
    );

    conversation.push({
      role: "assistant",
      content: turn.content || null,
      tool_calls: turn.toolCalls.map((c) => ({
        id: c.id,
        type: "function" as const,
        function: { name: c.name, arguments: c.arguments },
        // Echo Gemini's thought signature back (required by Gemini 3 models;
        // unknown fields are ignored by other providers).
        ...(c.extraContent ? { extra_content: c.extraContent } : {}),
      })),
    });

    for (const call of turn.toolCalls) {
      const name = call.name;
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(call.arguments || "{}");
      } catch {
        args = {};
      }
      debug(`calling tool: ${name}`, args);

      meta.toolCallsMade.push(
        name === "search_knowledge_base" ? `${name}: "${args.query}"` : name
      );

      const context: ToolContext = { caseHistory };
      const result = await executeTool(name, args, context);
      debug(`tool result: ${name}`, truncate(result));

      if (name === "create_service_case" && result.case) {
        meta.caseCreated = result.case as ServiceCase;
      }
      if (name === "propose_service_case" && result.proposalDisplayed) {
        meta.proposedCase = {
          vehicle: result.vehicle as string,
          summary: result.summary as string,
          severity: result.severity as CaseProposal["severity"],
        };
      }
      if (name === "offer_next_steps" && result.optionsDisplayed) {
        meta.nextStepOptions = {
          vehicle: result.vehicle as string,
          summary: result.summary as string,
          severity: result.severity as CaseProposal["severity"],
        };
      }
      if (name === "remember_vehicle" && result.remembered) {
        meta.profile = { ...meta.profile, vehicle: result.vehicle as string };
      }
      if (name === "request_feedback" && result.feedbackRequested) {
        meta.feedbackRequested = true;
      }
      if (name === "confirm_vehicle" && result.confirmationDisplayed) {
        meta.vehicleToConfirm = result.vehicle as string;
      }
      conversation.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(result),
      });
    }
  }

  debug(`hit MAX_ITERATIONS (${MAX_ITERATIONS}) without a final answer`);
  const fallback =
    "I wasn't able to finish working through that. Could you rephrase, or would you like me to create a service case for a technician to review?";
  return {
    message: stripMarkdown([...spoken, fallback].join("\n\n")),
    meta,
  };
}
