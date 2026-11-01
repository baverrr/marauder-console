/**
 * Client for the assistant staging area (Phase 4).
 *
 * The assistant proposes commands; they land here for the human to review and run. Staging a proposal
 * never runs it — execution is a separate, explicit step through the normal Run control. These calls only
 * read and manage the staging list.
 */
import { apiUrl } from "@/lib/bridge";

export interface Proposal {
  id: number;
  command: string;
  rationale: string;
  transmits: boolean;
  created: string;
}

export async function listProposals(): Promise<Proposal[]> {
  const res = await fetch(apiUrl("/api/assistant/proposals"));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as { proposals: Proposal[] };
  return json.proposals ?? [];
}

export async function addProposal(command: string, rationale = ""): Promise<Proposal> {
  const res = await fetch(apiUrl("/api/assistant/proposals"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command, rationale }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return ((await res.json()) as { proposal: Proposal }).proposal;
}

export async function dismissProposal(id: number): Promise<void> {
  await fetch(apiUrl(`/api/assistant/proposals/${id}`), { method: "DELETE" });
}

export async function clearProposals(): Promise<void> {
  await fetch(apiUrl("/api/assistant/proposals"), { method: "DELETE" });
}

// ---- API key (OS keychain; the value is write-only from the UI's point of view) ----
export async function getKeyStatus(): Promise<boolean> {
  const res = await fetch(apiUrl("/api/assistant/key"));
  if (!res.ok) return false;
  return Boolean(((await res.json()) as { has_key: boolean }).has_key);
}

export async function setKey(key: string): Promise<boolean> {
  const res = await fetch(apiUrl("/api/assistant/key"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Boolean(((await res.json()) as { has_key: boolean }).has_key);
}

export async function clearKey(): Promise<void> {
  await fetch(apiUrl("/api/assistant/key"), { method: "DELETE" });
}

// ---- Chat ----
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatToolInfo {
  id: string;
  name: string;
  syntax: string;
  class: string;
  summary: string;
}

export interface ChatResult {
  reply: string;
  proposals_added: Proposal[];
}

/** Send the conversation; returns the reply, or throws with a `needsKey` flag on 428. */
export async function sendChat(messages: ChatMessage[], tools: ChatToolInfo[]): Promise<ChatResult> {
  const res = await fetch(apiUrl("/api/assistant/chat"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages, tools }),
  });
  if (res.status === 428) {
    const err = new Error("no-key") as Error & { needsKey?: boolean };
    err.needsKey = true;
    throw err;
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok === false) throw new Error(json.error ?? `HTTP ${res.status}`);
  return { reply: json.reply ?? "", proposals_added: json.proposals_added ?? [] };
}
