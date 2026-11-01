import { useEffect, useRef, useState } from "react";
import { Square, Trash2, ArrowDownToLine, TerminalSquare, SendHorizonal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import type { ConsoleLine } from "@/lib/bridge";
import { cn } from "@/lib/utils";

interface Props {
  lines: ConsoleLine[];
  running: boolean;
  connected: boolean;
  onStop: () => void;
  onClear: () => void;
  onSend: (command: string) => void;
}

function lineClass(text: string): string {
  if (text.startsWith(">")) return "text-accent";
  if (text.startsWith("[bridge]") || text.startsWith("[MOCK]")) return "text-muted-foreground italic";
  if (/error|fail|unknown/i.test(text)) return "text-destructive";
  return "text-foreground/80";
}

export function SerialConsole({ lines, running, connected, onStop, onClear, onSend }: Props) {
  const [autoscroll, setAutoscroll] = useState(true);
  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (autoscroll) endRef.current?.scrollIntoView({ block: "end" });
  }, [lines, autoscroll]);

  const submit = () => {
    const cmd = draft.trim();
    if (!cmd) return;
    onSend(cmd);
    setDraft("");
  };

  return (
    <section className="flex h-full flex-col border-t border-border bg-card/60">
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        <TerminalSquare className="size-4 text-primary" />
        <span className="text-sm font-medium">Serial console</span>
        {running && (
          <Badge variant="primary" className="animate-pulse-dot">
            scanning
          </Badge>
        )}
        <div className="ml-auto flex items-center gap-1">
          <Button
            size="sm"
            variant={autoscroll ? "secondary" : "ghost"}
            onClick={() => setAutoscroll((v) => !v)}
            title="Toggle autoscroll"
          >
            <ArrowDownToLine /> Auto
          </Button>
          <Button size="sm" variant="ghost" onClick={onClear} title="Clear console">
            <Trash2 /> Clear
          </Button>
          <Button size="sm" variant="destructive" onClick={onStop} disabled={!running}>
            <Square /> Stop
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-3 font-mono text-xs leading-relaxed">
        {lines.length === 0 ? (
          <p className="text-muted-foreground">
            {connected
              ? "Connected. Run a command or type one below to see live output."
              : "Not connected. Use Connect in the top bar, or switch to Reference to browse the tools offline."}
          </p>
        ) : (
          lines.map((l) => (
            <div key={l.id} className={cn("whitespace-pre-wrap break-words", lineClass(l.text))}>
              {l.text}
            </div>
          ))
        )}
        <div ref={endRef} />
      </div>

      <div className="flex items-center gap-1.5 border-t border-border px-3 py-2">
        <span className="font-mono text-sm text-primary">$</span>
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder={connected ? "type a command, e.g. help" : "connect a board to send commands"}
          disabled={!connected}
        />
        <Button size="sm" onClick={submit} disabled={!connected || !draft.trim()}>
          <SendHorizonal /> Send
        </Button>
      </div>
    </section>
  );
}
