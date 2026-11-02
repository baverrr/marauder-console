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
  {
    id: "packetcount",
    category: "wifi-recon",
    name: "Packet Count",
    syntax: "packetcount",
    summary: "Shows a live count of 802.11 packets seen per channel, a quick read on where the air is busy.",
    howToUse: "Start it to watch per-channel packet rates while surveying. Runs until stopped.",
    args: [],
    streaming: true,
    stopWith: STOP,
    class: "passive",
  },
  {
    id: "mactrack",
    category: "wifi-recon",
    name: "MAC Track",
    syntax: "mactrack",
    summary: "Tracks the signal strength of the selected access points or stations so you can tell when they are near.",
    howToUse: "Select targets first (scanall, then select), then start it to follow their RSSI. Runs until stopped.",
    args: [],
    streaming: true,
    stopWith: STOP,
    class: "passive",
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
    id: "attack-rickroll",
    category: "wifi-active",
    name: "Rickroll Beacon",
    syntax: "attack -t rickroll",
    summary: "Broadcasts a fixed set of novelty beacon SSIDs (the lyric list) so they show up in nearby Wi-Fi menus. Transmits.",
    howToUse: "A joke variant of beacon spam; no SSID list needed. Run only in an authorised test. Runs until stopped.",
    args: [],
    streaming: true,
    stopWith: STOP,
    class: "active",
  },
  {
    id: "attack-sae",
    category: "wifi-active",
    name: "SAE Flood",
    syntax: "attack -t sae",
    summary: "Sends a stream of WPA3 SAE commit frames at the selected access points. Transmits; regulated and disruptive.",
    howToUse: "Select targets first (scanall, then select). Only against networks you own or are authorised to test. Runs until stopped.",
    args: [],
    streaming: true,
    stopWith: STOP,
    class: "active",
  },
  {
    id: "attack-csa",
    category: "wifi-active",
    name: "Channel Switch",
    syntax: "attack -t csa",
    summary: "Transmits 802.11 Channel Switch Announcement frames that tell clients of the selected AP to change channel. Transmits.",
    howToUse: "Select a target AP first. Only against infrastructure you own or are authorised to assess. Runs until stopped.",
    args: [],
    streaming: true,
    stopWith: STOP,
    class: "active",
  },
  {
    id: "evilportal",
    category: "wifi-active",
    name: "Evil Portal",
    syntax: "evilportal -c start",
    summary: "Hosts an access point with a captive-portal page that imitates a login screen. Transmits; strictly for authorised testing.",
    howToUse:
      "Starts the portal with the built-in page (or a custom page from the SD card). Run only in an authorised engagement. Runs until stopped.",
    args: [],
    streaming: true,
    stopWith: STOP,
    class: "active",
  },
  {
    id: "karma",
    category: "wifi-active",
    name: "Karma",
    syntax: "karma -p 0",
    base: "karma",
    summary: "Answers client probe requests for a chosen SSID so devices looking for that network try to associate. Transmits.",
    howToUse: "List probed SSIDs, pick one with -p <index>, and run only in an authorised test. Runs until stopped.",
    args: [{ name: "index", flag: "-p", placeholder: "0", description: "Index from the probe-request list." }],
    streaming: true,
    stopWith: STOP,
    class: "active",
  },

  // ---- Bluetooth / BLE ---------------------------------------------------------------------------
  {
    id: "sniffbt",
    category: "bluetooth",
    name: "Sniff Bluetooth",
    syntax: "sniffbt -t airtag",
    base: "sniffbt",
    summary: "Scans for Bluetooth Low Energy devices advertising nearby and lists them as they appear.",
    howToUse:
      "Start it to enumerate nearby BLE devices, or narrow it with -t to one kind (airtag, ibeacon, flipper, flock, meta). Runs until stopped.",
    args: [
      {
        name: "type",
        flag: "-t",
        placeholder: "airtag",
        description: "Optional filter: airtag, ibeacon, flipper, flock, meta.",
        optional: true,
      },
    ],
    streaming: true,
    stopWith: STOP,
    class: "passive",
  },
  {
    id: "blespam",
    category: "bluetooth",
    name: "BLE Spam",
    syntax: "blespam -t all",
    base: "blespam",
    summary: "Broadcasts BLE advertisement packets that trigger pairing-style pop-ups on nearby phones. Transmits.",
    howToUse:
      "Pick a flavour with -t (sourapple, applejuice, google, samsung, windows, flipper, all). Run only around devices you own or in an authorised test. Runs until stopped.",
    args: [
      {
        name: "type",
        flag: "-t",
        placeholder: "all",
        description: "sourapple, applejuice, google, samsung, windows, flipper, all.",
        default: "all",
      },
    ],
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
  {
    id: "spoofat",
    category: "bluetooth",
    name: "Spoof BLE Device",
    syntax: "spoofat -t 0",
    base: "spoofat",
    summary: "Advertises a BLE device that imitates one picked from the scan list (e.g. an AirTag). Transmits; strictly for authorised testing.",
    howToUse:
      "Sniff Bluetooth first to populate the list, then give the device index with -t. Run only against devices you own or are authorised to assess. Runs until stopped.",
    args: [{ name: "index", flag: "-t", placeholder: "0", description: "Device index from the BLE scan list." }],
    streaming: true,
    stopWith: STOP,
    class: "active",
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
    howToUse: "Join a network first, then start arpscan to map the local subnet; add -f to also note the gateway. Runs until stopped.",
    args: [{ name: "options", placeholder: "-f", description: "Optional flags, e.g. -f.", optional: true }],
    streaming: true,
    stopWith: STOP,
    class: "active",
  },
  {
    id: "portscan",
    category: "network",
    name: "Port Scan",
    syntax: "portscan -a -t 0",
    base: "portscan",
    summary: "Checks for open TCP ports on hosts of the joined LAN. Requires an active join first.",
    howToUse:
      "Join a network first. Target all hosts with '-a -t <ip index>', or probe one service with '-s <ssh/telnet/dns/http/smtp/https/rdp>'. Only scan hosts you own or are authorised to test. Runs until stopped.",
    args: [
      {
        name: "options",
        placeholder: "-a -t 0",
        description: "Target selector, e.g. '-a -t 0' or '-s http'.",
        optional: true,
        default: "-a -t 0",
      },
    ],
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
    id: "lensfind",
    category: "device",
    name: "Lens Finder",
    syntax: "lensfind -r 4",
    base: "lensfind",
    summary:
      "Strobes the board's rear RGB LED so you can spot hidden camera lenses by the bright glint they reflect straight back. Needs the custom lens-finder firmware (firmware/custom-lensfinder); also on the touchscreen under Device.",
    howToUse:
      "In a dark room, hold the board screen-up just below your eye with the rear LED facing the room, look over its top edge and sweep slowly. A lens shows as a tiny, sharp glint that blinks with the LED and stays put as you move. Add -s for a steady light or -w for white. The screen goes dark after 5 s; stop with Stop, 'lensfind stop' or a tap on the screen.",
    args: [
      {
        name: "rate",
        flag: "-r",
        placeholder: "4",
        description: "Strobe rate, 1–20 Hz (default 4). Use -s instead for a steady light, -w for white.",
        optional: true,
        default: "4",
      },
    ],
    streaming: true,
    stopWith: STOP,
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
    id: "help",
    category: "device",
    name: "Help",
    syntax: "help",
    summary: "Prints the board's own list of serial commands — the authoritative set for the installed firmware.",
    howToUse: "Run it to see exactly which commands this firmware build supports; it is the final word over this reference.",
    args: [],
    streaming: false,
    class: "passive",
  },
  {
    id: "channel",
    category: "device",
    name: "Channel",
    syntax: "channel -s 1",
    base: "channel",
    summary: "Shows the current 2.4 GHz Wi-Fi channel, or sets it with -s so scans and transmits stay on one channel.",
    howToUse: "Run 'channel' to read it, or 'channel -s <1-14>' to set it.",
    args: [{ name: "set", flag: "-s", placeholder: "1", description: "Channel 1–14 to switch to.", optional: true }],
    streaming: false,
    class: "passive",
  },
  {
    id: "clearlist",
    category: "device",
    name: "Clear Lists",
    syntax: "clearlist -a",
    base: "clearlist",
    summary: "Empties the in-memory list of discovered access points, stations or SSIDs.",
    howToUse: "Pass -a access points, -s stations, or -c SSIDs to clear that list.",
    args: [{ name: "type", placeholder: "-a", description: "-a access points, -s stations, -c SSIDs.", default: "-a" }],
    streaming: false,
    class: "passive",
  },
  {
    id: "settings",
    category: "device",
    name: "Settings",
    syntax: "settings",
    summary: "Prints the board's configuration settings; with flags it enables, disables or resets individual settings.",
    howToUse: "Run 'settings' to list them. Advanced: 'settings -s <name> enable|disable', or 'settings -r' to reset.",
    args: [],
    streaming: false,
    class: "passive",
  },
  {
    id: "reboot",
    category: "device",
    name: "Reboot",
    syntax: "reboot",
    summary: "Restarts the board. The serial console reconnects once it comes back up.",
    howToUse: "Run it to reboot the device; reconnect afterwards if the link does not resume on its own.",
    args: [],
    streaming: false,
    class: "passive",
  },
  {
    id: "update",
    category: "device",
    name: "Firmware Update",
    syntax: "update -s",
    base: "update",
    summary: "Flashes a firmware update, either from a file on the SD card (-s) or over the air from the web (-w).",
    howToUse: "Use 'update -s' with the update file on the SD card, or 'update -w' for web OTA. The board reboots when done.",
    args: [{ name: "source", placeholder: "-s", description: "-s from SD card, -w over the air.", default: "-s" }],
    streaming: false,
    class: "passive",
    requires: ["sd"],
  },
  {
    id: "ls",
    category: "device",
    name: "List SD Files",
    syntax: "ls /",
    base: "ls",
    summary: "Lists the files and folders in a directory on the SD card.",
    howToUse: "Pass a path, e.g. 'ls /' for the card root, to see captures and logs saved there.",
    args: [{ name: "dir", placeholder: "/", description: "Directory to list.", default: "/" }],
    streaming: false,
    class: "passive",
    requires: ["sd"],
  },
  {
    id: "randapmac",
    category: "device",
    name: "Random AP MAC",
    syntax: "randapmac",
    summary: "Assigns the board's access-point interface a new random MAC address.",
    howToUse: "Run it before an AP-side task to rotate the board's advertised MAC.",
    args: [],
    streaming: false,
    class: "passive",
  },
  {
    id: "randstamac",
    category: "device",
    name: "Random Station MAC",
    syntax: "randstamac",
    summary: "Assigns the board's station (client) interface a new random MAC address.",
    howToUse: "Run it before a client-side task to rotate the board's station MAC.",
    args: [],
    streaming: false,
    class: "passive",
  },
  {
    id: "cloneapmac",
    category: "device",
    name: "Clone AP MAC",
    syntax: "cloneapmac -a 0",
    base: "cloneapmac",
    summary: "Sets the board's AP MAC to match an access point from the scan list.",
    howToUse: "Scan first, then 'cloneapmac -a <index>' to copy that AP's MAC.",
    args: [{ name: "index", flag: "-a", placeholder: "0", description: "AP index from the list.", optional: true }],
    streaming: false,
    class: "passive",
  },
  {
    id: "clonestamac",
    category: "device",
    name: "Clone Station MAC",
    syntax: "clonestamac -s 0",
    base: "clonestamac",
    summary: "Sets the board's station MAC to match a station from the scan list.",
    howToUse: "Scan first, then 'clonestamac -s <index>' to copy that station's MAC.",
    args: [{ name: "index", flag: "-s", placeholder: "0", description: "Station index from the list.", optional: true }],
    streaming: false,
    class: "passive",
  },
  {
    id: "gpsdata",
    category: "device",
    name: "GPS Data",
    syntax: "gpsdata",
    summary: "Streams the parsed GPS state — fix, satellites, position and time — as the module reports it.",
    howToUse: "With a GPS module attached, start it to watch live GPS data. Runs until stopped.",
    args: [],
    streaming: true,
    stopWith: STOP,
    class: "passive",
    requires: ["gps"],
  },
  {
    id: "gps",
    category: "device",
    name: "GPS Query",
    syntax: "gps -t fix",
    base: "gps",
    summary: "Prints one GPS field on demand, such as the current fix, satellite count or coordinates.",
    howToUse: "Ask for a field with -t, e.g. 'gps -t fix', 'gps -t lat', 'gps -t sat'.",
    args: [
      {
        name: "field",
        flag: "-t",
        placeholder: "fix",
        description: "fix, sat, lon, lat, alt, date, accuracy, text, nmea.",
        default: "fix",
      },
    ],
    streaming: false,
    class: "passive",
    requires: ["gps"],
  },
  {
    id: "nmea",
    category: "device",
    name: "NMEA Stream",
    syntax: "nmea",
    summary: "Streams the raw NMEA sentences straight from the GPS module, for logging or debugging the receiver.",
    howToUse: "With a GPS module attached, start it to see raw NMEA output. Runs until stopped.",
    args: [],
    streaming: true,
    stopWith: STOP,
    class: "passive",
    requires: ["gps"],
  },
  {
    id: "gpspoi",
    category: "device",
    name: "GPS Point of Interest",
    syntax: "gpspoi -s",
    base: "gpspoi",
    summary: "Marks the current GPS location as a point of interest on the SD card during a survey.",
    howToUse: "With GPS and SD, use -s to save the current spot, -m to mark, -e to end.",
    args: [{ name: "op", placeholder: "-s", description: "-s save, -m mark, -e end.", default: "-s" }],
    streaming: false,
    class: "passive",
    requires: ["gps", "sd"],
  },
  {
    id: "gpstracker",
    category: "device",
    name: "GPS Tracker",
    syntax: "gpstracker -c start",
    base: "gpstracker",
    summary: "Logs a GPS track to the SD card. Started and stopped with -c rather than the universal stop.",
    howToUse: "With GPS and SD, run 'gpstracker -c start' to begin logging and 'gpstracker -c stop' to finish.",
    args: [{ name: "state", flag: "-c", placeholder: "start", description: "start or stop.", default: "start" }],
    streaming: false,
    class: "passive",
    requires: ["gps", "sd"],
  },
  {
    id: "geofence",
    category: "device",
    name: "Geofence",
    syntax: "geofence list",
    base: "geofence",
    summary: "Manages up to five named geofences the board can use to trigger actions when it enters or leaves an area.",
    howToUse:
      "'geofence list' to show them; 'geofence set <1-5> <lat> <lon> <0.1-1.0 mi> \"<name>\"' to define one; 'geofence clear <1-5>' to remove.",
    args: [{ name: "args", placeholder: "list", description: "list, set …, or clear <1-5>.", default: "list" }],
    streaming: false,
    class: "passive",
    requires: ["gps"],
  },
  {
    id: "recon",
    category: "device",
    name: "Recon Mission",
    syntax: "recon status",
    base: "recon",
    summary: "Runs an automated recon routine that cycles through Wi-Fi or BLE discovery on its own.",
    howToUse: "'recon wifi' or 'recon ble' to start, 'recon status' to check, 'recon stop' to end.",
    args: [{ name: "mode", placeholder: "status", description: "wifi, ble, status, or stop.", default: "status" }],
    streaming: false,
    class: "passive",
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
