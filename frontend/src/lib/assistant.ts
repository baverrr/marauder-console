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
