import { useCallback, useEffect, useState } from "react";
import { History, RefreshCw, TerminalSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { getSession, listSessions, type SessionDetail, type SessionMeta } from "@/lib/sessions";
import { cn } from "@/lib/utils";

/** Local date-time for an ISO string, or a dash when absent. */
function fmt(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function duration(started: string, ended: string | null): string {
  if (!ended) return "in progress / not finished";
  const ms = new Date(ended).getTime() - new Date(started).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

function eventClass(ev: { k: string; d: string }): string {
  if (ev.k === "command") return "text-accent";
  if (ev.d.startsWith("[bridge]") || ev.d.startsWith("[MOCK]")) return "text-muted-foreground italic";
  if (/error|fail|unknown/i.test(ev.d)) return "text-destructive";
  return "text-foreground/80";
}

export function HistoryView() {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [selected, setSelected] = useState<SessionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSessions(await listSessions());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const open = async (id: string) => {
    setError(null);
    try {
      setSelected(await getSession(id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
            <History className="size-5 text-primary" /> Session history
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Console transcripts the bridge saved, one per connect/disconnect. Read-only and available
            offline — the board does not need to be plugged in.
          </p>
        </div>
        <Button size="sm" variant="secondary" onClick={() => void refresh()}>
          <RefreshCw /> Refresh
        </Button>
      </div>

      {error && (
        <div className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 p-2.5 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[320px_1fr]">
        {/* Session list */}
        <div className="min-h-0 overflow-auto rounded-lg border border-border bg-card/40 p-2">
          {loading ? (
            <p className="p-2 text-sm text-muted-foreground">Loading…</p>
          ) : sessions.length === 0 ? (
            <p className="p-2 text-sm text-muted-foreground">
              No saved sessions yet. Connect a board and run some commands, then disconnect — the
              transcript shows up here.
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {sessions.map((s) => (
                <li key={s.id}>
                  <button
                    onClick={() => void open(s.id)}
                    className={cn(
                      "w-full rounded-md px-2.5 py-2 text-left text-sm transition-colors",
                      selected?.meta.id === s.id
                        ? "bg-primary/15 text-primary"
                        : "hover:bg-secondary/60",
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <span className="flex-1 truncate font-medium">{fmt(s.started)}</span>
                      {s.mock && <Badge variant="outline">mock</Badge>}
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {s.commands} cmd · {s.lines} lines · {duration(s.started, s.ended)}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Selected transcript */}
        <div className="flex min-h-0 flex-col rounded-lg border border-border bg-card/60">
          {!selected ? (
            <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
              Select a session to view its transcript.
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-sm">
                <TerminalSquare className="size-4 text-primary" />
                <span className="font-medium">{fmt(selected.meta.started)}</span>
                <span className="text-muted-foreground">
                  · {selected.meta.port} · {selected.events.length} events
                </span>
              </div>
              <div className="flex-1 overflow-auto p-3 font-mono text-xs leading-relaxed">
                {selected.events.length === 0 ? (
                  <p className="text-muted-foreground">This session recorded no events.</p>
                ) : (
                  selected.events.map((ev, i) => (
                    <div key={i} className={cn("whitespace-pre-wrap break-words", eventClass(ev))}>
                      {ev.k === "command" ? `> ${ev.d}` : ev.d}
                    </div>
                  ))
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
