/**
 * Turn the Find My / BLE serial stream into ranked "how close is each device" data.
 *
 * The ESP32 is the only thing that measures signal — each `findmy` sighting line carries an RSSI, and we
 * parse that here. Distance comes from the log-distance path-loss model, which is genuinely rough (RSSI
 * swings several dBm from multipath, body blocking and orientation), so the UI leans on proximity bands
 * and a closer/farther trend rather than pretending to centimetre accuracy. Everything here is pure, so
 * the view can rebuild the device list from the console buffer on every render.
 */
import type { ConsoleLine } from "@/lib/bridge";
import { parseRawAdvLine, decodeAdv, type DecodedAdv } from "@/lib/rawadv";

/** How close a device is, from its (smoothed) signal. Honest about RSSI's imprecision. */
export type ProximityBand = "immediate" | "near" | "far";

/** Which way a device's signal is moving as you walk around. */
export type Trend = "closer" | "farther" | "steady";

/**
 * RSSI→distance calibration. `txPower` is the RSSI you'd measure at 1 m from the device; `pathLoss` is
 * the environment exponent n (~2 open air, ~3–4 indoors). Both are approximate and worth calibrating for
 * the device and space you're in.
 */
export interface Calibration {
  txPower: number;
  pathLoss: number;
}

export const DEFAULT_CALIBRATION: Calibration = { txPower: -59, pathLoss: 2.5 };

/** Named environments mapped to a path-loss exponent, for a friendlier calibration control. */
export const ENVIRONMENTS: { id: string; label: string; pathLoss: number }[] = [
  { id: "open", label: "Open air", pathLoss: 2.0 },
  { id: "indoor", label: "Indoors", pathLoss: 2.5 },
  { id: "dense", label: "Walls / clutter", pathLoss: 3.3 },
];

export interface FindMyDevice {
  mac: string;
  name: string | null;
  /** Smoothed RSSI (EWMA), dBm. */
  rssi: number;
  /** Most recent raw RSSI, dBm. */
  rawRssi: number;
  samples: number;
  /** Rough distance estimate, metres. */
  distanceM: number;
  band: ProximityBand;
  trend: Trend;
  /** Console line id of the most recent sighting (recency / tie-break). */
  lastId: number;
  /**
   * Latest decoded raw advertisement for this device, when the firmware was asked for it
   * (`sniffbt -t airtag -raw`) and emitted a `RAWADV` line. null with stock firmware, which never
   * surfaces the raw bytes.
   */
  adv: DecodedAdv | null;
}

const MAC_RE = /([0-9a-f]{2}(?::[0-9a-f]{2}){5})/i;
const RSSI_RE = /rssi[:=\s]\s*(-?\d{1,3})/i;
const RSSI_DBM_RE = /(-?\d{2,3})\s*dbm/i;
// The real Marauder BLE sniff (`sniffbt -t airtag`) prints bare "<rssi> <mac>", e.g. "-91 AA:BB:CC:DD:EE:FF"
// (sometimes with a leading "> " prompt), with no "rssi"/"dBm" label — so match a negative RSSI that sits
// right before the MAC. Anchoring on the MAC keeps this from grabbing an unrelated number elsewhere.
const RSSI_BARE_RE = /(-\d{2,3})\s+(?:[0-9a-f]{2}:){5}[0-9a-f]{2}/i;
const NAME_RE = /name[:=]\s*(\S.*?)\s*$/i;
const EWMA_ALPHA = 0.35;

/**
 * Parse one serial line into a BLE sighting, or null if it isn't one. A line only counts when it has both
 * a MAC and a plausible RSSI, so ordinary status text is ignored. Tolerant of the format differences seen
 * across firmware builds: the real `sniffbt` output "-63 AA:BB:.." as well as labelled variants
 * ("RSSI -63", "rssi:-63", "-63 dBm").
 */
export function parseBleLine(text: string): { mac: string; rssi: number; name: string | null } | null {
  // The custom firmware's raw-dump line ("RAWADV <MAC> <rssi> <hex>") is handled by parseRawAdvLine and
  // decoded separately; skip it here so its trailing hex can never be misread as a sighting.
  if (/\bRAWADV\b/i.test(text)) return null;
  const mac = text.match(MAC_RE)?.[1];
  if (!mac) return null;
  const rssiStr =
    text.match(RSSI_RE)?.[1] ?? text.match(RSSI_DBM_RE)?.[1] ?? text.match(RSSI_BARE_RE)?.[1];
  if (rssiStr === undefined) return null;
  const rssi = Number(rssiStr);
  if (!Number.isFinite(rssi) || rssi > 0 || rssi < -120) return null;
  const name = text.match(NAME_RE)?.[1]?.trim() || null;
  return { mac: mac.toUpperCase(), rssi, name };
}

