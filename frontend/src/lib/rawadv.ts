/**
 * Decode raw BLE advertisement payloads into their GAP "AD structures".
 *
 * Stock ESP32 Marauder only prints parsed fields, so the console never saw the actual advertisement
 * bytes. The custom firmware patch in `firmware/custom-rawadv/` adds an opt-in line alongside the normal
 * sniff output:
 *
 *     RAWADV <MAC> <rssi> <hexpayload>
 *     e.g. RAWADV 00:00:5E:00:53:17 -63 1eff4c0012...
 *
 * `parseRawAdvLine` turns that line back into bytes; `decodeAdv` walks the length-type-value AD
 * structures (Bluetooth Core, "Generic Access Profile" assigned numbers) into something the Find My
 * radar can show: the real local name, service UUIDs, flags, and Apple (`0x004C`) manufacturer data /
 * Find My status. Everything here is pure and side-effect free, so the view can re-decode from the
 * console buffer on every render.
 */

/** A parsed `RAWADV` line: the device address, its RSSI, and the full advertisement payload. */
export interface RawAdv {
  mac: string;
  rssi: number;
  payload: Uint8Array;
}

/** One length-type-value AD structure from the advertisement. */
export interface AdStructure {
  /** GAP AD type byte, e.g. 0x09 (complete local name), 0xFF (manufacturer data). */
  type: number;
  /** Human label for the type, or "0xNN" when unknown. */
  typeName: string;
  /** The structure's data bytes (the length/type prefix stripped off). */
  data: Uint8Array;
}

/** What kind of Apple advertisement this is, when the manufacturer is Apple (`0x004C`). */
export type AppleKind = "offline-finding" | "nearby" | "apple-other";

/** A decoded advertisement: the useful fields pulled out, plus every raw AD structure. */
export interface DecodedAdv {
  /** GAP flags byte (AD type 0x01), or null if absent. */
  flags: number | null;
  /** Complete (0x09) or shortened (0x08) local name, decoded as UTF-8, or null. */
  name: string | null;
  /** True when `name` came from the *complete* local name (0x09). */
  nameComplete: boolean;
  /** Advertised service UUIDs (16/32/128-bit), formatted as hex / canonical UUID strings. */
  services: string[];
  /** Company identifier from the first manufacturer-data structure (little-endian), or null. */
  companyId: number | null;
  /** The manufacturer-data bytes after the company id, as a lowercase hex string, or null. */
  manufacturerHex: string | null;
  /** True when the first manufacturer data is Apple's (`0x004C`). */
  isApple: boolean;
  /** For Apple adverts, which flavour (Find My offline-finding, nearby, or other); else null. */
  appleKind: AppleKind | null;
  /** Every AD structure, in order, for a full raw view. */
  structures: AdStructure[];
  /** The original payload bytes. */
  raw: Uint8Array;
}

const APPLE_COMPANY_ID = 0x004c;

/** GAP AD type labels (the common subset; anything else is shown as its hex byte). */
const AD_TYPE_NAMES: Record<number, string> = {
  0x01: "Flags",
  0x02: "Incomplete 16-bit Service UUIDs",
  0x03: "Complete 16-bit Service UUIDs",
  0x04: "Incomplete 32-bit Service UUIDs",
  0x05: "Complete 32-bit Service UUIDs",
  0x06: "Incomplete 128-bit Service UUIDs",
  0x07: "Complete 128-bit Service UUIDs",
  0x08: "Shortened Local Name",
  0x09: "Complete Local Name",
  0x0a: "Tx Power Level",
  0x16: "Service Data (16-bit)",
  0x19: "Appearance",
  0x1b: "LE Bluetooth Device Address",
  0x20: "Service Data (32-bit)",
  0x21: "Service Data (128-bit)",
  0xff: "Manufacturer Specific Data",
};

/** Match a `RAWADV <MAC> <rssi> <hex>` line (leading `> ` prompt and surrounding space tolerated). */
const RAWADV_RE =
  /RAWADV\s+((?:[0-9a-f]{2}:){5}[0-9a-f]{2})\s+(-?\d{1,3})\s+([0-9a-f]*)/i;

/** Parse one serial line into a {mac, rssi, payload}, or null if it isn't a well-formed RAWADV line. */
export function parseRawAdvLine(text: string): RawAdv | null {
  const m = text.match(RAWADV_RE);
  if (!m) return null;
  const rssi = Number(m[2]);
  if (!Number.isFinite(rssi) || rssi > 0 || rssi < -120) return null;
  const hex = m[3];
  // Odd-length hex can't be whole bytes — treat as malformed rather than guessing.
  if (hex.length % 2 !== 0) return null;
  const payload = hexToBytes(hex);
  return { mac: m[1].toUpperCase(), rssi, payload };
}

