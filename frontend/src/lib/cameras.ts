/**
 * Client for the bridge's LAN camera-discovery endpoint.
 *
 * `POST /api/cameras/scan` actively probes the local network — ONVIF WS-Discovery, optional mDNS, and a
 * short connect to known camera ports — and returns the hosts it found, each scored for whether it's a
 * camera. It is user-triggered only; nothing here runs on its own.
 */
import { apiUrl } from "@/lib/bridge";

export type Confidence = "low" | "medium" | "high";

export interface CameraRecord {
  /** Host address on the LAN. */
  ip: string;
  /** Friendly name from ONVIF scopes / mDNS, when advertised. */
  name: string | null;
  /** Vendor from the MAC OUI, when known. */
  vendor: string | null;
  /** Open camera-relevant TCP ports (e.g. 554 RTSP). */
  ports: number[];
  /** Answered ONVIF WS-Discovery. */
  onvif: boolean;
  /** mDNS service types seen (e.g. `_rtsp._tcp`). */
  mdns_services: string[];
  /** Whether the signals add up to a camera. */
  is_camera: boolean;
  /** How sure, when classified; null when nothing scored. */
  confidence: Confidence | null;
  /** Human-readable signals behind the verdict. */
  reasons: string[];
}

/**
 * Run a LAN camera scan on the bridge. `timeoutSec` bounds how long it listens for ONVIF/mDNS replies
 * (the bridge clamps it). Throws on a transport or bridge error.
 */
export async function scanCameras(timeoutSec?: number): Promise<CameraRecord[]> {
  const res = await fetch(apiUrl("/api/cameras/scan"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(timeoutSec != null ? { timeout: timeoutSec } : {}),
  });
  const data = (await res.json().catch(() => null)) as { ok?: boolean; cameras?: CameraRecord[]; error?: string } | null;
  if (!res.ok || !data?.ok) {
    throw new Error(data?.error ?? `Scan failed (HTTP ${res.status})`);
  }
  return data.cameras ?? [];
}
