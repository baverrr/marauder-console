import { useCallback, useEffect, useState } from "react";
import { FolderOpen, RefreshCw, FileText, FileDigit } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  getCaptureSummary,
  listCaptures,
  type CaptureMeta,
  type CaptureSummary,
} from "@/lib/captures";
import { cn } from "@/lib/utils";

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export function CapturesView() {
  const [captures, setCaptures] = useState<CaptureMeta[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [summary, setSummary] = useState<CaptureSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setCaptures(await listCaptures());
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
    setSummary(null);
    setError(null);
    try {
      setSummary(await getCaptureSummary(name));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
            <FolderOpen className="size-5 text-primary" /> Capture library
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            PCAPs, wardrive CSVs and logs copied from the board's SD card into the captures folder.
            Read-only inspection — pick a <code>.pcap</code> for a packet summary, or a CSV/log for a
            preview. No injection, nothing sent.
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

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[320px_1fr]">
        <div className="min-h-0 overflow-auto rounded-lg border border-border bg-card/40 p-2">
          {loading ? (
            <p className="p-2 text-sm text-muted-foreground">Loading…</p>
          ) : captures.length === 0 ? (
            <p className="p-2 text-sm text-muted-foreground">
              No capture files found. Copy <code>.pcap</code>, <code>.csv</code> or <code>.log</code>{" "}
              files from the SD card into the captures folder, then Refresh.
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {captures.map((c) => (
                <li key={c.name}>
                  <button
                    onClick={() => void open(c.name)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-colors",
                      selected === c.name ? "bg-primary/15 text-primary" : "hover:bg-secondary/60",
                    )}
                  >
                    {c.kind === "pcap" ? (
                      <FileDigit className="size-4 shrink-0 text-accent" />
                    ) : (
                      <FileText className="size-4 shrink-0 text-muted-foreground" />
                    )}
                    <span className="flex-1 truncate font-medium">{c.name}</span>
                    <span className="text-xs text-muted-foreground">{fmtSize(c.size)}</span>
                  </button>
                  <div className="px-2.5 pb-1 text-[11px] text-muted-foreground">{fmtTime(c.modified)}</div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="min-h-0 overflow-auto rounded-lg border border-border bg-card/60 p-4">
          {!selected ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              Select a capture to inspect it.
            </div>
          ) : !summary ? (
            <p className="text-sm text-muted-foreground">Reading {selected}…</p>
          ) : summary.kind === "error" ? (
            <p className="text-sm text-destructive">Could not read {summary.name}: {summary.error}</p>
          ) : summary.kind === "pcap" ? (
            <PcapDetail s={summary} />
          ) : (
            <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-foreground/80">
              {summary.preview.join("\n")}
              {summary.truncated ? "\n… (preview truncated)" : ""}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

function PcapDetail({ s }: { s: Extract<CaptureSummary, { kind: "pcap" }> }) {
  const span =
    s.first != null && s.last != null
      ? `${new Date(s.first * 1000).toLocaleString()} → ${new Date(s.last * 1000).toLocaleString()}`
      : "—";
  const ssids = s.ssids ?? []; // defend against a summary missing the arrays rather than throwing in render
  const bssids = s.bssids ?? [];
  return (
    <div className="flex flex-col gap-4 text-sm">
      <div>
        <h3 className="font-mono text-base font-semibold">{s.name}</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          {s.link_type_name} · {s.frames.toLocaleString()} frames · {fmtSize(s.bytes)} · {s.duration}s
          {s.truncated ? " · (summary truncated)" : ""}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">{span}</p>
      </div>

      <NameList title={`SSIDs seen (${ssids.length})`} items={ssids} empty="No SSIDs in this capture." />
      <NameList
        title={`BSSIDs seen (${bssids.length})`}
        items={bssids}
        empty="No BSSIDs in this capture."
        mono
      />
    </div>
  );
}

function NameList({
  title,
  items,
  empty,
  mono,
}: {
  title: string;
  items: string[];
  empty: string;
  mono?: boolean;
}) {
  return (
    <div>
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </p>
      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground">{empty}</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {items.map((v) => (
            <Badge key={v} variant="outline" className={mono ? "font-mono" : undefined}>
              {v}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}
