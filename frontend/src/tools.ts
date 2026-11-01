/**
 * The Marauder tool map.
 *
 * This single file is the source of truth for BOTH layers of the app:
 *   - the Reference view renders every entry as annotated documentation, and
 *   - the Control panel turns each entry into a Run control that sends `syntax` (plus any argument
 *     values) to the board over the bridge.
 *
 * Summaries and how-to text are deliberately HIGH LEVEL: what a command is for and how to invoke it,
 * not step-by-step targeting, attack or evasion playbooks. Syntax follows ESP32 Marauder v1.20.0's
 * serial command line; a few commands accept more flags than are shown here — use the device's own
 * `help` output as the final word.
 */

export type ToolClass = "passive" | "active";
export type Hardware = "sd" | "gps";

export interface ToolArg {
  /** Short key used for the input's label. */
  name: string;
  /** The flag this value follows on the command line, e.g. "-c" or "-t". Omit for a bare positional. */
  flag?: string;
  placeholder: string;
  description: string;
  optional?: boolean;
  /** Prefilled value in the control panel. Omit to start empty (the user must fill a required arg). */
  default?: string;
}

export interface Tool {
  id: string;
  category: CategoryId;
  name: string;
  /** The exact command as typed on the serial console (example form, shown in the reference). */
  syntax: string;
  /** Fixed command prefix the control panel builds on, if it differs from the first word of `syntax`. */
  base?: string;
  /** One or two sentences: what it is for. */
  summary: string;
  /** How to invoke it at a high level. */
  howToUse: string;
  args: ToolArg[];
  /** True when the command runs until stopped. */
  streaming: boolean;
  /** The command that stops it (always "stopscan" for streaming tools). */
  stopWith?: string;
  /** "active" tools transmit and are gated behind an authorization acknowledgement. */
  class: ToolClass;
  /** Optional hardware this command needs to be useful (drives the "Requires" badges). */
  requires?: Hardware[];
}

export type CategoryId =
  | "wifi-recon"
  | "wifi-capture"
  | "wifi-active"
  | "bluetooth"
  | "network"
  | "device";

export interface Category {
  id: CategoryId;
  name: string;
  blurb: string;
  /** Lucide icon name used by the nav. */
  icon: string;
}

export const CATEGORIES: Category[] = [
  {
    id: "wifi-recon",
    name: "Wi-Fi Recon",
    blurb: "Passive discovery of access points, stations and probe traffic on 2.4 GHz.",
    icon: "Radar",
  },
  {
    id: "wifi-capture",
    name: "Wi-Fi Capture",
    blurb: "Record raw frames and handshake material to the SD card for offline analysis.",
    icon: "FileDown",
  },
  {
    id: "wifi-active",
    name: "Wi-Fi Active",
    blurb: "Commands that transmit. Use only against networks you own or are authorised to test.",
    icon: "Zap",
  },
  {
    id: "bluetooth",
    name: "Bluetooth / BLE",
    blurb: "Scan and interact with Bluetooth Low Energy devices around you.",
    icon: "Bluetooth",
  },
  {
    id: "network",
    name: "Network Probes",
    blurb: "Once joined to a Wi-Fi network, map hosts and ports on that LAN.",
    icon: "Network",
  },
  {
    id: "device",
    name: "Device & System",
    blurb: "Board info, joining a network, display, GPS tools and the universal stop.",
    icon: "Cpu",
  },
];

export const HARDWARE_LABELS: Record<Hardware, { label: string; hint: string }> = {
  sd: {
    label: "SD card",
    hint: "Writes capture or log files to the microSD card; without a card the command runs but saves nothing.",
  },
  gps: {
    label: "GPS",
    hint: "Needs a UART GPS module with a fix to record coordinates; without one, location fields stay empty.",
  },
};

const STOP = "stopscan";

