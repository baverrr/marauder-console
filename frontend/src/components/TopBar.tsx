import { useState } from "react";
import { Plug, PlugZap, ShieldAlert, Loader2, Cable, FlaskConical } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import type { BridgeStatus } from "@/lib/bridge";
import { cn } from "@/lib/utils";

interface Props {
  status: BridgeStatus;
  wsOnline: boolean;
  onConnect: (port?: string) => void;
  onDisconnect: () => void;
}

export function TopBar({ status, wsOnline, onConnect, onDisconnect }: Props) {
  const [busy, setBusy] = useState(false);
  const [port, setPort] = useState(status.port);

  const act = async (fn: () => Promise<unknown> | void) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  return (
    <header className="relative z-10 border-b border-border bg-card/70 backdrop-blur">
      {/* Permanent authorised-use banner */}
      <div className="flex items-center justify-center gap-2 bg-warn/10 px-4 py-1.5 text-center text-xs text-warn">
        <ShieldAlert className="size-3.5 shrink-0" />
        <span>
          Authorised use only. Operate Marauder only on networks and devices you own or have explicit
          written permission to test. You are responsible for staying within the law.
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <div className="flex items-center gap-2.5">
          <div className="grid size-9 place-items-center rounded-md bg-primary/15 text-primary">
            <Cable className="size-5" />
          </div>
          <div className="leading-tight">
            <div className="flex items-center gap-2 font-semibold tracking-tight">
              Marauder Console
              {status.mock && (
                <Badge variant="accent" className="font-normal">
                  <FlaskConical className="size-3" /> mock
                </Badge>
              )}
            </div>
            <div className="text-xs text-muted-foreground">ESP32 Marauder control &amp; reference</div>
          </div>
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2.5">
          <StatusPill label="Bridge" ok={wsOnline} okText="online" badText="offline" />
          <StatusPill
            label="Board"
            ok={status.connected}
            okText={status.firmware ?? "connected"}
            badText="disconnected"
          />
          {status.connected && (
            <Badge variant="outline" className="font-mono">
              {status.port} · {status.baud}
            </Badge>
          )}

          {!status.connected ? (
            <div className="flex items-center gap-1.5">
              <Input
                value={port}
                onChange={(e) => setPort(e.target.value)}
                className="h-9 w-40"
                aria-label="Serial port"
              />
              <Button onClick={() => act(() => onConnect(port))} disabled={busy || !wsOnline}>
                {busy ? <Loader2 className="animate-spin" /> : <Plug />} Connect
              </Button>
            </div>
          ) : (
            <Button variant="outline" onClick={() => act(onDisconnect)} disabled={busy}>
              {busy ? <Loader2 className="animate-spin" /> : <PlugZap />} Disconnect
            </Button>
          )}
        </div>
      </div>
    </header>
  );
}

function StatusPill({ label, ok, okText, badText }: { label: string; ok: boolean; okText: string; badText: string }) {
  return (
    <div className="flex items-center gap-1.5 rounded-full border border-border bg-background/50 px-2.5 py-1 text-xs">
      <span
        className={cn(
          "size-2 rounded-full",
          ok ? "bg-primary animate-pulse-dot" : "bg-muted-foreground/50",
        )}
      />
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("font-medium", ok ? "text-foreground" : "text-muted-foreground")}>
        {ok ? okText : badText}
      </span>
    </div>
  );
}
