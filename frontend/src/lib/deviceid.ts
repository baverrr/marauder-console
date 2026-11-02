/**
 * Say *what* a nearby BLE device is, from its decoded advertisement.
 *
 * `rawadv.ts` turns the raw bytes into GAP AD structures (name, services, manufacturer data). This module
 * reads those and classifies the device: the Apple / Find My manufacturer messages (offline-finding
 * trackers, iBeacons, proximity-pairing audio, "nearby" devices), well-known vendors by company id, and
 * well-known beacons/trackers by service UUID. For Find My offline-finding adverts it also decodes the
 * status byte into a battery level and whether the tracker is separated from its owner — the "what's
 * travelling with me" signal.
 *
 * Caveat, on purpose: Apple doesn't document these fields. The structure (TLV types, the offline-finding
 * length, the iBeacon layout) is well established from public reverse-engineering, but the finer
 * status-byte bits (battery, "maintained") are a best-effort reading that has shifted across iOS
 * versions, so the UI shows the raw status byte alongside the interpretation. Everything here is pure.
 */
import type { DecodedAdv } from "@/lib/rawadv";

/** Rough class of device, for grouping and iconography. */
export type DeviceCategory = "tracker" | "audio" | "device" | "beacon" | "camera" | "unknown";

/**
 * How sure a heuristic classification is. Cameras are matched by their advertised name (most only
 * advertise over BLE while pairing, or — like Flock Safety's ALPR cameras — as a beacon), so the match is
 * a likelihood, not a certainty; this says how camera-specific the matched name was.
 */
export type Confidence = "low" | "medium" | "high";

/** Battery level as read from a Find My status byte's top two bits. */
export type BatteryLevel = "full" | "medium" | "low" | "critical";

/** Decoded Apple Find My "offline finding" status. All of it is a best-effort read — see the file note. */
export interface FindMyStatus {
  /** The raw status byte, so the interpretation below can always be checked against ground truth. */
  statusByte: number;
  /** Battery level from the top two bits (0b00 full … 0b11 critical). */
  battery: BatteryLevel;
  /** Bit 2: the device reports being "maintained" (its owner connected to it recently). */
  maintained: boolean;
  /**
   * True when the advert carries the partial public key (the long, "separated / lost" payload) rather
   * than the short owner-is-nearby one. A separated tracker that stays with you as you move is the
   * notable "is something following me" case.
   */
  separated: boolean;
}

/** A decoded iBeacon (Apple manufacturer subtype 0x02): a proximity beacon's identity. */
export interface IBeacon {
  /** 128-bit proximity UUID, canonical "8-4-4-4-12" form. */
  uuid: string;
  major: number;
  minor: number;
}

export interface DeviceIdentity {
  /** Primary human label, e.g. "Find My tracker", "iBeacon", "AirPods / Beats", "Tile", "Microsoft". */
  label: string;
  /** Manufacturer name when known from the company id, else null. */
  vendor: string | null;
  category: DeviceCategory;
  /** Find My offline-finding status, when this is such an advert; else null. */
  findMy: FindMyStatus | null;
  /** iBeacon identity, when this is an iBeacon; else null. */
  ibeacon: IBeacon | null;
  /** Short qualifier shown next to the label, e.g. "separated", "owner nearby", "pairing"; else null. */
  note: string | null;
  /** For heuristic classifications (cameras matched by advertised name), how sure the match is; else absent. */
  confidence?: Confidence;
}

/** Bluetooth SIG company identifiers — the common subset worth naming; anything else stays a hex id. */
const COMPANY_NAMES: Record<number, string> = {
  0x004c: "Apple",
  0x0006: "Microsoft",
  0x0075: "Samsung",
  0x00e0: "Google",
  0x0087: "Garmin",
  0x0059: "Nordic",
  0x02e0: "Govee",
  0x0499: "Ruuvi",
  0x038f: "Xiaomi",
};

/** Well-known 16-bit service UUIDs that identify a device class or product. */
const SERVICE_NAMES: Record<string, { label: string; vendor: string | null; category: DeviceCategory }> = {
  "0xfeed": { label: "Tile", vendor: "Tile", category: "tracker" },
  "0xfeec": { label: "Tile", vendor: "Tile", category: "tracker" },
  "0xfeaa": { label: "Eddystone beacon", vendor: "Google", category: "beacon" },
  "0xfe9f": { label: "Google", vendor: "Google", category: "device" },
  "0xfd6f": { label: "Exposure notification", vendor: null, category: "beacon" },
  "0xfd5a": { label: "Samsung", vendor: "Samsung", category: "device" },
};

