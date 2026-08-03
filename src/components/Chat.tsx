"use client";

import { useEffect, useRef, useState } from "react";

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

export default function Chat() {
  const [messages, setMessages] = useState<Message[]>([WELCOME_MESSAGE]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [profile, setProfile] = useState<CustomerProfile>({});
  const [pendingProposal, setPendingProposal] = useState<CaseProposal | null>(null);
  const [pendingOptions, setPendingOptions] = useState<CaseProposal | null>(null);
  const [caseHistory, setCaseHistory] = useState<ServiceCase[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setProfile(loadProfile());
    setCaseHistory(loadCases());
  }, []);

  function recordCase(serviceCase: ServiceCase) {
    setCaseHistory((current) => {
      const updated = [...current.filter((c) => c.id !== serviceCase.id), serviceCase];
      window.localStorage.setItem(CASES_STORAGE_KEY, JSON.stringify(updated));
      return updated;
    });
  }

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  async function requestAgentReply(history: Message[]) {
    setLoading(true);
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history.slice(1), profile, caseHistory }),
      });
      const data = await response.json();
      const reply = response.ok
        ? data.message
        : data.error ?? "Something went wrong. Please try again.";
      setMessages((current) => [...current, { role: "assistant", content: reply }]);
      setPendingProposal(data.meta?.proposedCase ?? null);
      setPendingOptions(data.meta?.nextStepOptions ?? null);
      if (data.meta?.caseCreated) recordCase(data.meta.caseCreated);

      const updatedProfile = data.meta?.profile;
      if (updatedProfile?.vehicle) {
        const merged = { ...profile, ...updatedProfile };
        setProfile(merged);
        window.localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(merged));
      }
    } catch {
      setMessages((current) => [
        ...current,
        { role: "assistant", content: "I couldn't reach the server. Please try again." },
      ]);
    } finally {
      setLoading(false);
    }
  }

  async function sendMessage(event: React.FormEvent) {
    event.preventDefault();
    const text = input.trim();
    if (!text || loading) return;

    setPendingProposal(null);
    setPendingOptions(null);
    const history = [...messages, { role: "user" as const, content: text }];
    setMessages(history);
    setInput("");
    await requestAgentReply(history);
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
          {loading && (
            <div className="self-start rounded-2xl border border-zinc-200 bg-white px-4 py-3 text-sm text-zinc-400 dark:border-zinc-800 dark:bg-zinc-900">
              Thinking…
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </main>

      <footer className="border-t border-zinc-200 bg-white px-4 py-4 dark:border-zinc-800 dark:bg-zinc-900">
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
