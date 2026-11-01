/**
 * Client for the bridge's capture-library endpoints (Phase 3 analysis).
 *
 * Captures are files the user copied off the board's SD card into the captures folder. These calls are
 * read-only and work offline — the summaries come from parsing local files, not from the device.
 */
import { apiUrl } from "@/lib/bridge";

export interface CaptureMeta {
  name: string;
  size: number;
  modified: string;
  kind: "pcap" | "text";
}

export interface PcapSummary {
  kind: "pcap";
  name: string;
  link_type: number;
  link_type_name: string;
  frames: number;
  bytes: number;
  first: number | null;
  last: number | null;
  duration: number;
  bssids: string[];
  ssids: string[];
  truncated: boolean;
}

export interface TextPreview {
  kind: "text";
  name: string;
  preview: string[];
  truncated: boolean;
}

export interface CaptureError {
  kind: "error";
  name: string;
  error: string;
}

export type CaptureSummary = PcapSummary | TextPreview | CaptureError;

export async function listCaptures(): Promise<CaptureMeta[]> {
  const res = await fetch(apiUrl("/api/captures"));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as { captures: CaptureMeta[] };
  return json.captures ?? [];
}

export async function getCaptureSummary(name: string): Promise<CaptureSummary> {
  const res = await fetch(apiUrl(`/api/captures/${encodeURIComponent(name)}/summary`));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as CaptureSummary;
}

export interface WardrivePoint {
  mac: string;
  ssid: string;
  auth: string;
  channel: string;
  rssi: number | null;
  lat: number;
  lon: number;
}

export interface WardriveData {
  kind: "wardrive";
  name: string;
  points: WardrivePoint[];
  count: number;
  bounds: { min_lat: number; max_lat: number; min_lon: number; max_lon: number } | null;
  truncated: boolean;
}

export async function getWardrive(name: string): Promise<WardriveData> {
  const res = await fetch(apiUrl(`/api/captures/${encodeURIComponent(name)}/wardrive`));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as WardriveData;
}
