import {
  Radar,
  FileDown,
  Zap,
  Bluetooth,
  Network,
  Cpu,
  type LucideIcon,
} from "lucide-react";

/** Category id -> icon, so tools.ts stays data-only (no JSX imports). */
export const CATEGORY_ICONS: Record<string, LucideIcon> = {
  Radar,
  FileDown,
  Zap,
  Bluetooth,
  Network,
  Cpu,
};