/** Walk the length-type-value AD structures of an advertisement payload into a decoded summary. */
export function decodeAdv(payload: Uint8Array): DecodedAdv {
  const structures: AdStructure[] = [];
  let i = 0;
  while (i < payload.length) {
    const len = payload[i];
    // A zero length marks the end of significant data; a length that runs past the buffer is malformed,
    // so stop rather than read out of bounds.
    if (len === 0) break;
    if (i + 1 + len > payload.length) break;
    const type = payload[i + 1];
    const data = payload.slice(i + 2, i + 1 + len);
    structures.push({ type, typeName: AD_TYPE_NAMES[type] ?? `0x${byte(type)}`, data });
    i += 1 + len;
  }

  let flags: number | null = null;
  let name: string | null = null;
  let nameComplete = false;
  const services: string[] = [];
  let companyId: number | null = null;
  let manufacturerHex: string | null = null;

  for (const s of structures) {
    switch (s.type) {
      case 0x01:
        if (s.data.length >= 1) flags = s.data[0];
        break;
      case 0x08: // shortened — only use it if we don't already have the complete name
        if (!nameComplete && name === null) name = decodeUtf8(s.data);
        break;
      case 0x09:
        name = decodeUtf8(s.data);
        nameComplete = true;
        break;
      case 0x02:
      case 0x03:
        services.push(...uuids16(s.data));
        break;
      case 0x04:
      case 0x05:
        services.push(...uuids32(s.data));
        break;
      case 0x06:
      case 0x07:
        services.push(...uuids128(s.data));
        break;
      case 0xff:
        if (companyId === null && s.data.length >= 2) {
          companyId = s.data[0] | (s.data[1] << 8); // little-endian company id
          manufacturerHex = bytesToHex(s.data.slice(2));
        }
        break;
    }
  }

  const isApple = companyId === APPLE_COMPANY_ID;
  let appleKind: AppleKind | null = null;
  if (isApple) {
    // Apple manufacturer data is a sequence of {type, length, …} entries after the company id. The first
    // type byte tells the flavour: 0x12 is Find My / offline finding, 0x07 is "nearby" (proximity
    // pairing, e.g. a just-separated AirTag), anything else is some other Apple continuity message.
    const first = manufacturerHex && manufacturerHex.length >= 2 ? parseInt(manufacturerHex.slice(0, 2), 16) : null;
    appleKind = first === 0x12 ? "offline-finding" : first === 0x07 ? "nearby" : "apple-other";
  }

  return {
    flags,
    name,
    nameComplete,
    services,
    companyId,
    manufacturerHex,
    isApple,
    appleKind,
    structures,
    raw: payload,
  };
}

// ---- helpers ---------------------------------------------------------------------------------------

function byte(b: number): string {
  return b.toString(16).padStart(2, "0");
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += byte(b);
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Decode advertisement name bytes as UTF-8, trimming trailing NULs; null if empty/undecodable. */
function decodeUtf8(bytes: Uint8Array): string | null {
  if (bytes.length === 0) return null;
  try {
    const s = new TextDecoder("utf-8", { fatal: false }).decode(bytes).replace(/\u0000+$/, "");
    return s.length ? s : null;
  } catch {
    return null;
  }
}

/** 16-bit service UUIDs: little-endian pairs → "0xNNNN". */
function uuids16(data: Uint8Array): string[] {
  const out: string[] = [];
  for (let i = 0; i + 2 <= data.length; i += 2) {
    out.push(`0x${byte(data[i + 1])}${byte(data[i])}`);
  }
  return out;
}

/** 32-bit service UUIDs: little-endian quads → "0xNNNNNNNN". */
function uuids32(data: Uint8Array): string[] {
  const out: string[] = [];
  for (let i = 0; i + 4 <= data.length; i += 4) {
    out.push(`0x${byte(data[i + 3])}${byte(data[i + 2])}${byte(data[i + 1])}${byte(data[i])}`);
  }
  return out;
}

/** 128-bit service UUIDs: little-endian 16-byte blocks → canonical "8-4-4-4-12" UUID strings. */
function uuids128(data: Uint8Array): string[] {
  const out: string[] = [];
  for (let i = 0; i + 16 <= data.length; i += 16) {
    const be: string[] = [];
    for (let j = 15; j >= 0; j--) be.push(byte(data[i + j])); // reverse to big-endian
    const h = be.join("");
    out.push(`${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`);
  }
  return out;
}
