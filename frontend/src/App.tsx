import { useEffect, useMemo, useState } from "react";
import { AlertCircle } from "lucide-react";
import { TopBar } from "@/components/TopBar";
import { CategoryNav, type View } from "@/components/CategoryNav";
import { ToolCard } from "@/components/ToolCard";
import { SerialConsole } from "@/components/SerialConsole";
import { HardwarePanel } from "@/components/HardwarePanel";
import { useBridge } from "@/lib/bridge";
import { CATEGORIES, TOOLS_BY_CATEGORY, type CategoryId } from "@/tools";

type Selection = CategoryId | "hardware";

export default function App() {
  const bridge = useBridge();
  const [view, setView] = useState<View>("reference");
  const [selected, setSelected] = useState<Selection>("wifi-recon");
  const [authorized, setAuthorized] = useState(false); // per-session ack for active (transmitting) tools
  const [runningToolId, setRunningToolId] = useState<string | null>(null);

  const { status } = bridge;

  // Clear the per-tool running marker when the board reports no scan is active.
  useEffect(() => {
    if (!status.running) setRunningToolId(null);
  }, [status.running]);

  const category = selected !== "hardware" ? CATEGORIES.find((c) => c.id === selected) : undefined;
  const tools = useMemo(
    () => (selected !== "hardware" ? TOOLS_BY_CATEGORY[selected] : []),
    [selected],
  );

  const runTool = (toolId: string, streaming: boolean, command: string) => {
    void bridge.send(command);
    if (streaming) setRunningToolId(toolId);
  };

  const stopAll = () => {
    void bridge.stop();
    setRunningToolId(null);
  };

  return (
    <div className="relative z-10 flex h-screen flex-col">
      <TopBar
        status={status}
        wsOnline={bridge.wsOnline}
        onConnect={(port) => void bridge.connect(port)}
        onDisconnect={() => void bridge.disconnect()}
      />

      <div className="flex min-h-0 flex-1">
        <CategoryNav view={view} onView={setView} active={selected} onSelect={setSelected} />

        <div className="flex min-w-0 flex-1 flex-col">
          <main className="flex-1 overflow-auto p-5">
            {bridge.error && (
              <div className="mb-4 flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2.5 text-sm text-destructive">
                <AlertCircle className="size-4 shrink-0" />
                {bridge.error}
              </div>
            )}

            {selected === "hardware" ? (
              <HardwarePanel />
            ) : (
              <>
                <div className="mb-4">
                  <h2 className="text-xl font-semibold tracking-tight">{category?.name}</h2>
                  <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{category?.blurb}</p>
                </div>
                <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                  {tools.map((tool) => (
                    <ToolCard
                      key={tool.id}
                      tool={tool}
                      mode={view}
                      connected={status.connected}
                      running={status.running && runningToolId === tool.id}
                      boardBusy={status.running}
                      authorized={authorized}
                      onAuthorize={() => setAuthorized(true)}
                      onRun={(command) => runTool(tool.id, tool.streaming, command)}
                      onStop={stopAll}
                    />
                  ))}
                </div>
              </>
            )}
          </main>

          {view === "control" && (
            <div className="h-64 shrink-0">
              <SerialConsole
                lines={bridge.lines}
                running={status.running}
                connected={status.connected}
                onStop={stopAll}
                onClear={bridge.clearLines}
                onSend={(command) => void bridge.send(command)}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
