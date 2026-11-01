import { HardDrive, Satellite } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { HARDWARE_LABELS, type Hardware } from "@/tools";

const ICONS = { sd: HardDrive, gps: Satellite } as const;

/** A "Requires: SD card / GPS" hint. Informational only — it never disables a tool's Run control. */
export function HardwareBadge({ hw }: { hw: Hardware }) {
  const Icon = ICONS[hw];
  const { label, hint } = HARDWARE_LABELS[hw];
  return (
    <Badge variant="outline" title={hint} className="cursor-help">
      <Icon className="size-3" />
      {label}
    </Badge>
  );
}
