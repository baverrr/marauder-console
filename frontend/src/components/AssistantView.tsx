import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  RefreshCw,
  SendHorizonal,
  Trash2,
  Radio,
  ShieldAlert,
  KeyRound,
  Check,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  clearKey,
  clearProposals,
  dismissProposal,
  getKeyStatus,
  listProposals,
  sendChat,
  setKey,
  type ChatMessage,
  type ChatToolInfo,
  type Proposal,
} from "@/lib/assistant";
import { TOOLS } from "@/tools";
import { cn } from "@/lib/utils";

interface Props {
  connected: boolean;
  boardBusy: boolean;
  authorized: boolean;
  onAuthorize: () => void;
  onSend: (command: string) => void;
}

export function AssistantView({ connected, boardBusy, authorized, onAuthorize, onSend }: Props) {
  const [hasKey, setHasKey] = useState(false);
  const [keyDraft, setKeyDraft] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatDraft, setChatDraft] = useState("");
  const [thinking, setThinking] = useState(false);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  // Compact command catalogue (from tools.ts) handed to the assistant's list_tools tool.
  const toolInfo = useMemo<ChatToolInfo[]>(
    () => TOOLS.map((t) => ({ id: t.id, name: t.name, syntax: t.syntax, class: t.class, summary: t.summary })),
    [],
  );

  const refreshProposals = useCallback(async () => {
    try {
      setProposals(await listProposals());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void (async () => {
      setHasKey(await getKeyStatus());
      await refreshProposals();
    })();
  }, [refreshProposals]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages, thinking]);

  const saveKey = async () => {
    const k = keyDraft.trim();
    if (!k) return;
    try {
      setHasKey(await setKey(k));
      setKeyDraft("");
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const forgetKey = async () => {
    await clearKey();
    setHasKey(false);
  };

  const send = async () => {
    const text = chatDraft.trim();
    if (!text || thinking) return;
    const next = [...messages, { role: "user" as const, content: text }];
    setMessages(next);
    setChatDraft("");
    setThinking(true);
    setError(null);
    try {
      const res = await sendChat(next, toolInfo);
      setMessages((m) => [...m, { role: "assistant", content: res.reply || "(no reply)" }]);
      if (res.proposals_added.length) await refreshProposals();
    } catch (e) {
      const err = e as Error & { needsKey?: boolean };
      if (err.needsKey) {
        setHasKey(false);
        setError("Set your Anthropic API key below to chat.");
      } else {
        setError(err.message || String(e));
      }
    } finally {
      setThinking(false);
    }
  };

  const remove = async (id: number) => {
    await dismissProposal(id);
    await refreshProposals();
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-3">
        <h2 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
          <Bot className="size-5 text-primary" /> Claude assistant
        </h2>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Ask about commands, output or captures. Claude advises and <strong>drafts</strong> — it never
          runs anything. Commands it suggests land in the staging area for you to review and run.
        </p>
      </div>

      {/* API key bar */}
      <div className="mb-3 flex items-center gap-2 rounded-md border border-border bg-background/40 p-2 text-sm">
        <KeyRound className="size-4 shrink-0 text-muted-foreground" />
        {hasKey ? (
          <>
            <Check className="size-4 text-primary" />
            <span className="flex-1">Anthropic API key set (stored in your OS keychain).</span>
            <Button size="sm" variant="ghost" onClick={() => void forgetKey()}>
              Clear key
            </Button>
          </>
        ) : (
          <>
            <Input
              type="password"
              value={keyDraft}
              onChange={(e) => setKeyDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void saveKey()}
              placeholder="Paste your Anthropic API key (sk-ant-…)"
            />
            <Button size="sm" onClick={() => void saveKey()} disabled={!keyDraft.trim()}>
              Save
            </Button>
          </>
        )}
      </div>

      {error && (
        <div className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 p-2.5 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Chat */}
      <div className="flex min-h-0 flex-1 flex-col gap-3 lg:flex-row">
        <div className="flex min-h-0 flex-1 flex-col rounded-lg border border-border bg-card/40">
          <div className="min-h-0 flex-1 overflow-auto p-3">
            {messages.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Try “what does <code>sniffpmkid</code> do and when would I use it?” or “draft a scan for
                nearby APs”.
              </p>
            ) : (
              <div className="flex flex-col gap-3">
                {messages.map((m, i) => (
                  <div
                    key={i}
                    className={cn(
                      "max-w-[85%] whitespace-pre-wrap break-words rounded-lg px-3 py-2 text-sm",
                      m.role === "user"
                        ? "self-end bg-primary/15 text-foreground"
                        : "self-start bg-secondary/60 text-foreground/90",
                    )}
                  >
                    {m.content}
                  </div>
                ))}
                {thinking && <div className="self-start text-sm text-muted-foreground">Claude is thinking…</div>}
              </div>
            )}
            <div ref={endRef} />
          </div>
          <div className="flex items-center gap-1.5 border-t border-border p-2">
            <Input
              value={chatDraft}
              onChange={(e) => setChatDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void send()}
              placeholder={hasKey ? "Ask Claude…" : "Set your API key above to chat"}
              disabled={!hasKey || thinking}
            />
            <Button size="sm" onClick={() => void send()} disabled={!hasKey || thinking || !chatDraft.trim()}>
              <SendHorizonal /> Send
            </Button>
          </div>
        </div>

        {/* Staging area */}
        <div className="flex min-h-0 flex-col rounded-lg border border-border bg-card/40 lg:w-[360px]">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Proposed commands ({proposals.length})
            </span>
            <div className="flex items-center gap-1">
              <Button size="sm" variant="ghost" onClick={() => void refreshProposals()} title="Refresh">
                <RefreshCw />
              </Button>
              {proposals.length > 0 && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void clearProposals().then(refreshProposals)}
                  title="Clear all"
                >
                  <Trash2 />
                </Button>
              )}
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-2">
            {proposals.length === 0 ? (
              <p className="p-2 text-sm text-muted-foreground">
                Commands Claude proposes appear here for you to review and run.
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {proposals.map((p) => (
                  <li key={p.id} className="rounded-lg border border-border bg-card/70 p-2.5">
                    <div className="flex items-start gap-2">
                      <code className="flex-1 break-words font-mono text-sm text-accent">{p.command}</code>
                      {p.transmits && (
                        <Badge variant="outline" className="shrink-0 border-destructive/50 text-destructive">
                          <Radio className="size-3" /> transmits
                        </Badge>
                      )}
                    </div>
                    {p.rationale && <p className="mt-1 text-xs text-muted-foreground">{p.rationale}</p>}
                    <div className="mt-2 flex items-center gap-1.5">
                      {p.transmits && !authorized ? (
                        <Button size="sm" variant="destructive" onClick={onAuthorize}>
                          <ShieldAlert /> Authorise
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          onClick={() => onSend(p.command)}
                          disabled={!connected || boardBusy}
                          title={
                            !connected
                              ? "Connect a board first"
                              : boardBusy
                                ? "A scan is running — Stop it first"
                                : "Run on the board"
                          }
                        >
                          <SendHorizonal /> Send
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
      </div>
    </div>
  );
}