const BATTERY_LEVELS: BatteryLevel[] = ["full", "medium", "low", "critical"];

/**
 * Parse Apple's manufacturer data (the bytes after company id `0x004C`) into its {type,len,value} TLVs.
 * Apple packs several continuity messages into one blob; we want each so the most identifying one wins.
 */
function appleTlvs(manufacturerHex: string): { type: number; value: Uint8Array }[] {
  const bytes = hexToBytes(manufacturerHex);
  const out: { type: number; value: Uint8Array }[] = [];
  let i = 0;
  while (i + 2 <= bytes.length) {
    const type = bytes[i];
    const len = bytes[i + 1];
    const start = i + 2;
    const end = start + len;
    if (end > bytes.length) {
      // Length runs past the blob — keep what's there rather than dropping the message entirely.
      out.push({ type, value: bytes.slice(start) });
      break;
    }
    out.push({ type, value: bytes.slice(start, end) });
    i = end;
  }
  return out;
}

/** Decode a Find My offline-finding TLV (type 0x12) into its status, or null if it's too short. */
function findMyStatus(value: Uint8Array): FindMyStatus | null {
  if (value.length < 1) return null;
  const statusByte = value[0];
  return {
    statusByte,
    battery: BATTERY_LEVELS[(statusByte >> 6) & 0x03],
    maintained: (statusByte & 0x04) !== 0,
    // The separated/lost payload carries the partial public key (~22 bytes); the owner-nearby one is short.
    separated: value.length >= 0x18,
  };
}

/** Decode an iBeacon TLV (type 0x02): 16-byte UUID, 2-byte major, 2-byte minor (big-endian), 1-byte TX. */
function iBeaconFrom(value: Uint8Array): IBeacon | null {
  if (value.length < 20) return null; // 16 UUID + 2 major + 2 minor (TX power optional)
  return {
    uuid: formatUuid(value.slice(0, 16)),
    major: (value[16] << 8) | value[17],
    minor: (value[18] << 8) | value[19],
  };
}

/**
 * Camera name fingerprints, tried in order (first match wins), most camera-specific first. A hit on a
 * generic camera word ("camera", "cctv", "doorbell") or a camera-only brand (Reolink, Hikvision, Flock…)
 * is high confidence; a hit on a brand that also makes non-camera smart-home gear (Ring, Nest, Wyze…) is
 * only "likely". Matched case-insensitively against the advertised local name. This is a deliberately
 * conservative, extensible seed — the shared fingerprint data planned for the network scanner will grow it.
 */
const CAMERA_NAME_HINTS: { re: RegExp; vendor: string | null; confidence: Confidence }[] = [
  // Generic — the name itself says "camera".
  { re: /ip[-_ ]?cam(era)?\b/, vendor: null, confidence: "high" },
  { re: /\bcctv\b/, vendor: null, confidence: "high" },
  { re: /doorbell/, vendor: null, confidence: "high" },
  { re: /\bcamera\b/, vendor: null, confidence: "high" },
  // Camera-first vendors / product lines.
  { re: /flock/, vendor: "Flock Safety", confidence: "high" },
  { re: /reolink/, vendor: "Reolink", confidence: "high" },
  { re: /amcrest/, vendor: "Amcrest", confidence: "high" },
  { re: /hikvision/, vendor: "Hikvision", confidence: "high" },
  { re: /\bdahua\b/, vendor: "Dahua", confidence: "high" },
  { re: /lorex/, vendor: "Lorex", confidence: "high" },
  { re: /foscam/, vendor: "Foscam", confidence: "high" },
  { re: /annke/, vendor: "Annke", confidence: "high" },
  { re: /wyze[-_ ]?cam/, vendor: "Wyze", confidence: "high" },
  // Brands that also make non-camera gear — a name hit is "likely", not certain.
  { re: /\bwyze\b/, vendor: "Wyze", confidence: "medium" },
  { re: /\bring\b/, vendor: "Ring", confidence: "medium" },
  { re: /\bnest\b/, vendor: "Google Nest", confidence: "medium" },
  { re: /\barlo\b/, vendor: "Arlo", confidence: "medium" },
  { re: /\beufy\b/, vendor: "Eufy", confidence: "medium" },
  { re: /\bblink\b/, vendor: "Blink", confidence: "medium" },
  { re: /\btapo\b/, vendor: "TP-Link Tapo", confidence: "medium" },
  // A bare "cam" token — could be a camera; lowest confidence.
  { re: /\bcam\b/, vendor: null, confidence: "low" },
];