export const TOOLS: Tool[] = [
  // ---- Wi-Fi recon -------------------------------------------------------------------------------
  {
    id: "scanall",
    category: "wifi-recon",
    name: "Scan All",
    syntax: "scanall",
    summary: "Discovers nearby access points and the stations talking to them in one pass.",
    howToUse:
      "Run it to build the live AP/station list, then use list and select to pick targets for other tools. Runs until stopped.",
    args: [],
    streaming: true,
    stopWith: STOP,
    class: "passive",
  },
  {
    id: "sniffbeacon",
    category: "wifi-recon",
    name: "Sniff Beacons",
    syntax: "sniffbeacon",
    summary: "Listens for 802.11 beacon frames, the periodic broadcasts access points use to advertise themselves.",
    howToUse: "Start it to watch which networks are broadcasting nearby. Runs until stopped.",
    args: [],
    streaming: true,
    stopWith: STOP,
    class: "passive",
  },
  {
    id: "sniffprobe",
    category: "wifi-recon",
    name: "Sniff Probes",
    syntax: "sniffprobe",
    summary: "Captures probe requests, the frames client devices send looking for known networks.",
    howToUse: "Start it to see which networks nearby devices are searching for. Runs until stopped.",
    args: [],
    streaming: true,
    stopWith: STOP,
    class: "passive",
  },
  {
    id: "sniffmultissid",
    category: "wifi-recon",
    name: "Sniff Multi-SSID",
    syntax: "sniffmultissid",
    summary: "Flags access points advertising several SSIDs from one radio, a pattern worth noticing during a survey.",
    howToUse: "Start it while surveying an area to highlight multi-SSID access points. Runs until stopped.",
    args: [],
    streaming: true,
    stopWith: STOP,
    class: "passive",
  },
  {
    id: "sniffpinescan",
    category: "wifi-recon",
    name: "Pine Scan",
    syntax: "sniffpinescan",
    summary: "Watches for beacon patterns characteristic of rogue multi-SSID 'pineapple'-style access points.",
    howToUse: "Start it to help spot suspicious access points in a Wi-Fi survey. Runs until stopped.",
    args: [],
    streaming: true,
    stopWith: STOP,
    class: "passive",
  },
  {
    id: "list",
    category: "wifi-recon",
    name: "List",
    syntax: "list -a",
    summary: "Prints the current list of discovered access points, stations or SSIDs with their index numbers.",
    howToUse: "Use -a for access points, -s for stations, -c for SSIDs. The index numbers feed the select command.",
    args: [
      {
        name: "type",
        placeholder: "-a",
        description: "-a access points, -s stations, -c SSIDs.",
        optional: true,
        default: "-a",
      },
    ],
    streaming: false,
    class: "passive",
  },
  {
    id: "select",
    category: "wifi-recon",
    name: "Select",
    syntax: "select -a",
    summary: "Marks items from the discovered list so later commands act only on your chosen targets.",
    howToUse:
      "Give the list type (-a/-s) and an index, a range, or -a for all, e.g. 'select -a 3'. Run list first to see indexes.",
    args: [
      { name: "type", placeholder: "-a", description: "Which list: -a access points, -s stations.", default: "-a" },
      { name: "index", placeholder: "0 or 0-4 or all", description: "Index, range, or all.", optional: true },
    ],
    streaming: false,
    class: "passive",
  },
  {
    id: "ssid",
    category: "wifi-recon",
    name: "SSID List",
    syntax: "ssid -a -n Placeholder",
    summary: "Builds a local list of SSID names used by SSID-list tools; add generated names or your own.",
    howToUse: "Add with -a plus -g <count> for random names or -n <name> for one; remove with -r <index>.",
    args: [
      { name: "op", placeholder: "-a", description: "-a add, -r remove.", default: "-a" },
      {
        name: "value",
        placeholder: "-n Name or -g 5",
        description: "-n <name>, or -g <count> random.",
        optional: true,
        default: "-g 5",
      },
    ],
    streaming: false,
    class: "passive",
  },
  {
    id: "save",
    category: "wifi-recon",
    name: "Save Lists",
    syntax: "save -a",
    summary: "Writes the current AP, station or SSID list to the SD card so it survives a reboot.",
    howToUse: "Pass the list type to save, e.g. 'save -a' for access points. Needs an SD card.",
    args: [{ name: "type", placeholder: "-a", description: "-a access points, -s stations, -c SSIDs.", default: "-a" }],
    streaming: false,
    class: "passive",
    requires: ["sd"],
  },
  {
    id: "load",
    category: "wifi-recon",
    name: "Load Lists",
    syntax: "load -a",
    summary: "Reads a previously saved AP, station or SSID list back from the SD card.",
    howToUse: "Pass the list type to load, e.g. 'load -a'. Needs an SD card with a saved list.",
    args: [{ name: "type", placeholder: "-a", description: "-a access points, -s stations, -c SSIDs.", default: "-a" }],
    streaming: false,
    class: "passive",
    requires: ["sd"],
  },
  {
    id: "wardrive",
    category: "wifi-recon",
    name: "Wardrive",
    syntax: "wardrive",
    summary: "Logs every access point it hears together with its GPS location, in Wigle CSV format, while you move.",
    howToUse: "With a GPS fix and an SD card, start it and move through an area; stop to finish the log. Runs until stopped.",
    args: [],
    streaming: true,
    stopWith: STOP,
    class: "passive",
    requires: ["gps", "sd"],
  },
  {
    id: "wardrivepoi",
    category: "wifi-recon",
    name: "Wardrive POI",
    syntax: "wardrivepoi",
    summary: "Like wardrive, but logs stations/points of interest with location rather than access points.",
    howToUse: "With GPS and SD, start it to log points of interest as you move. Runs until stopped.",
    args: [],
    streaming: true,
    stopWith: STOP,
    class: "passive",
    requires: ["gps", "sd"],
  },

  // ---- Wi-Fi capture -----------------------------------------------------------------------------
  {
    id: "sniffraw",
    category: "wifi-capture",
    name: "Sniff Raw",
    syntax: "sniffraw",
    summary: "Captures raw 802.11 frames to a PCAP file on the SD card for later analysis in tools like Wireshark.",
    howToUse: "With an SD card inserted, start it to record frames; stop to close the file. Runs until stopped.",
    args: [],
    streaming: true,
    stopWith: STOP,
    class: "passive",
    requires: ["sd"],
  },
  {
    id: "sniffpmkid",
    category: "wifi-capture",
    name: "Sniff PMKID",
    syntax: "sniffpmkid",
    summary: "Watches for the PMKID material exchanged during WPA association and writes matching frames to PCAP.",
    howToUse:
      "With an SD card, start it to record relevant handshake frames on the selected channel. Runs until stopped.",
    args: [
      { name: "channel", flag: "-c", placeholder: "6", description: "Lock to one channel.", optional: true },
    ],
    streaming: true,
    stopWith: STOP,
    class: "passive",
    requires: ["sd"],
  },
  {
    id: "sniffsae",
    category: "wifi-capture",
    name: "Sniff SAE",
    syntax: "sniffsae",
    summary: "Captures WPA3 SAE authentication frames to PCAP on the SD card.",
    howToUse: "With an SD card, start it to record SAE frames for offline study. Runs until stopped.",
    args: [],
    streaming: true,
    stopWith: STOP,
    class: "passive",
    requires: ["sd"],
  },
  {
    id: "sniffpwn",
    category: "wifi-capture",
    name: "Sniff Pwnagotchi",
    syntax: "sniffpwn",
    summary: "Listens for Pwnagotchi beacon advertisements and logs them to the SD card.",
    howToUse: "With an SD card, start it to detect and log nearby Pwnagotchi units. Runs until stopped.",
    args: [],
    streaming: true,
    stopWith: STOP,
    class: "passive",
    requires: ["sd"],
  },

  // ---- Wi-Fi active (transmit) -------------------------------------------------------------------
  {
    id: "sniffdeauth",
    category: "wifi-active",
    name: "Sniff Deauth",
    syntax: "sniffdeauth",
    summary: "Monitors the air for deauthentication frames, which can indicate disruptive activity nearby.",
    howToUse:
      "Start it to watch for deauth frames during a survey. Listening is passive; it lives here because it pairs with deauth tooling. Runs until stopped.",
    args: [],
    streaming: true,
    stopWith: STOP,
    class: "active",
  },
  {
    id: "attack-deauth",
    category: "wifi-active",
    name: "Deauth Attack",
    syntax: "attack -t deauth",
    summary: "Transmits deauthentication frames against the selected access points or stations. Disruptive and regulated.",
    howToUse:
      "Select targets first (scanall, then select). Only run against networks you own or are explicitly authorised to test. Runs until stopped.",
    args: [],
    streaming: true,
    stopWith: STOP,
    class: "active",
  },
  {
    id: "attack-beacon",
    category: "wifi-active",
    name: "Beacon Spam",
    syntax: "attack -t beacon -l",
    base: "attack -t beacon",
    summary: "Broadcasts crafted beacon frames so fake network names appear in nearby device Wi-Fi lists.",
    howToUse:
      "Build an SSID list first (ssid), then choose a mode: -l list, -r random, -a AP-clone. Use only in an authorised test. Runs until stopped.",
    args: [
      { name: "mode", placeholder: "-l", description: "-l from SSID list, -r random, -a clone APs.", default: "-l" },
    ],
    streaming: true,
    stopWith: STOP,
    class: "active",
  },
  {
    id: "attack-probe",
    category: "wifi-active",
    name: "Probe Flood",
    syntax: "attack -t probe",
    summary: "Transmits probe-request frames using the SSID list. A transmitting command, regulated like the others.",
    howToUse: "Build an SSID list first, then run it only in an authorised test. Runs until stopped.",
    args: [],
    streaming: true,
    stopWith: STOP,
    class: "active",
  },
  {
    id: "spoofat",
    category: "wifi-active",
    name: "Spoof AP",
    syntax: "spoofat",
    summary: "Advertises an access point that imitates a selected network. Transmits; strictly for authorised testing.",
    howToUse:
      "Select a target AP first, then run only against infrastructure you own or are authorised to assess. Runs until stopped.",
    args: [],
    streaming: true,
    stopWith: STOP,
    class: "active",
  },

  // ---- Bluetooth / BLE ---------------------------------------------------------------------------
  {
    id: "sniffbt",
    category: "bluetooth",
    name: "Sniff Bluetooth",
    syntax: "sniffbt",
    summary: "Scans for Bluetooth Low Energy devices advertising nearby and lists them as they appear.",
    howToUse: "Start it to enumerate nearby BLE devices. Runs until stopped.",
    args: [],
    streaming: true,
    stopWith: STOP,
    class: "passive",
  },
  {
    id: "blespam",
    category: "bluetooth",
    name: "BLE Spam",
    syntax: "blespam",
    summary: "Broadcasts BLE advertisement packets that trigger pairing-style pop-ups on nearby phones. Transmits.",
    howToUse: "A transmitting command; run only around devices you own or in an authorised test. Runs until stopped.",
    args: [],
    streaming: true,
    stopWith: STOP,
    class: "active",
  },
  {
    id: "findmy",
    category: "bluetooth",
    name: "Find My",
    syntax: "findmy",
    summary: "Listens for Apple Find My / offline-finding BLE advertisements from trackers and devices nearby.",
    howToUse: "Start it to see Find My advertisements in range. Runs until stopped.",
    args: [],
    streaming: true,
    stopWith: STOP,
    class: "passive",
  },
  {
    id: "remoteid",
    category: "bluetooth",
    name: "Drone Remote ID",
    syntax: "remoteid",
    summary: "Detects drone Remote ID broadcasts (the identification signal many drones transmit) over BLE/Wi-Fi.",
    howToUse: "Start it to list nearby drones broadcasting Remote ID. Runs until stopped.",
    args: [],
    streaming: true,
    stopWith: STOP,
    class: "passive",
  },
  {
    id: "sniffskim",
    category: "bluetooth",
    name: "Skimmer Scan",
    syntax: "sniffskim",
    summary: "Looks for BLE signatures associated with known card-skimmer modules, e.g. at fuel pumps.",
    howToUse: "Start it near the area you want to check; it flags matching BLE devices. Runs until stopped.",
    args: [],
    streaming: true,
    stopWith: STOP,
    class: "passive",
  },

  // ---- Network probes ----------------------------------------------------------------------------
  {
    id: "pingscan",
    category: "network",
    name: "Ping Scan",
    syntax: "pingscan",
    summary: "Pings across the joined LAN to find which hosts are responding. Requires an active join first.",
    howToUse: "Run join to connect to a network, then start pingscan to discover live hosts. Runs until stopped.",
    args: [],
    streaming: true,
    stopWith: STOP,
    class: "active",
  },
  {
    id: "arpscan",
    category: "network",
    name: "ARP Scan",
    syntax: "arpscan",
    summary: "Uses ARP to enumerate devices on the joined LAN. Requires an active join first.",
    howToUse: "Join a network first, then start arpscan to map the local subnet. Runs until stopped.",
    args: [],
    streaming: true,
    stopWith: STOP,
    class: "active",
  },
  {
    id: "portscan",
    category: "network",
    name: "Port Scan",
    syntax: "portscan",
    summary: "Checks for open TCP ports on hosts of the joined LAN. Requires an active join first.",
    howToUse:
      "Join a network and identify a host, then run portscan. Only scan hosts you own or are authorised to test. Runs until stopped.",
    args: [],
    streaming: true,
    stopWith: STOP,
    class: "active",
  },

  // ---- Device & system ---------------------------------------------------------------------------
  {
    id: "info",
    category: "device",
    name: "Device Info",
    syntax: "info",
    summary: "Prints firmware version, hardware details and SD-card status. Safe to run any time.",
    howToUse: "Run it to confirm the firmware version and whether an SD card is detected.",
    args: [],
    streaming: false,
    class: "passive",
  },
  {
    id: "join",
    category: "device",
    name: "Join Network",
    syntax: "join Placeholder-SSID password",
    summary: "Connects the board to a Wi-Fi network so the network-probe tools can run on that LAN.",
    howToUse: "Give the SSID and password. After it joins (and reports an IP), use pingscan/arpscan/portscan.",
    args: [
      { name: "ssid", placeholder: "Placeholder-SSID", description: "Network name to join." },
      { name: "password", placeholder: "password", description: "Network password.", optional: true },
    ],
    streaming: false,
    class: "active",
  },
  {
    id: "upload",
    category: "device",
    name: "Upload / Export",
    syntax: "upload",
    summary: "Transfers logged data off the board. Needs an SD card holding the files to move.",
    howToUse: "With an SD card of saved captures/logs, run upload to export them. Behaviour depends on the build.",
    args: [],
    streaming: false,
    class: "passive",
    requires: ["sd"],
  },
  {
    id: "brightness",
    category: "device",
    name: "Brightness",
    syntax: "brightness 255",
    summary: "Sets the display backlight brightness, from 0 (off) to 255 (full).",
    howToUse: "Pass a value 0–255, e.g. 'brightness 180'.",
    args: [{ name: "level", placeholder: "255", description: "0–255.", default: "255" }],
    streaming: false,
    class: "passive",
  },
  {
    id: "csimotion",
    category: "device",
    name: "CSI Motion",
    syntax: "csimotion",
    summary: "Uses Wi-Fi Channel State Information to sense motion in the environment. Experimental.",
    howToUse: "Start it to watch the CSI motion signal; results vary by placement. Runs until stopped.",
    args: [],
    streaming: true,
    stopWith: STOP,
    class: "passive",
  },
  {
    id: "foxhunt",
    category: "device",
    name: "Fox Hunt",
    syntax: "foxhunt",
    summary: "Helps locate a chosen transmitter by signal strength, optionally logging position with GPS.",
    howToUse: "Select a target, then move around watching the signal strength to home in on it. Runs until stopped.",
    args: [],
    streaming: true,
    stopWith: STOP,
    class: "passive",
    requires: ["gps"],
  },
  {
    id: "stopscan",
    category: "device",
    name: "Stop",
    syntax: "stopscan",
    summary: "Stops whatever scan, sniff or attack is currently running. The universal brake.",
    howToUse: "Run it at any time to end the active streaming command. The console's Stop button sends this.",
    args: [],
    streaming: false,
    class: "passive",
  },
];

export const TOOLS_BY_CATEGORY: Record<CategoryId, Tool[]> = CATEGORIES.reduce(
  (acc, c) => {
    acc[c.id] = TOOLS.filter((t) => t.category === c.id);
    return acc;
  },
  {} as Record<CategoryId, Tool[]>,
);
