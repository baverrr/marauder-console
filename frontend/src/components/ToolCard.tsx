import { useMemo, useState } from "react";
import { Play, Square, RotateCcw, Radio, ShieldAlert, Lock, Terminal, Info } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { HardwareBadge } from "@/components/HardwareBadge";
import { buildCommand, initialArgs } from "@/lib/command";
import type { Tool } from "@/tools";
import { cn } from "@/lib/utils";

interface Props {
  tool: Tool;
  /** "reference" shows documentation only; "control" adds the Run controls. */
  mode: "reference" | "control";
  connected: boolean;
  running: boolean;
  /** Whether a streaming command is currently running on the board (any tool). */
  boardBusy: boolean;
  authorized: boolean;
  onAuthorize: () => void;
  onRun: (command: string) => void;
  onStop: () => void;
}

export function ToolCard({
  tool,
  mode,
  connected,
  running,
  boardBusy,
  authorized,
  onAuthorize,
  onRun,
  onStop,
}: Props) {
  const [values, setValues] = useState(() => initialArgs(tool));
  const [manual, setManual] = useState<string | null>(null);
  const built = useMemo(() => buildCommand(tool, values), [tool, values]);
  const command = manual ?? built;

  const isActive = tool.class === "active";
  const gated = isActive && !authorized;
  const canRun = connected && !gated && (!boardBusy || running);

  const setArg = (name: string, v: string) => {
    setManual(null);
    setValues((prev) => ({ ...prev, [name]: v }));
  };
  const reset = () => {
    setManual(null);
    setValues(initialArgs(tool));
  };

  return (
    <Card className={cn("animate-fade-in", isActive && "border-warn/30")}>
      <CardHeader className="gap-2">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">{tool.name}</CardTitle>
            <code className="mt-1 inline-block rounded bg-background/70 px-1.5 py-0.5 font-mono text-xs text-primary">
              {tool.syntax}
            </code>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            {isActive ? (
              <Badge variant="warn">
                <Radio className="size-3" /> active
              </Badge>
            ) : (
              <Badge variant="primary">passive</Badge>
            )}
            {tool.streaming && <Badge variant="outline">streaming</Badge>}
            {tool.requires?.map((hw) => <HardwareBadge key={hw} hw={hw} />)}
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        <p className="text-sm text-foreground/85">{tool.summary}</p>
        <p className="flex gap-2 text-sm text-muted-foreground">
          <Info className="mt-0.5 size-3.5 shrink-0" />
          <span>{tool.howToUse}</span>
        </p>

        {tool.args.length > 0 && mode === "reference" && (
          <ul className="space-y-1 rounded-md border border-border bg-background/40 p-2.5 text-xs">
            {tool.args.map((a) => (
              <li key={a.name} className="flex gap-2">
                <span className="font-mono text-accent">
                  {a.flag ? `${a.flag} ` : ""}
                  {a.name}
                  {a.optional ? "?" : ""}
                </span>
                <span className="text-muted-foreground">{a.description}</span>
              </li>
            ))}
          </ul>
        )}

        {mode === "control" && (
          <div className="space-y-2.5 border-t border-border pt-3">
            {gated ? (
              <div className="flex items-center gap-2 rounded-md border border-warn/40 bg-warn/10 p-2.5 text-xs text-warn">
                <Lock className="size-4 shrink-0" />
                <span className="flex-1">
                  This command transmits. Confirm you are authorised to test the target before enabling it.
                </span>
                <Button size="sm" variant="warn" onClick={onAuthorize}>
                  <ShieldAlert /> I am authorised
                </Button>
              </div>
            ) : (
              <>
                {tool.args.length > 0 && (
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {tool.args.map((a) => (
                      <label key={a.name} className="flex flex-col gap-1 text-xs">
                        <span className="text-muted-foreground">
                          {a.name}
                          {a.optional ? " (optional)" : ""}
                        </span>
                        <Input
                          value={values[a.name] ?? ""}
                          placeholder={a.placeholder}
                          onChange={(e) => setArg(a.name, e.target.value)}
                        />
                      </label>
                    ))}
                  </div>
                )}

                <div className="flex items-center gap-1.5">
                  <Terminal className="size-4 shrink-0 text-muted-foreground" />
                  <Input
                    value={command}
                    onChange={(e) => setManual(e.target.value)}
                    className="text-primary"
                    aria-label="Command to send"
                  />
                  {(manual !== null || tool.args.some((a) => (values[a.name] ?? "") !== (a.default ?? ""))) && (
                    <Button size="icon" variant="ghost" onClick={reset} title="Reset command">
                      <RotateCcw />
                    </Button>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  {running ? (
                    <Button variant="destructive" onClick={onStop}>
                      <Square /> Stop
                    </Button>
                  ) : (
                    <Button onClick={() => onRun(command)} disabled={!canRun}>
                      <Play /> Run
                    </Button>
                  )}
                  {!connected && <span className="text-xs text-muted-foreground">Connect a board to run.</span>}
                  {connected && boardBusy && !running && (
                    <span className="text-xs text-warn">Board busy — another scan is running.</span>
                  )}
                  {isActive && authorized && !running && (
                    <span className="text-xs text-muted-foreground">Authorised this session.</span>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
