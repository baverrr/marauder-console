/**
 * Client for the bridge's saved-session endpoints (Phase 3 analysis).
 *
 * Sessions are console transcripts the bridge persisted to disk, one per connect→disconnect span. These
 * calls are read-only and work with the board unplugged — the data comes from local files, not the device.
 */
import { apiUrl } from "@/lib/bridge";

/** Metadata for one saved session, as listed by `GET /api/sessions`. */
export interface SessionMeta {
  id: string;
  started: string;
  ended: string | null;
  port: string;
  mock: boolean;
  commands: number;
  lines: number;
}

/** One recorded event within a session: a command sent, or a line received. */
export interface SessionEvent {
  t: string;
  k: "command" | "line";
  d: string;
}

export interface SessionDetail {
  meta: SessionMeta;
  events: SessionEvent[];
}

export async function listSessions(): Promise<SessionMeta[]> {
  const res = await fetch(apiUrl("/api/sessions"));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as { sessions: SessionMeta[] };
  return json.sessions ?? [];
}

export async function getSession(id: string): Promise<SessionDetail> {
  const res = await fetch(apiUrl(`/api/sessions/${encodeURIComponent(id)}`));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as SessionDetail;
}
