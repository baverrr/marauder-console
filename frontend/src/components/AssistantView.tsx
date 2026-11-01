import { useCallback, useEffect, useState } from "react";
import { Bot, RefreshCw, SendHorizonal, Trash2, Radio, ShieldAlert, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  addProposal,
  clearProposals,
  dismissProposal,
  listProposals,
  type Proposal,
} from "@/lib/assistant";

interface Props {
  connected: boolean;
  authorized: boolean;
  onAuthorize: () => void;
  onSend: (command: string) => void;
}

export function AssistantView({ connected, authorized, onAuthorize, onSend }: Props) {
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      setProposals(await listProposals());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const stage = async () => {
    const command = draft.trim();
    if (!command) return;
    try {
      await addProposal(command, "Added manually");
      setDraft("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const remove = async (id: number) => {
    await dismissProposal(id);
    await refresh();
  };

  const clearAll = async () => {
    await clearProposals();
    await refresh();
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
            <Bot className="size-5 text-primary" /> Claude assistant
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            The assistant advises, explains and <strong>drafts</strong> commands — it never runs them.
            Proposed commands land in the staging area below; you review each one and run it yourself with
            Send, and transmitting commands still need the per-session authorisation.
          </p>
        </div>
        <Button size="sm" variant="secondary" onClick={() => void refresh()}>
          <RefreshCw /> Refresh
        </Button>
      </div>

      <div className="mb-4 rounded-md border border-border bg-background/40 p-3 text-sm text-muted-foreground">
        <span className="font-medium text-foreground">Chat with Claude arrives in the next slice.</span>{" "}
        It will read live status and captures and propose commands into this same staging area (never
        executing them), using an API key you set in Settings. For now you can stage a command by hand to
        try the review-and-run flow.
      </div>

      <div className="mb-4 flex items-center gap-1.5">
        <Plus className="size-4 shrink-0 text-muted-foreground" />
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void stage()}
          placeholder="Draft a command to stage, e.g. scanall"
        />
        <Button size="sm" onClick={() => void stage()} disabled={!draft.trim()}>
          Stage
        </Button>
      </div>

      {error && (
        <div className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 p-2.5 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="flex items-center justify-between">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Proposed commands ({proposals.length})
        </h3>
        {proposals.length > 0 && (
          <Button size="sm" variant="ghost" onClick={() => void clearAll()}>
            <Trash2 /> Clear all
          </Button>
        )}
      </div>

      <div className="mt-2 min-h-0 flex-1 overflow-auto">
        {proposals.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No proposed commands. When the assistant suggests one (or you stage one above), it appears here
            for review.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {proposals.map((p) => (
              <li key={p.id} className="rounded-lg border border-border bg-card/60 p-3">
                <div className="flex items-start gap-2">
                  <code className="flex-1 break-words font-mono text-sm text-accent">{p.command}</code>
                  {p.transmits && (
                    <Badge variant="outline" className="shrink-0 border-destructive/50 text-destructive">
                      <Radio className="size-3" /> transmits
                    </Badge>
                  )}
                </div>
                {p.rationale && <p className="mt-1 text-sm text-muted-foreground">{p.rationale}</p>}
                <div className="mt-2 flex items-center gap-1.5">
                  {p.transmits && !authorized ? (
                    <Button size="sm" variant="destructive" onClick={onAuthorize}>
                      <ShieldAlert /> Authorise to run
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      onClick={() => onSend(p.command)}
                      disabled={!connected}
                      title={connected ? "Run this command on the board" : "Connect a board first"}
                    >
                      <SendHorizonal /> Send to console
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => void remove(p.id)}>
                    Dismiss
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
