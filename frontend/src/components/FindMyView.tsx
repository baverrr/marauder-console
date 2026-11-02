import { useMemo, useState } from "react";
import {
  Radar, ArrowUp, ArrowDown, Minus, Crosshair, Play, Square, Eraser, X, Tag,
  Headphones, Smartphone, RadioTower, MapPin, HelpCircle, type LucideIcon,
} from "lucide-react";
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
import { bytesToHex, type DecodedAdv } from "@/lib/rawadv";
import {
  identifyDevice,
  batteryLabel,
  type DeviceIdentity,
  type DeviceCategory,
  type BatteryLevel,
} from "@/lib/deviceid";

const CATEGORY_ICON: Record<DeviceCategory, LucideIcon> = {
  tracker: MapPin,
  audio: Headphones,
  device: Smartphone,
  beacon: RadioTower,
  unknown: HelpCircle,
};

/** Tailwind text colour per battery level, worst → most attention. */
const BATTERY_CLASS: Record<BatteryLevel, string> = {
  full: "text-emerald-400",
  medium: "text-sky-400",
  low: "text-amber-400",
  critical: "text-rose-400",
};

/** Compact "what is it" chip: category icon, label, battery (Find My), and a short qualifier. */
function IdentityChip({ id }: { id: DeviceIdentity }) {
  const Icon = CATEGORY_ICON[id.category];
  // A separated Find My tracker is the one worth flagging (it may be travelling with you), so tint it amber.
  const separated = id.findMy?.separated ?? false;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium",
        separated ? "bg-amber-500/15 text-amber-300" : "bg-primary/15 text-primary",
      )}
    >
      <Icon className="size-2.5" /> {id.label}
      {id.note && <span className="opacity-70">· {id.note}</span>}
      {id.findMy && (
        <span className={cn("opacity-90", BATTERY_CLASS[id.findMy.battery])}>
          · {batteryLabel(id.findMy.battery).toLowerCase()} batt
        </span>
      )}
    </span>
  );
}

interface Props {
  lines: ConsoleLine[];
  connected: boolean;
  running: boolean;
  /** Start a scan with the given board command (built from the selected scan mode and the Raw toggle). */
  onStart: (command: string) => void;
  onStop: () => void;
}

/**
 * Scan modes the radar can drive. `cmd` is the board command; `rawSupported` is whether the custom
 * firmware's `-raw` advert dump applies (the Find My / sniffbt family — `recon ble` sniffs every BLE
 * device but doesn't take `-raw` yet, so it gives signal + name only).
 */
interface ScanMode {
  id: string;
  label: string;
  cmd: string;
  rawSupported: boolean;
  blurb: string;
}
const SCAN_MODES: ScanMode[] = [
  { id: "airtag", label: "Find My", cmd: "sniffbt -t airtag", rawSupported: true, blurb: "Apple Find My / AirTag trackers." },
  { id: "ibeacon", label: "iBeacon", cmd: "sniffbt -t ibeacon", rawSupported: true, blurb: "iBeacon proximity beacons (UUID / major / minor)." },
  { id: "flipper", label: "Flipper", cmd: "sniffbt -t flipper", rawSupported: true, blurb: "Flipper Zero devices advertising nearby." },
  { id: "flock", label: "Flock", cmd: "sniffbt -t flock", rawSupported: true, blurb: "Flock Safety camera beacons." },
  { id: "all", label: "All BLE", cmd: "recon ble", rawSupported: true, blurb: "Every BLE device in range (general recon)." },
];