/** Rough distance (metres) from RSSI via the log-distance path-loss model, clamped to a sane range. */
export function estimateDistance(rssi: number, { txPower, pathLoss }: Calibration): number {
  const d = Math.pow(10, (txPower - rssi) / (10 * pathLoss));
  return Math.min(100, Math.max(0.1, d));
}

export function bandFor(distanceM: number): ProximityBand {
  if (distanceM <= 1) return "immediate";
  if (distanceM <= 5) return "near";
  return "far";
}

/** 0–4 signal bars from RSSI, for a quick visual. */
export function signalBars(rssi: number): number {
  if (rssi >= -55) return 4;
  if (rssi >= -67) return 3;
  if (rssi >= -78) return 2;
  if (rssi >= -88) return 1;
  return 0;
}

/**
 * Build the current device list from the console buffer: parse sightings, group by MAC, smooth RSSI,
 * estimate distance, derive a trend, and sort nearest-first. `sinceId` drops lines at or before that id
 * so Start/Clear can reset the view without touching the shared buffer.
 */
export function buildDevices(lines: ConsoleLine[], calib: Calibration, sinceId = -1): FindMyDevice[] {
  const byMac = new Map<
    string,
    { rssis: number[]; name: string | null; lastId: number; adv: DecodedAdv | null }
  >();
  const ensure = (mac: string, id: number) => {
    let entry = byMac.get(mac);
    if (!entry) {
      entry = { rssis: [], name: null, lastId: id, adv: null };
      byMac.set(mac, entry);
    }
    return entry;
  };
  for (const { id, text } of lines) {
    if (id <= sinceId) continue;
    // A raw-dump line enriches an existing sighting with decoded fields; it doesn't add an RSSI sample,
    // since the firmware also prints the plain "<rssi> <mac>" line for the same advert (parsed below).
    const raw = parseRawAdvLine(text);
    if (raw) {
      const entry = ensure(raw.mac, id);
      entry.adv = decodeAdv(raw.payload);
      entry.lastId = id;
      continue;
    }
    const hit = parseBleLine(text);
    if (!hit) continue;
    const entry = ensure(hit.mac, id);
    entry.rssis.push(hit.rssi);
    if (hit.name) entry.name = hit.name;
    entry.lastId = id;
  }

  const devices: FindMyDevice[] = [];
  for (const [mac, entry] of byMac) {
    // A device known only from a RAWADV line (no plain sighting yet) has no RSSI samples to rank or
    // estimate distance from, so skip it until a sighting arrives.
    if (entry.rssis.length === 0) continue;
    const rssi = ewma(entry.rssis);
    const distanceM = estimateDistance(rssi, calib);
    devices.push({
      mac,
      // Prefer a complete local name decoded from the raw advert over the (usually absent) name on the
      // plain sniff line.
      name: entry.adv?.name ?? entry.name,
      rssi: Math.round(rssi),
      rawRssi: entry.rssis[entry.rssis.length - 1],
      samples: entry.rssis.length,
      distanceM,
      band: bandFor(distanceM),
      trend: trendOf(entry.rssis),
      lastId: entry.lastId,
      adv: entry.adv,
    });
  }
  // Nearest first; ties broken by most-recently-seen.
  devices.sort((a, b) => b.rssi - a.rssi || b.lastId - a.lastId);
  return devices;
}

function ewma(values: number[]): number {
  if (values.length === 0) return -100;
  let acc = values[0];
  for (let i = 1; i < values.length; i++) acc = EWMA_ALPHA * values[i] + (1 - EWMA_ALPHA) * acc;
  return acc;
}

/** Compare the newer half of recent samples to the older half: rising RSSI means you're getting closer. */
function trendOf(values: number[]): Trend {
  const n = values.length;
  if (n < 4) return "steady";
  const window = values.slice(Math.max(0, n - 8));
  const mid = Math.floor(window.length / 2);
  const delta = avg(window.slice(mid)) - avg(window.slice(0, mid));
  if (delta > 2) return "closer";
  if (delta < -2) return "farther";
  return "steady";
}

function avg(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}
