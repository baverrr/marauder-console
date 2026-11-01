/**
 * Client for the Python bridge: HTTP for commands + a WebSocket for the live serial stream.
 *
 * The React hook `useBridge` keeps connection status, the running-command flag and a rolling buffer of
 * console lines, and exposes connect / disconnect / send / stop. It reconnects the WebSocket on its own
 * so the UI survives the bridge restarting.
 */
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Absolute base URL of the Python bridge. The desktop shell (Tauri) injects
 * `window.__MARAUDER_BRIDGE_URL__` before the page loads so requests reach the bridge regardless of the
 * webview's own origin. In the browser build the value is absent and we stay same-origin ("").
 */
const BASE = ((): string => {
  if (typeof window !== "undefined") {
    const u = (window as unknown as { __MARAUDER_BRIDGE_URL__?: string }).__MARAUDER_BRIDGE_URL__;
    if (u) return u.replace(/\/+$/, "");
  }
  return "";
})();

/** Build the WebSocket URL for `path`, honouring the injected bridge base or falling back to the page. */
function wsUrl(path: string): string {
  if (BASE) {
    const u = new URL(BASE);
    return `${u.protocol === "https:" ? "wss" : "ws"}://${u.host}${path}`;
  }
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}${path}`;
}

export interface BridgeStatus {
  connected: boolean;
  mock: boolean;
  port: string;
  baud: number;
  firmware: string | null;
  running: boolean;
}

export interface ConsoleLine {
  id: number;
  text: string;
}

const MAX_LINES = 1000;

type WsMessage =
  | { type: "status"; data: BridgeStatus }
  | { type: "line"; data: string };

async function postJSON(path: string, body?: unknown): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: json.error ?? `HTTP ${res.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

const INITIAL_STATUS: BridgeStatus = {
  connected: false,
  mock: false,
  port: "/dev/ttyUSB0",
  baud: 115200,
  firmware: null,
  running: false,
};

export function useBridge() {
  const [status, setStatus] = useState<BridgeStatus>(INITIAL_STATUS);
  const [lines, setLines] = useState<ConsoleLine[]>([]);
  const [wsOnline, setWsOnline] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const counter = useRef(0);
  const wsRef = useRef<WebSocket | null>(null);
  const retry = useRef<ReturnType<typeof setTimeout> | null>(null);

  const pushLine = useCallback((text: string) => {
    setLines((prev) => {
      const next = [...prev, { id: counter.current++, text }];
      return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
    });
  }, []);

  useEffect(() => {
    let closed = false;
    const connect = () => {
      const ws = new WebSocket(wsUrl("/ws"));
      wsRef.current = ws;
      ws.onopen = () => setWsOnline(true);
      ws.onmessage = (ev) => {
        let msg: WsMessage;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (msg.type === "status") setStatus(msg.data);
        else if (msg.type === "line") pushLine(msg.data);
      };
      ws.onclose = () => {
        setWsOnline(false);
        if (!closed) retry.current = setTimeout(connect, 1500);
      };
      ws.onerror = () => ws.close();
    };
    connect();
    return () => {
      closed = true;
      if (retry.current) clearTimeout(retry.current);
      wsRef.current?.close();
    };
  }, [pushLine]);

  const connect = useCallback(async (port?: string, baud?: number) => {
    setError(null);
    const r = await postJSON("/api/connect", { port, baud });
    if (!r.ok) setError(r.error ?? "Connect failed");
    return r.ok;
  }, []);

  const disconnect = useCallback(async () => {
    setError(null);
    const r = await postJSON("/api/disconnect");
    if (!r.ok) setError(r.error ?? "Disconnect failed");
    return r.ok;
  }, []);

  const send = useCallback(async (command: string) => {
    setError(null);
    const r = await postJSON("/api/command", { command });
    if (!r.ok) setError(r.error ?? "Command failed");
    return r.ok;
  }, []);

  const stop = useCallback(async () => {
    setError(null);
    const r = await postJSON("/api/stop");
    if (!r.ok) setError(r.error ?? "Stop failed");
    return r.ok;
  }, []);

  const clearLines = useCallback(() => setLines([]), []);

  // When running inside the Tauri desktop shell, mirror its tray-menu actions onto the bridge.
  useEffect(() => {
    const tauri = (
      window as unknown as {
        __TAURI__?: {
          event?: {
            listen?: (e: string, cb: (ev: { payload: unknown }) => void) => Promise<() => void>;
          };
        };
      }
    ).__TAURI__;
    const listen = tauri?.event?.listen;
    if (!listen) return;
    const pending = listen("menu", (ev) => {
      if (ev.payload === "connect") void connect();
      else if (ev.payload === "disconnect") void disconnect();
      else if (ev.payload === "stop") void stop();
    });
    return () => {
      void pending.then((un) => un());
    };
  }, [connect, disconnect, stop]);

  return { status, lines, wsOnline, error, connect, disconnect, send, stop, clearLines };
}
