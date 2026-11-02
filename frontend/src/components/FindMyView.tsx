import { useMemo, useState } from "react";
import { Radar, ArrowUp, ArrowDown, Minus, Crosshair, Play, Square, Eraser, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { ConsoleLine } from "@/lib/bridge";
import {
  buildDevices,
  signalBars,
  DEFAULT_CALIBRATION,
  ENVIRONMENTS,
  type Calibration,
  type FindMyDevice,
  type ProximityBand,
  type Trend,
} from "@/lib/findmy";

interface Props {
  lines: ConsoleLine[];
  connected: boolean;
  running: boolean;
  onStart: () => void;
  onStop: () => void;
}

const BAND_LABEL: Record<ProximityBand, string> = { immediate: "Immediate", near: "Near", far: "Far" };
const BAND_CLASS: Record<ProximityBand, string> = {
  immediate: "bg-emerald-500/20 text-emerald-300 ring-emerald-500/30",
  near: "bg-amber-500/20 text-amber-300 ring-amber-500/30",
  far: "bg-sky-500/20 text-sky-300 ring-sky-500/30",
};

export function FindMyView({ lines, connected, running, onStart, onStop }: Props) {
  const [calib, setCalib] = useState<Calibration>(DEFAULT_CALIBRATION);
  const [sinceId, setSinceId] = useState(-1);
  const [selectedMac, setSelectedMac] = useState<string | null>(null);

  const lastId = lines.length ? lines[lines.length - 1].id : -1;
  const devices = useMemo(() => buildDevices(lines, calib, sinceId), [lines, calib, sinceId]);
  const selected = selectedMac ? devices.find((d) => d.mac === selectedMac) ?? null : null;

  const start = () => {
    setSinceId(lastId);
    onStart();
  };

  return (
    <div className="flex max-w-4xl flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
            <Radar className="size-5 text-primary" /> Find My — nearby devices
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Estimates how close each detected Find My / BLE device is from its signal strength. Listed
            nearest first; move around and watch the trend to home in on one.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {running ? (
            <Button variant="outline" size="sm" onClick={onStop}>
              <Square className="fill-current" /> Stop
            </Button>
          ) : (
            <Button size="sm" onClick={start} disabled={!connected} title={connected ? "" : "Connect a board first"}>
              <Play className="fill-current" /> Start Find My
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={() => setSinceId(lastId)} title="Clear detected devices">
            <Eraser /> Clear
          </Button>
        </div>
      </header>

      <p className="rounded-md border border-border bg-background/40 p-2.5 text-xs text-muted-foreground">
        Distance is estimated from signal strength, so treat it as rough — easily off by several metres
        from walls, bodies and antenna orientation. The closer/farther trend is the reliable part. Note
        that Find My rotates device identifiers, so a given device only stays identifiable for a while.
      </p>

      {/* Calibration */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-md border border-border bg-card/40 p-3 text-sm">
        <label className="flex items-center gap-2">
          <span className="text-muted-foreground">Signal at 1 m</span>
          <Input
            type="number"
            value={calib.txPower}
            onChange={(e) => setCalib((c) => ({ ...c, txPower: Number(e.target.value) || c.txPower }))}
            className="h-8 w-20"
          />
          <span className="text-muted-foreground">dBm</span>
        </label>
        <div className="flex items-center gap-1.5">
          <span className="text-muted-foreground">Environment</span>
          {ENVIRONMENTS.map((env) => (
            <button
              key={env.id}
              onClick={() => setCalib((c) => ({ ...c, pathLoss: env.pathLoss }))}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs transition-colors",
                calib.pathLoss === env.pathLoss
                  ? "bg-primary/15 text-primary"
                  : "text-foreground/80 hover:bg-secondary/60",
              )}
            >
              {env.label}
            </button>
          ))}
        </div>
      </div>

      {/* Homing panel for the selected device */}
      {selected && (
        <HomingPanel
          device={selected}
          onClose={() => setSelectedMac(null)}
          onCalibrate={(rssi) => setCalib((c) => ({ ...c, txPower: rssi }))}
        />
      )}

      {/* Device list */}
      {devices.length === 0 ? (
        <div className="rounded-md border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          {running
            ? "Listening… no Find My devices in range yet. Move around — nearby trackers will appear here."
            : connected
              ? "Start Find My to begin listening for nearby devices."
              : "Connect a board, then start Find My."}
        </div>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {devices.map((d) => (
            <li key={d.mac}>
              <button
                onClick={() => setSelectedMac(d.mac === selectedMac ? null : d.mac)}
                className={cn(
                  "flex w-full items-center gap-3 rounded-md border px-3 py-2.5 text-left transition-colors",
                  d.mac === selectedMac
                    ? "border-primary/40 bg-primary/10"
                    : "border-border bg-card/40 hover:bg-secondary/40",
                )}
              >
                <Bars rssi={d.rssi} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{d.name ?? "Unknown device"}</div>
                  <div className="truncate font-mono text-xs text-muted-foreground">{d.mac}</div>
                </div>
                <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium ring-1", BAND_CLASS[d.band])}>
                  {BAND_LABEL[d.band]}
                </span>
                <div className="w-16 text-right">
                  <div className="text-sm font-semibold tabular-nums">{fmtDist(d.distanceM)}</div>
                  <div className="text-[11px] text-muted-foreground tabular-nums">{d.rssi} dBm</div>
                </div>
                <TrendIcon trend={d.trend} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function HomingPanel({ device, onClose, onCalibrate }: { device: FindMyDevice; onClose: () => void; onCalibrate: (rssi: number) => void }) {
  return (
    <div className="rounded-lg border border-primary/30 bg-primary/5 p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Crosshair className="size-4 text-primary" /> Homing in on{" "}
          <span className="font-mono">{device.name ?? device.mac}</span>
        </div>
        <button onClick={onClose} className="rounded p-0.5 text-muted-foreground hover:bg-secondary/60" title="Stop homing">
          <X className="size-4" />
        </button>
      </div>
      <div className="mt-3 flex items-center gap-5">
        <div className="text-center">
          <div className="text-3xl font-bold tabular-nums">{fmtDist(device.distanceM)}</div>
          <div className={cn("mt-1 inline-block rounded-full px-2 py-0.5 text-xs font-medium ring-1", BAND_CLASS[device.band])}>
            {BAND_LABEL[device.band]}
          </div>
        </div>
        <div className="flex flex-col gap-1 text-sm">
          <div className="flex items-center gap-2">
            <Bars rssi={device.rssi} />
            <span className="tabular-nums">{device.rssi} dBm</span>
          </div>
          <div className="flex items-center gap-1.5 text-muted-foreground">
            <TrendIcon trend={device.trend} />
            {device.trend === "closer" ? "Getting closer" : device.trend === "farther" ? "Getting farther" : "Holding steady"}
            <span className="text-xs">· {device.samples} samples</span>
          </div>
        </div>
        <Button variant="outline" size="sm" className="ml-auto" onClick={() => onCalibrate(device.rssi)} title="Set this device's current signal as the 1 m reference">
          <Crosshair /> It's at 1 m
        </Button>
      </div>
    </div>
  );
}

function Bars({ rssi }: { rssi: number }) {
  const n = signalBars(rssi);
  return (
    <span className="inline-flex items-end gap-0.5" aria-label={`signal ${n} of 4`}>
      {[0, 1, 2, 3].map((i) => (
        <span
          key={i}
          className={cn("w-1 rounded-sm", i < n ? "bg-primary" : "bg-muted-foreground/25")}
          style={{ height: `${6 + i * 3}px` }}
        />
      ))}
    </span>
  );
}

function TrendIcon({ trend }: { trend: Trend }) {
  if (trend === "closer") return <ArrowUp className="size-4 shrink-0 text-emerald-400" />;
  if (trend === "farther") return <ArrowDown className="size-4 shrink-0 text-rose-400" />;
  return <Minus className="size-4 shrink-0 text-muted-foreground" />;
}

function fmtDist(m: number): string {
  return `~${m < 10 ? m.toFixed(1) : Math.round(m)} m`;
}
