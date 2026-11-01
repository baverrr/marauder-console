import { HardDrive, Satellite, BatteryCharging, Antenna, Ban, CheckCircle2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

interface Item {
  icon: typeof HardDrive;
  title: string;
  tag: string;
  body: string;
  unlocks?: string[];
}

const ADDONS: Item[] = [
  {
    icon: HardDrive,
    title: "microSD card",
    tag: "biggest easy win",
    body: "A FAT32-formatted card (32 GB is ideal — 32 GB and under format as FAT32 natively; 64 GB+ default to exFAT, which Marauder won't read). The slot is already on the CYD.",
    unlocks: [
      "PCAP captures (sniffraw, sniffpmkid, sniffsae, sniffpwn) saved for Wireshark",
      "save / load of AP, station and SSID lists",
      "Wigle CSV logs from wardrive / wardrivepoi",
    ],
  },
  {
    icon: Satellite,
    title: "UART GPS module",
    tag: "for wardriving",
    body: "A u-blox NEO-6M / NEO-M8N / BN-220 wired to the exposed GPIO header. Without a fix, wardrive and foxhunt have no coordinates to log.",
    unlocks: ["Location-tagged wardrive / wardrivepoi logs", "foxhunt direction finding with position"],
  },
  {
    icon: BatteryCharging,
    title: "LiPo battery + charger",
    tag: "portability",
    body: "The CYD has no onboard charger, so add a TP4056 + cell or run from a USB power bank. Nothing software-side, but it frees wardrive and foxhunt from the USB cable.",
  },
  {
    icon: Antenna,
    title: "External antenna",
    tag: "marginal here",
    body: "The CYD's WROOM module has a fixed PCB antenna, so you can't easily fit a u.FL/SMA antenna without a different board. Better range, but not a drop-in.",
  },
];

const NOT_SUPPORTED = [
  "5 GHz Wi-Fi — the ESP32 radio is 2.4 GHz only; no accessory changes that.",
  "Sub-GHz / CC1101 and NRF24 — Flipper-Zero territory, not Marauder.",
];

export function HardwarePanel() {
  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Hardware &amp; setup</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          The board is an ESP32-2432S028 &ldquo;Cheap Yellow Display&rdquo; (ESP32-WROOM, 2.4 GHz, resistive
          touch, microSD slot). A couple of add-ons unlock the tools marked{" "}
          <Badge variant="outline" className="align-middle">
            <HardDrive className="size-3" /> SD card
          </Badge>{" "}
          or{" "}
          <Badge variant="outline" className="align-middle">
            <Satellite className="size-3" /> GPS
          </Badge>{" "}
          in the reference.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {ADDONS.map((a) => (
          <Card key={a.title}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <a.icon className="size-4 text-primary" />
                {a.title}
                <Badge variant="primary" className="ml-auto font-normal">
                  {a.tag}
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <p className="text-foreground/85">{a.body}</p>
              {a.unlocks && (
                <ul className="space-y-1">
                  {a.unlocks.map((u) => (
                    <li key={u} className="flex gap-2 text-muted-foreground">
                      <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-primary" />
                      <span>{u}</span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      <Card className="border-destructive/30">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Ban className="size-4 text-destructive" />
            Not supported (don&rsquo;t chase these)
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="space-y-1.5 text-sm">
            {NOT_SUPPORTED.map((n) => (
              <li key={n} className="flex gap-2 text-muted-foreground">
                <Ban className="mt-0.5 size-3.5 shrink-0 text-destructive/70" />
                <span>{n}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
