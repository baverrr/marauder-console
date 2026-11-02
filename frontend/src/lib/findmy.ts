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
}

const MAC_RE = /([0-9a-f]{2}(?::[0-9a-f]{2}){5})/i;
const RSSI_RE = /rssi[:=\s]\s*(-?\d{1,3})/i;
const RSSI_DBM_RE = /(-?\d{2,3})\s*dbm/i;
const NAME_RE = /name[:=]\s*(\S.*?)\s*$/i;
const EWMA_ALPHA = 0.35;

/**
 * Parse one serial line into a BLE sighting, or null if it isn't one. A line only counts when it has both
 * a MAC and a plausible RSSI, so ordinary status text is ignored. Tolerant of minor format differences
 * ("RSSI -63", "rssi:-63", "-63 dBm") since the exact firmware wording can vary by build.
 */
export function parseBleLine(text: string): { mac: string; rssi: number; name: string | null } | null {
  const mac = text.match(MAC_RE)?.[1];
  if (!mac) return null;
  const rssiStr = text.match(RSSI_RE)?.[1] ?? text.match(RSSI_DBM_RE)?.[1];
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
  const byMac = new Map<string, { rssis: number[]; name: string | null; lastId: number }>();
  for (const { id, text } of lines) {
    if (id <= sinceId) continue;
    const hit = parseBleLine(text);
    if (!hit) continue;
    let entry = byMac.get(hit.mac);
    if (!entry) {
      entry = { rssis: [], name: null, lastId: id };
      byMac.set(hit.mac, entry);
    }
    entry.rssis.push(hit.rssi);
    if (hit.name) entry.name = hit.name;
    entry.lastId = id;
  }

  const devices: FindMyDevice[] = [];
  for (const [mac, entry] of byMac) {
    const rssi = ewma(entry.rssis);
    const distanceM = estimateDistance(rssi, calib);
    devices.push({
      mac,
      name: entry.name,
      rssi: Math.round(rssi),
      rawRssi: entry.rssis[entry.rssis.length - 1],
      samples: entry.rssis.length,
      distanceM,
      band: bandFor(distanceM),
      trend: trendOf(entry.rssis),
      lastId: entry.lastId,
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
