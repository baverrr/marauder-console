import { useCallback, useEffect, useMemo, useState } from "react";
import { MapPin, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { getWardrive, listCaptures, type WardriveData, type WardrivePoint } from "@/lib/captures";
import { cn } from "@/lib/utils";

// SVG plot geometry.
const W = 760;
const H = 460;
const PAD = 28;

/** Colour a point by signal strength: stronger (closer to 0 dBm) is warmer. */
function rssiColor(rssi: number | null): string {
  if (rssi == null) return "hsl(220 10% 60%)";
  const t = Math.max(0, Math.min(1, (rssi + 90) / 60)); // -90 dBm → 0, -30 dBm → 1
  const hue = 160 - t * 160; // 160 (teal, weak) → 0 (red, strong)
  return `hsl(${hue.toFixed(0)} 70% 55%)`;
}

export function WardriveMapView() {
  const [csvs, setCsvs] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [data, setData] = useState<WardriveData | null>(null);
  const [hover, setHover] = useState<WardrivePoint | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const all = await listCaptures();
      setCsvs(all.filter((c) => c.name.toLowerCase().endsWith(".csv")).map((c) => c.name));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const open = async (name: string) => {
    setSelected(name);
    setData(null);
    setHover(null);
    setError(null);
    try {
      setData(await getWardrive(name));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // Project located points into the SVG box, preserving aspect ratio (longitude scaled by cos(lat)).
  const projected = useMemo(() => {
    if (!data || !data.bounds || data.points.length === 0) return [];
    const { min_lat, max_lat, min_lon, max_lon } = data.bounds;
    const midLat = (min_lat + max_lat) / 2;
    const cos = Math.max(0.01, Math.cos((midLat * Math.PI) / 180));
    const spanLat = Math.max(1e-6, max_lat - min_lat);
    const spanLon = Math.max(1e-6, (max_lon - min_lon) * cos);
    const scale = Math.min((W - 2 * PAD) / spanLon, (H - 2 * PAD) / spanLat);
    // Centre the plot: offset by half the leftover space on the axis that isn't the limiting one (and for
    // a zero-span / single-point file this puts the marker in the middle instead of the bottom-left).
    const offX = (W - 2 * PAD - spanLon * scale) / 2;
    const offY = (H - 2 * PAD - spanLat * scale) / 2;
    return data.points.map((p) => ({
      p,
      x: PAD + offX + (p.lon - min_lon) * cos * scale,
      y: H - PAD - offY - (p.lat - min_lat) * scale, // north up
    }));
  }, [data]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
            <MapPin className="size-5 text-primary" /> Wardrive map
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Plots the located access points from a Wigle wardrive CSV. Offline and self-contained — points
            are drawn from the file's own coordinates; no map tiles are fetched, so your route is never sent
            anywhere. Rows without a GPS fix are skipped.
          </p>
        </div>
        <Button size="sm" variant="secondary" onClick={() => void refresh()}>
          <RefreshCw /> Refresh
        </Button>
      </div>

      {error && (
        <div className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 p-2.5 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[280px_1fr]">
        <div className="min-h-0 overflow-auto rounded-lg border border-border bg-card/40 p-2">
          {loading ? (
            <p className="p-2 text-sm text-muted-foreground">Loading…</p>
          ) : csvs.length === 0 ? (
            <p className="p-2 text-sm text-muted-foreground">
              No CSV files in the captures folder. Copy a wardrive <code>.csv</code> there and Refresh.
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {csvs.map((name) => (
                <li key={name}>
                  <button
                    onClick={() => void open(name)}
                    className={cn(
                      "w-full truncate rounded-md px-2.5 py-2 text-left text-sm transition-colors",
                      selected === name ? "bg-primary/15 text-primary" : "hover:bg-secondary/60",
                    )}
                  >
                    {name}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex min-h-0 flex-col overflow-auto rounded-lg border border-border bg-card/60 p-4">
          {!selected ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              Select a wardrive CSV to plot it.
            </div>
          ) : !data ? (
            <p className="text-sm text-muted-foreground">Reading {selected}…</p>
          ) : data.count === 0 ? (
            <p className="text-sm text-muted-foreground">
              No located points in this file — every row is missing a GPS fix.
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              <p className="text-xs text-muted-foreground">
                {data.count.toLocaleString()} located points{data.truncated ? " (truncated)" : ""}
                {data.bounds &&
                  ` · lat ${data.bounds.min_lat.toFixed(5)}–${data.bounds.max_lat.toFixed(5)}, lon ${data.bounds.min_lon.toFixed(5)}–${data.bounds.max_lon.toFixed(5)}`}
              </p>
              <svg
                viewBox={`0 0 ${W} ${H}`}
                className="w-full rounded-md border border-border bg-background/40"
                role="img"
                aria-label="Wardrive point plot"
              >
                <rect x={0.5} y={0.5} width={W - 1} height={H - 1} fill="none" stroke="hsl(220 10% 30%)" />
                {projected.map(({ p, x, y }, i) => (
                  <circle
                    key={i}
                    cx={x}
                    cy={y}
                    r={hover === p ? 6 : 4}
                    fill={rssiColor(p.rssi)}
                    fillOpacity={0.85}
                    stroke="black"
                    strokeOpacity={0.3}
                    onMouseEnter={() => setHover(p)}
                    onMouseLeave={() => setHover((h) => (h === p ? null : h))}
                  />
                ))}
              </svg>

              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <span>Signal:</span>
                <span className="flex items-center gap-1">
                  <span className="inline-block size-3 rounded-full" style={{ background: rssiColor(-85) }} /> weak
                </span>
                <span className="flex items-center gap-1">
                  <span className="inline-block size-3 rounded-full" style={{ background: rssiColor(-35) }} /> strong
                </span>
              </div>

              {hover && (
                <div className="rounded-md border border-border bg-background/60 p-2.5 text-sm">
                  <div className="font-medium">{hover.ssid || "(hidden SSID)"}</div>
                  <div className="mt-0.5 font-mono text-xs text-muted-foreground">{hover.mac}</div>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    <Badge variant="outline">ch {hover.channel || "?"}</Badge>
                    <Badge variant="outline">{hover.rssi != null ? `${hover.rssi} dBm` : "RSSI ?"}</Badge>
                    <Badge variant="outline" className="font-mono">
                      {hover.lat.toFixed(5)}, {hover.lon.toFixed(5)}
                    </Badge>
                    {hover.auth && <Badge variant="outline">{hover.auth}</Badge>}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
