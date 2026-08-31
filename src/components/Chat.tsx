"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { debug } from "@/lib/debug";

interface Message {
  role: "user" | "assistant";
  content: string;
}

interface CustomerProfile {
  vehicle?: string;
}

interface CaseProposal {
  vehicle: string;
  summary: string;
  severity: "low" | "medium" | "high";
}

interface ServiceCase {
  id: string;
  createdAt: string;
  vehicle: string;
  summary: string;
  severity: "low" | "medium" | "high";
  status: string;
}

const WELCOME_MESSAGE: Message = {
  role: "assistant",
  content:
    "Hi! I'm your BMW maintenance assistant. I can help you troubleshoot issues, walk you through maintenance procedures, and create a service case if a technician is needed. What's going on with your car?",
};

// Keyed only by browser, not by customer identity — see the CustomerProfile note
// in src/lib/agent.ts for how this would become a real per-user record later.
const PROFILE_STORAGE_KEY = "bmw-support-agent:profile";
// Case history also lives in localStorage: the server store is in-memory and
// resets on restart, so the browser copy is what makes history durable for the MVP.
const CASES_STORAGE_KEY = "bmw-support-agent:cases";

function loadProfile(): CustomerProfile {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(window.localStorage.getItem(PROFILE_STORAGE_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function loadCases(): ServiceCase[] {
  if (typeof window === "undefined") return [];
  try {
    const stored = JSON.parse(window.localStorage.getItem(CASES_STORAGE_KEY) ?? "[]");
    return Array.isArray(stored) ? stored : [];
  } catch {
    return [];
  }
}

const THINKING_PHRASES = [
  "Thinking",
  "Checking the knowledge base",
  "Working on it",
];

function ThinkingIndicator() {
  const [text, setText] = useState("");

  useEffect(() => {
    let phrase = 0;
    let char = 0;
    let deleting = false;
    let hold = 0;
    const id = setInterval(() => {
      if (hold > 0) {
        hold--;
        return;
      }
      const current = THINKING_PHRASES[phrase];
      if (!deleting) {
        char++;
        setText(current.slice(0, char));
        if (char === current.length) {
          deleting = true;
          hold = 14; // pause on the full phrase before erasing
        }
      } else {
        char--;
        setText(current.slice(0, char));
        if (char === 0) {
          deleting = false;
          phrase = (phrase + 1) % THINKING_PHRASES.length;
        }
      }
    }, 45);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="flex items-center gap-1.5 self-start rounded-2xl border border-zinc-200 bg-white px-4 py-3 text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
      <span className="min-w-4">{text}</span>
      <span className="inline-block h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-400 [animation-delay:0ms]" />
      <span className="inline-block h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-400 [animation-delay:150ms]" />
      <span className="inline-block h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-400 [animation-delay:300ms]" />
    </div>
  );
}

export default function Chat() {
  const [messages, setMessages] = useState<Message[]>([WELCOME_MESSAGE]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [profile, setProfile] = useState<CustomerProfile>({});
  const [pendingProposal, setPendingProposal] = useState<CaseProposal | null>(null);
  const [pendingOptions, setPendingOptions] = useState<CaseProposal | null>(null);
  const [caseHistory, setCaseHistory] = useState<ServiceCase[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [pendingFeedback, setPendingFeedback] = useState(false);
  const [pendingVehicleConfirm, setPendingVehicleConfirm] = useState<string | null>(null);
  const [showPreferences, setShowPreferences] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setProfile(loadProfile());
    setCaseHistory(loadCases());
  }, []);

  function recordCase(serviceCase: ServiceCase) {
    setCaseHistory((current) => {
      const updated = [...current.filter((c) => c.id !== serviceCase.id), serviceCase];
      debug('UPDATED VALUE', updated);
      window.localStorage.setItem(CASES_STORAGE_KEY, JSON.stringify(updated));
      return updated;
    });
  }

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  function handleMeta(meta: {
    proposedCase?: CaseProposal;
    nextStepOptions?: CaseProposal;
    caseCreated?: ServiceCase;
    profile?: CustomerProfile;
    feedbackRequested?: boolean;
    vehicleToConfirm?: string;
  }) {
    setPendingProposal(meta?.proposedCase ?? null);
    setPendingOptions(meta?.nextStepOptions ?? null);
    setPendingFeedback(meta?.feedbackRequested ?? false);
    setPendingVehicleConfirm(meta?.vehicleToConfirm ?? null);
    if (meta?.caseCreated) recordCase(meta.caseCreated);
    if (meta?.profile?.vehicle) {
      const merged = { ...profile, ...meta.profile };
      setProfile(merged);
      window.localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(merged));
    }
  }

  async function requestAgentReply(history: Message[]) {
    setLoading(true);
    setStreaming(false);
    // Streamed text renders live; the "final" event replaces it with the
    // server's cleaned-up version and carries the metadata.
    let started = false;
    const showReply = (content: string) => {
      if (!started) {
        started = true;
        setStreaming(true);
        setMessages((current) => [...current, { role: "assistant", content }]);
      } else {
        setMessages((current) => [
          ...current.slice(0, -1),
          { role: "assistant", content },
        ]);
      }
    };

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history.slice(1), profile, caseHistory }),
      });

      if (!response.ok || !response.body) {
        const data = await response.json().catch(() => ({}));
        showReply(data.error ?? "Something went wrong. Please try again.");
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let streamedText = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line);
          if (event.type === "delta") {
            streamedText += event.text;
            showReply(streamedText);
          } else if (event.type === "final") {
            showReply(event.message);
            handleMeta(event.meta ?? {});
          } else if (event.type === "error") {
            showReply(event.error);
          }
        }
      }
    } catch {
      showReply("I couldn't reach the server. Please try again.");
    } finally {
      setLoading(false);
      setStreaming(false);
    }
  }

  async function sendMessage(event: React.FormEvent) {
    event.preventDefault();
    const text = input.trim();
    if (!text || loading) return;

    setPendingProposal(null);
    setPendingOptions(null);
    setPendingFeedback(false);
    setPendingVehicleConfirm(null);
    const history = [...messages, { role: "user" as const, content: text }];
    setMessages(history);
    setInput("");
    await requestAgentReply(history);
  }

  async function confirmVehicle(isCorrect: boolean) {
    if (!pendingVehicleConfirm || loading) return;
    const vehicle = pendingVehicleConfirm;
    setPendingVehicleConfirm(null);
    const history = [
      ...messages,
      {
        role: "user" as const,
        content: isCorrect
          ? `Yes, that's correct — my vehicle is the ${vehicle}.`
          : "No, I'm asking about a different vehicle.",
      },
    ];
    setMessages(history);
    await requestAgentReply(history);
  }

  // Full reset: wipe all persisted memory (vehicle profile, case history) and
  // every piece of in-flight conversation state, returning to a fresh session.
  function restartSession() {
    if (loading) return;
    // Also wipe the server-side case store, otherwise get_service_case_history
    // would resurface this session's cases after the "fresh" start.
    fetch("/api/cases", { method: "DELETE" }).catch(() => {});
    window.localStorage.removeItem(PROFILE_STORAGE_KEY);
    window.localStorage.removeItem(CASES_STORAGE_KEY);
    setProfile({});
    setCaseHistory([]);
    setMessages([WELCOME_MESSAGE]);
    setInput("");
    setPendingProposal(null);
    setPendingOptions(null);
    setPendingFeedback(false);
    setPendingVehicleConfirm(null);
    setShowPreferences(false);
  }

  // Not wired to a backend yet: the rating is recorded into the conversation
  // history so it rides along on future requests and can later be logged and
  // joined against transcripts to analyze model performance vs. satisfaction.
  function submitFeedback(rating: "very_helpful" | "somewhat_helpful" | "not_helpful") {
    const labels = {
      very_helpful: "😄 Very helpful",
      somewhat_helpful: "🙂 Somewhat helpful",
      not_helpful: "🙁 Not helpful",
    } as const;
    setPendingFeedback(false);
    setMessages((current) => [
      ...current,
      { role: "user", content: `Feedback: ${labels[rating]}` },
      { role: "assistant", content: "Thanks for the feedback!" },
    ]);
  }

  async function createCaseFromProposal(proposal: CaseProposal) {
    setMessages((current) => [
      ...current,
      { role: "user", content: "Yes, create the service case." },
    ]);
    setLoading(true);

    try {
      // Deterministic path: the button creates the case directly — no LLM
      // round-trip that could misinterpret the confirmation.
      const response = await fetch("/api/cases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(proposal),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      const c = data.case;
      recordCase(c);
      setMessages((current) => [
        ...current,
        {
          role: "assistant",
          content: `✅ Service case created.\n\nCase ID: ${c.id}\nVehicle: ${c.vehicle}\nSeverity: ${c.severity}\nSummary: ${c.summary}\n\nA technician will review your case and follow up with next steps.`,
        },
      ]);
      setPendingFeedback(true);
    } catch {
      setMessages((current) => [
        ...current,
        { role: "assistant", content: "I couldn't create the case. Please try again." },
      ]);
    } finally {
      setLoading(false);
    }
  }

  async function confirmProposal() {
    if (!pendingProposal || loading) return;
    const proposal = pendingProposal;
    setPendingProposal(null);
    await createCaseFromProposal(proposal);
  }

  async function declineProposal() {
    if (loading) return;
    setPendingProposal(null);
    const history = [...messages, { role: "user" as const, content: "No, thanks." }];
    setMessages(history);
    await requestAgentReply(history);
  }

  async function chooseServiceCase() {
    if (!pendingOptions || loading) return;
    const proposal = pendingOptions;
    setPendingOptions(null);
    await createCaseFromProposal(proposal);
  }

  async function chooseDiy() {
    if (loading) return;
    setPendingOptions(null);
    const history = [
      ...messages,
      {
        role: "user" as const,
        content: "I'd like to try fixing it myself. Please give me the step-by-step instructions.",
      },
    ];
    setMessages(history);
    await requestAgentReply(history);
  }

  return (
    <div className="flex h-dvh flex-col bg-zinc-50 dark:bg-zinc-950">
      <header className="border-b border-zinc-200 bg-white px-6 py-4 dark:border-zinc-800 dark:bg-zinc-900">
        <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">
          BMW Support Agent
        </h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Maintenance troubleshooting for your BMW
        </p>
      </header>

      <main className="flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto flex max-w-2xl flex-col gap-4">
          {messages.map((message, index) => (
            <div
              key={index}
              className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                message.role === "user"
                  ? "self-end bg-blue-600 text-white"
                  : "self-start border border-zinc-200 bg-white text-zinc-900 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
              }`}
            >
              {message.content}
            </div>
          ))}
          {pendingVehicleConfirm && !loading && (
            <div className="flex gap-2 self-start">
              <button
                onClick={() => confirmVehicle(true)}
                className="rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-700"
              >
                Yes, that&apos;s my car
              </button>
              <button
                onClick={() => confirmVehicle(false)}
                className="rounded-xl border border-zinc-300 bg-white px-4 py-2.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700"
              >
                No, different vehicle
              </button>
            </div>
          )}
          {pendingOptions && !loading && (
            <div className="flex flex-wrap gap-2 self-start">
              <button
                onClick={chooseServiceCase}
                className="rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-700"
              >
                Create a service case
              </button>
              <button
                onClick={chooseDiy}
                className="rounded-xl border border-zinc-300 bg-white px-4 py-2.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700"
              >
                I&apos;ll try to fix it myself
              </button>
            </div>
          )}
          {pendingProposal && !loading && (
            <div className="flex gap-2 self-start">
              <button
                onClick={confirmProposal}
                className="rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-700"
              >
                Yes, create service case
              </button>
              <button
                onClick={declineProposal}
                className="rounded-xl border border-zinc-300 bg-white px-4 py-2.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700"
              >
                No, thanks
              </button>
            </div>
          )}
          {pendingFeedback && !loading && (
            <div className="flex items-center gap-2 self-start rounded-2xl border border-zinc-200 bg-white px-4 py-2.5 dark:border-zinc-800 dark:bg-zinc-900">
              <span className="text-sm text-zinc-500 dark:text-zinc-400">
                Was this helpful?
              </span>
              <button
                onClick={() => submitFeedback("very_helpful")}
                title="Very helpful"
                className="rounded-lg p-1 text-2xl transition-transform hover:scale-125"
              >
                😄
              </button>
              <button
                onClick={() => submitFeedback("somewhat_helpful")}
                title="Somewhat helpful"
                className="rounded-lg p-1 text-2xl transition-transform hover:scale-125"
              >
                🙂
              </button>
              <button
                onClick={() => submitFeedback("not_helpful")}
                title="Not helpful"
                className="rounded-lg p-1 text-2xl transition-transform hover:scale-125"
              >
                🙁
              </button>
            </div>
          )}
          {loading && !streaming && <ThinkingIndicator />}
          <div ref={bottomRef} />
        </div>
      </main>

      {showPreferences && (
        <div className="fixed bottom-24 left-4 z-20 w-72 rounded-2xl border border-zinc-200 bg-white p-4 shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
          <h2 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-50">
            Your preferences
          </h2>
          <div className="mb-3">
            <p className="text-xs uppercase tracking-wide text-zinc-400">Saved vehicle</p>
            <div className="mt-1 flex items-center justify-between gap-2">
              <span className="text-sm text-zinc-700 dark:text-zinc-200">
                {profile.vehicle ?? "None yet"}
              </span>
              {profile.vehicle && (
                <button
                  onClick={() => {
                    setProfile({});
                    window.localStorage.removeItem(PROFILE_STORAGE_KEY);
                  }}
                  className="text-xs text-red-500 hover:underline"
                >
                  Clear
                </button>
              )}
            </div>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-zinc-400">Service cases</p>
            <div className="mt-1 flex items-center justify-between gap-2">
              <span className="text-sm text-zinc-700 dark:text-zinc-200">
                {caseHistory.length === 0
                  ? "No cases yet"
                  : `${caseHistory.length} case${caseHistory.length === 1 ? "" : "s"} on file`}
              </span>
              {caseHistory.length > 0 && (
                <button
                  onClick={() => {
                    setCaseHistory([]);
                    window.localStorage.removeItem(CASES_STORAGE_KEY);
                  }}
                  className="text-xs text-red-500 hover:underline"
                >
                  Clear
                </button>
              )}
            </div>
          </div>
          <button
            onClick={restartSession}
            className="mt-4 w-full rounded-xl border border-red-300 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950"
          >
            Restart
          </button>
        </div>
      )}

      <footer className="relative border-t border-zinc-200 bg-white px-4 py-4 dark:border-zinc-800 dark:bg-zinc-900">
        <button
          onClick={() => setShowPreferences((open) => !open)}
          title="Your preferences"
          aria-label="Open user preferences"
          className="absolute bottom-3 left-4 rounded-full transition-transform hover:scale-110"
        >
          <Image src="/bmw-logo.svg" alt="BMW logo" width={40} height={40} priority />
        </button>
        <form onSubmit={sendMessage} className="mx-auto flex max-w-2xl gap-2">
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="Describe your issue…"
            className="flex-1 rounded-xl border border-zinc-300 bg-white px-4 py-2.5 text-sm text-zinc-900 outline-none focus:border-blue-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
          />
          <button
            type="submit"
            disabled={loading || input.trim().length === 0}
            className="rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-medium text-white disabled:opacity-40"
          >
            Send
          </button>
        </form>
      </footer>
    </div>
  );
}
