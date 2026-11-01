import type { Tool, ToolArg } from "@/tools";

/** The fixed command prefix for a tool: its explicit `base`, else the first word of its syntax. */
export function commandBase(tool: Tool): string {
  return tool.base ?? tool.syntax.split(/\s+/)[0];
}

/** Starting values for a tool's arg inputs (its declared defaults, or empty). */
export function initialArgs(tool: Tool): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of tool.args) out[a.name] = a.default ?? "";
  return out;
}

function renderArg(arg: ToolArg, value: string): string {
  const v = value.trim();
  if (!v) return "";
  return arg.flag ? `${arg.flag} ${v}` : v;
}

/** Assemble the serial command from the base and the current arg values. */
export function buildCommand(tool: Tool, values: Record<string, string>): string {
  // A command with no args is sent verbatim: its explicit base, else its full syntax. Using only the
  // first word here would drop fixed flags like the "-t deauth" in "attack -t deauth".
  if (tool.args.length === 0) return tool.base ?? tool.syntax;
  const parts = [commandBase(tool)];
  for (const a of tool.args) {
    const rendered = renderArg(a, values[a.name] ?? "");
    if (rendered) parts.push(rendered);
  }
  return parts.join(" ");
}