/**
 * Identify a camera from an advertised BLE name. Pure and null when nothing matches. Exposed separately so
 * the radar can also check plain sightings (which carry a name but no decoded advert, e.g. from `recon ble`
 * without raw capture) — not just fully decoded adverts.
 */
export function identifyCameraByName(name: string | null): DeviceIdentity | null {
  if (!name) return null;
  const n = name.toLowerCase();
  for (const hint of CAMERA_NAME_HINTS) {
    if (hint.re.test(n)) {
      return {
        label: hint.vendor ? `${hint.vendor} camera` : "Camera",
        vendor: hint.vendor,
        category: "camera",
        findMy: null,
        ibeacon: null,
        note: null,
        confidence: hint.confidence,
      };
    }
  }
  return null;
}

/**
 * Classify a decoded advertisement. Returns null when nothing identifying is present (no vendor, no known
 * service, no Apple message) so the caller can fall back to the device name.
 */
export function identifyDevice(adv: DecodedAdv | null): DeviceIdentity | null {
  if (!adv) return null;
  const vendor = adv.companyId !== null ? COMPANY_NAMES[adv.companyId] ?? null : null;

  // Apple continuity / Find My messages carry the most useful identity.
  if (adv.isApple && adv.manufacturerHex) {
    const tlvs = appleTlvs(adv.manufacturerHex);
    const findMyTlv = tlvs.find((t) => t.type === 0x12);
    if (findMyTlv) {
      const findMy = findMyStatus(findMyTlv.value);
      return {
        label: "Find My tracker",
        vendor: "Apple",
        category: "tracker",
        findMy,
        ibeacon: null,
        note: findMy ? (findMy.separated ? "separated" : "owner nearby") : null,
      };
    }
    const iBeaconTlv = tlvs.find((t) => t.type === 0x02);
    if (iBeaconTlv) {
      const ibeacon = iBeaconFrom(iBeaconTlv.value);
      return {
        label: "iBeacon",
        vendor: "Apple",
        category: "beacon",
        findMy: null,
        ibeacon,
        note: ibeacon ? `major ${ibeacon.major} · minor ${ibeacon.minor}` : null,
      };
    }
    if (tlvs.some((t) => t.type === 0x07)) {
      return { label: "AirPods / Beats", vendor: "Apple", category: "audio", findMy: null, ibeacon: null, note: "pairing" };
    }
    if (tlvs.some((t) => t.type === 0x10)) {
      return { label: "Apple device", vendor: "Apple", category: "device", findMy: null, ibeacon: null, note: "nearby" };
    }
    return { label: "Apple device", vendor: "Apple", category: "device", findMy: null, ibeacon: null, note: null };
  }

  // Non-Apple: a known service UUID names the product/class.
  for (const svc of adv.services) {
    const hit = SERVICE_NAMES[svc.toLowerCase()];
    if (hit) return { label: hit.label, vendor: hit.vendor, category: hit.category, findMy: null, ibeacon: null, note: null };
  }

  // A camera named in the advertisement beats the generic vendor fallback below.
  const camera = identifyCameraByName(adv.name);
  if (camera) return camera;

  // Otherwise fall back to a named manufacturer, if any.
  if (vendor) return { label: vendor, vendor, category: "device", findMy: null, ibeacon: null, note: null };

  return null;
}

/** Human one-liner for a battery level. */
export function batteryLabel(level: BatteryLevel): string {
  return { full: "Full", medium: "Medium", low: "Low", critical: "Critical" }[level];
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.length % 2 === 0 ? hex : hex.slice(0, -1);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** 16 big-endian bytes → canonical "8-4-4-4-12" UUID string. */
function formatUuid(bytes: Uint8Array): string {
  let h = "";
  for (const b of bytes) h += b.toString(16).padStart(2, "0");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
