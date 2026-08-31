import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { createCase, listCases, type CaseSeverity, type ServiceCase } from "./cases";
import { createRetriever } from "./knowledge/keywordRetriever";

export interface ToolContext {
  // The browser is the durable store for the MVP: the client keeps every case
  // it has seen in localStorage and sends them with each request, so history
  // survives server restarts even though the server store does not.
  caseHistory?: ServiceCase[];
}

export const toolDefinitions: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "search_knowledge_base",
      description:
        "Search the BMW maintenance knowledge base for procedures, specifications, diagnostics, and safety information. Always call this before answering any technical question, and base your answer only on what it returns.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Search terms describing the issue or procedure, e.g. 'ignition coil replacement N55' or 'tire losing air no puncture'.",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_service_case",
      description:
        "Create a service case so a human technician can review the issue. Use when the problem cannot be resolved with the available knowledge, the customer lacks the tools or ability to safely complete the repair, or the issue involves a safety risk (brakes, airbags, fuel, electrical burning). Confirm with the customer before calling this.",
      parameters: {
        type: "object",
        properties: {
          vehicle: {
            type: "string",
            description: "The customer's vehicle, e.g. 'BMW X4 35i (N55)'. Use 'unknown' if not stated.",
          },
          summary: {
            type: "string",
            description:
              "Concise description of the issue for the technician: what happened, what was attempted, and what is needed.",
          },
          severity: {
            type: "string",
            enum: ["low", "medium", "high"],
            description:
              "high = safety risk or vehicle undrivable; medium = repair blocked mid-way or drivability affected; low = routine assistance.",
          },
        },
        required: ["vehicle", "summary", "severity"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_service_case",
      description:
        "Ask the customer whether they want a service case created. This displays Yes/No confirmation buttons in the chat UI — use this INSTEAD of asking for confirmation in plain text. Call it when escalation is warranted (issue unresolvable from the knowledge base, customer lacks tools/ability, safety risk, or professional-only repair). Do NOT call create_service_case in the same turn; the UI handles the customer's decision.",
      parameters: {
        type: "object",
        properties: {
          vehicle: {
            type: "string",
            description: "The customer's vehicle, e.g. 'BMW X4 35i (N55)'. Use 'unknown' if not stated.",
          },
          summary: {
            type: "string",
            description:
              "Concise description of the issue for the technician: what happened, what was attempted, and what is needed.",
          },
          severity: {
            type: "string",
            enum: ["low", "medium", "high"],
            description:
              "high = safety risk or vehicle undrivable; medium = repair blocked mid-way or drivability affected; low = routine assistance.",
          },
        },
        required: ["vehicle", "summary", "severity"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "offer_next_steps",
      description:
        "After diagnosing a customer-reported issue from the knowledge base, present two choices in the chat UI: create a service case, or attempt the fix themselves with step-by-step guidance. Call this in the same turn as your brief diagnosis summary. Do NOT include repair instructions in that turn — wait for the customer's choice. Do not use this for direct how-to requests, safety risks, or professional-only repairs.",
      parameters: {
        type: "object",
        properties: {
          vehicle: {
            type: "string",
            description: "The customer's vehicle, e.g. 'BMW X4 35i (N55)'. Use 'unknown' if not stated.",
          },
          summary: {
            type: "string",
            description:
              "Concise description of the suspected issue, used for the technician if the customer chooses a service case.",
          },
          severity: {
            type: "string",
            enum: ["low", "medium", "high"],
            description:
              "high = safety risk or vehicle undrivable; medium = drivability affected; low = routine issue.",
          },
        },
        required: ["vehicle", "summary", "severity"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "confirm_vehicle",
      description:
        "Show Yes/No buttons asking the customer to confirm a vehicle before troubleshooting. Call this when a vehicle is already on file (KNOWN CUSTOMER VEHICLE) but the customer has not restated it in this conversation — never assume the saved vehicle is the one they're asking about now. Do not use this when no vehicle is known; ask for it in text instead.",
      parameters: {
        type: "object",
        properties: {
          vehicle: {
            type: "string",
            description: "The vehicle to confirm, e.g. 'BMW X4 35i (N55)'.",
          },
        },
        required: ["vehicle"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "request_feedback",
      description:
        "Show satisfaction-rating buttons (very helpful / somewhat helpful / not helpful) in the chat UI. Call this in the same turn after you have delivered full step-by-step repair instructions, or after telling the customer their service case was created. Do not call it after clarifying questions or partial answers.",
      parameters: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            enum: ["instructions_given", "case_created"],
            description: "What the customer is rating.",
          },
        },
        required: ["reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_service_case_history",
      description:
        "Retrieve the customer's past service cases (ID, vehicle, summary, severity, status, creation date). Call this whenever the customer asks about their previous, existing, or open service requests or case status.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remember_vehicle",
      description:
        "Record the customer's vehicle so it can be recalled in future messages and sessions without asking again. Call this the first time the customer states their car (make/model/engine), or if they correct a previously stated vehicle.",
      parameters: {
        type: "object",
        properties: {
          vehicle: {
            type: "string",
            description: "The customer's vehicle in a normalized form, e.g. 'BMW X4 35i (N55)'.",
          },
        },
        required: ["vehicle"],
      },
    },
  },
];

const retriever = createRetriever();

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  context: ToolContext = {}
): Promise<Record<string, unknown>> {
  switch (name) {
    case "search_knowledge_base": {
      const results = await retriever.search(String(args.query ?? ""));
      return {
        results: results.map(({ chunk, score }) => ({
          title: chunk.title,
          source: chunk.source,
          vehicle: chunk.vehicle,
          content: chunk.content,
          relevanceScore: score,
        })),
        resultCount: results.length,
      };
    }
    case "create_service_case": {
      const serviceCase = createCase({
        vehicle: String(args.vehicle ?? "unknown"),
        summary: String(args.summary ?? ""),
        severity: (args.severity as CaseSeverity) ?? "medium",
      });
      return { case: serviceCase };
    }
    case "offer_next_steps": {
      return {
        optionsDisplayed: true,
        vehicle: String(args.vehicle ?? "unknown"),
        summary: String(args.summary ?? ""),
        severity: (args.severity as CaseSeverity) ?? "medium",
        note: "Choice buttons (service case vs. fix it myself) are now shown to the customer. Give your brief diagnosis summary with sources, ending with your recommendation on whether this is DIY-feasible or better handled by a technician (and why), then end your turn and wait for their choice.",
      };
    }
    case "propose_service_case": {
      return {
        proposalDisplayed: true,
        vehicle: String(args.vehicle ?? "unknown"),
        summary: String(args.summary ?? ""),
        severity: (args.severity as CaseSeverity) ?? "medium",
        note: "Confirmation buttons are now shown to the customer. Briefly explain why you recommend a service case, then end your turn and wait for their decision.",
      };
    }
    case "confirm_vehicle": {
      return {
        confirmationDisplayed: true,
        vehicle: String(args.vehicle ?? ""),
        note: "Yes/No vehicle-confirmation buttons are now shown. Ask one short confirmation question (e.g. 'Just to confirm, is this about your BMW X4 35i?'), then end your turn and wait.",
      };
    }
    case "request_feedback": {
      return {
        feedbackRequested: true,
        reason: String(args.reason ?? "instructions_given"),
        note: "Satisfaction buttons are now shown to the customer. Finish your response normally; do not ask for a rating in text. If this turn delivered repair instructions, remember to end with the one-sentence reminder that a service case can be created if they get stuck.",
      };
    }
    case "get_service_case_history": {
      const merged = new Map<string, ServiceCase>();
      for (const c of context.caseHistory ?? []) merged.set(c.id, c);
      for (const c of listCases()) merged.set(c.id, c);
      const cases = [...merged.values()].sort((a, b) =>
        a.createdAt.localeCompare(b.createdAt)
      );
      return { cases, caseCount: cases.length };
    }
    case "remember_vehicle": {
      const vehicle = String(args.vehicle ?? "").trim();
      return { remembered: vehicle.length > 0, vehicle };
    }
    default:
      return { error: `Unknown tool: ${name}` };
  }
}