/** Remember the raw-capture preference across reloads; defaults on. Storage may be unavailable. */
function loadRawPref(): boolean {
  try {
    return localStorage.getItem("findmy.rawCapture") !== "0";
  } catch {
    return true;
  }
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
  const [rawCapture, setRawCapture] = useState<boolean>(loadRawPref);
  const [modeId, setModeId] = useState<string>("airtag");
  const mode = SCAN_MODES.find((m) => m.id === modeId) ?? SCAN_MODES[0];

  const toggleRaw = () =>
    setRawCapture((on) => {
      const next = !on;
      try {
        localStorage.setItem("findmy.rawCapture", next ? "1" : "0");
      } catch {
        /* storage unavailable — keep the in-memory preference */
      }
      return next;
    });

  const lastId = lines.length ? lines[lines.length - 1].id : -1;
  const devices = useMemo(() => buildDevices(lines, calib, sinceId), [lines, calib, sinceId]);
  const selected = selectedMac ? devices.find((d) => d.mac === selectedMac) ?? null : null;

  const rawActive = rawCapture && mode.rawSupported;
  const start = () => {
    setSinceId(lastId);
    onStart(mode.cmd + (rawActive ? " -raw" : ""));
  };

  return (
    <div className="flex max-w-4xl flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
            <Radar className="size-5 text-primary" /> Find My radar — nearby devices
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Listens for nearby BLE devices — Find My trackers by default, or pick another kind below — and
            estimates how close each is from its signal strength. Listed nearest first; move around and
            watch the trend to home in on one.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            role="switch"
            aria-checked={rawActive}
            onClick={toggleRaw}
            disabled={running || !mode.rawSupported}
            title={
              mode.rawSupported
                ? "Request raw advertisement bytes (sniffbt -raw) so adverts can be decoded and devices identified. Requires the custom raw-capture firmware; applies to the next scan."
                : `${mode.label} doesn't support raw capture yet — it reports signal and name only.`
            }
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors disabled:opacity-50",
              rawActive ? "bg-primary/15 text-primary" : "text-foreground/80 hover:bg-secondary/60",
            )}
          >
            <Tag className="size-3" /> Raw {rawActive ? "on" : "off"}
          </button>
          {running ? (
            <Button variant="outline" size="sm" onClick={onStop}>
              <Square className="fill-current" /> Stop
            </Button>
          ) : (
            <Button size="sm" onClick={start} disabled={!connected} title={connected ? "" : "Connect a board first"}>
              <Play className="fill-current" /> Start {mode.label}
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={() => setSinceId(lastId)} title="Clear detected devices">
            <Eraser /> Clear
          </Button>
        </div>
      </header>

      {/* Scan mode: what kind of device to listen for. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-border bg-card/40 p-3 text-sm">
        <span className="text-muted-foreground">Scan for</span>
        <div className="flex flex-wrap items-center gap-1.5">
          {SCAN_MODES.map((m) => (
            <button
              key={m.id}
              onClick={() => setModeId(m.id)}
              disabled={running}
              title={m.blurb}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs transition-colors disabled:opacity-50",
                m.id === modeId ? "bg-primary/15 text-primary" : "text-foreground/80 hover:bg-secondary/60",
              )}
            >
              {m.label}
            </button>
          ))}
        </div>
        <span className="text-xs text-muted-foreground">{mode.blurb}</span>
      </div>

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
            ? `Listening… no ${mode.label} devices in range yet. Move around — nearby devices will appear here.`
            : connected
              ? `Start ${mode.label} to begin listening for nearby devices.`
              : `Connect a board, then start ${mode.label}.`}
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
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-sm font-medium">{d.name ?? "Unknown device"}</span>
                    {identifyDevice(d.adv) && <IdentityChip id={identifyDevice(d.adv)!} />}
                  </div>
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
      {device.adv && <AdvDetails adv={device.adv} />}
    </div>
  );
}

/**
 * Decoded raw advertisement for the selected device. Only shown when the custom raw-capture firmware is
 * running (`sniffbt -t airtag -raw`); with stock firmware there are no raw bytes and this is absent.
 */
function AdvDetails({ adv }: { adv: DecodedAdv }) {
  const id = identifyDevice(adv);
  const rows: { label: string; value: string }[] = [];
  if (id) rows.push({ label: "Device", value: id.note ? `${id.label} · ${id.note}` : id.label });
  if (id?.ibeacon) {
    rows.push({ label: "iBeacon UUID", value: id.ibeacon.uuid });
    rows.push({ label: "Major / Minor", value: `${id.ibeacon.major} / ${id.ibeacon.minor}` });
  }
  if (id?.findMy) {
    const fm = id.findMy;
    rows.push({ label: "Owner state", value: fm.separated ? "Separated (findable, away from owner)" : "Owner nearby" });
    rows.push({ label: "Battery", value: batteryLabel(fm.battery) });
    rows.push({ label: "Maintained", value: fm.maintained ? "Yes (owner connected recently)" : "No" });
    rows.push({ label: "Status byte", value: `0x${fm.statusByte.toString(16).padStart(2, "0")} (best-effort read)` });
  }
  if (adv.flags !== null) rows.push({ label: "Flags", value: `0x${adv.flags.toString(16).padStart(2, "0")}` });
  if (adv.companyId !== null) {
    const co = `0x${adv.companyId.toString(16).padStart(4, "0")}`;
    rows.push({ label: "Manufacturer", value: adv.isApple ? `Apple (${co})` : co });
  }
  if (adv.services.length) rows.push({ label: "Services", value: adv.services.join(", ") });

  return (
    <details className="mt-3 border-t border-primary/20 pt-3">
      <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
        Advertisement ({adv.structures.length} record{adv.structures.length === 1 ? "" : "s"})
      </summary>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        {rows.map((r) => (
          <div key={r.label} className="contents">
            <dt className="text-muted-foreground">{r.label}</dt>
            <dd className="min-w-0 break-all font-mono">{r.value}</dd>
          </div>
        ))}
        <dt className="text-muted-foreground">Raw</dt>
        <dd className="min-w-0 break-all font-mono text-muted-foreground">{bytesToHex(adv.raw)}</dd>
      </dl>
    </details>
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
