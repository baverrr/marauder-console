import { useState } from "react";
import { Cctv, Play, Loader2, AlertCircle, ShieldAlert, Radio, Network } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { scanCameras, type CameraRecord, type Confidence } from "@/lib/cameras";

const CONF_CLASS: Record<Confidence, string> = {
  high: "bg-rose-500/15 text-rose-300",
  medium: "bg-amber-500/15 text-amber-300",
  low: "bg-sky-500/15 text-sky-300",
};

/** PC-side network camera scan: asks the bridge to probe the LAN and lists what it finds. */
export function CameraScanView() {
  const [scanning, setScanning] = useState(false);
  const [results, setResults] = useState<CameraRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setScanning(true);
    setError(null);
    try {
      setResults(await scanCameras());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Scan failed");
    } finally {
      setScanning(false);
    }
  };

  const cameras = results?.filter((r) => r.is_camera) ?? [];
  const others = results?.filter((r) => !r.is_camera) ?? [];

  return (
    <div className="flex max-w-4xl flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
            <Cctv className="size-5 text-primary" /> Camera scan — network
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Finds IP cameras on your local network and shows each one's address, vendor and open ports.
            Unlike the radar, this runs from the PC — no board needed — using ONVIF discovery, mDNS and a
            quick check of known camera ports.
          </p>
        </div>
        <Button size="sm" onClick={run} disabled={scanning}>
          {scanning ? <Loader2 className="animate-spin" /> : <Play className="fill-current" />}
          {scanning ? "Scanning…" : "Scan my network"}
        </Button>
      </header>

      <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs text-amber-200/90">
        <ShieldAlert className="size-4 shrink-0" />
        <span>
          This actively probes your local network (multicast discovery plus short connections to camera
          ports). Only run it on a network you own or are authorised to test.
        </span>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2.5 text-sm text-destructive">
          <AlertCircle className="size-4 shrink-0" />
          {error}
        </div>
      )}

      {results === null ? (
        <div className="rounded-md border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          {scanning ? "Listening for cameras on the network…" : "Run a scan to find cameras on your network."}
        </div>
      ) : cameras.length === 0 && others.length === 0 ? (
        <div className="rounded-md border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          No cameras answered. That doesn't prove there are none — a camera may not speak ONVIF/mDNS, or may
          be on another network segment. Pair this with the BLE radar and the optical lens finder.
        </div>
      ) : (
        <>
          <ul className="flex flex-col gap-1.5">
            {cameras.map((cam) => (
              <CameraRow key={cam.ip} cam={cam} />
            ))}
          </ul>

          {others.length > 0 && (
            <details className="rounded-md border border-border bg-card/40 p-3 text-sm">
              <summary className="cursor-pointer text-muted-foreground">
                {others.length} other host{others.length === 1 ? "" : "s"} discovered (not classified as cameras)
              </summary>
              <ul className="mt-2 flex flex-col gap-1">
                {others.map((h) => (
                  <li key={h.ip} className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="font-mono">{h.ip}</span>
                    {h.vendor && <span>· {h.vendor}</span>}
                    {h.ports.length > 0 && <span>· ports {h.ports.join(", ")}</span>}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </div>
  );
}

function CameraRow({ cam }: { cam: CameraRecord }) {
  return (
    <li className="rounded-md border border-border bg-card/40 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Cctv className="size-4 shrink-0 text-rose-300" />
        <span className="font-medium">{cam.name ?? cam.vendor ?? "Camera"}</span>
        {cam.confidence && (
          <span
            className={cn(
              "rounded-full px-1.5 py-0.5 text-[10px] font-medium",
              CONF_CLASS[cam.confidence],
            )}
          >
            {cam.confidence} confidence
          </span>
        )}
        {cam.onvif && (
          <span className="inline-flex items-center gap-1 rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] text-primary">
            <Radio className="size-2.5" /> ONVIF
          </span>
        )}
        {cam.mdns_services.map((s) => (
          <span key={s} className="inline-flex items-center gap-1 rounded-full bg-secondary/60 px-1.5 py-0.5 text-[10px]">
            <Network className="size-2.5" /> {s}
          </span>
        ))}
        <span className="ml-auto font-mono text-sm">{cam.ip}</span>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
        {cam.vendor && <span>Vendor: {cam.vendor}</span>}
        {cam.ports.length > 0 && <span>Open ports: {cam.ports.join(", ")}</span>}
      </div>
      {cam.reasons.length > 0 && (
        <div className="mt-1 text-[11px] text-muted-foreground/80">Why: {cam.reasons.join(" · ")}</div>
      )}
    </li>
  );
}
