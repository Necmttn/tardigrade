export interface Wiring {
  readonly machines: readonly string[];
  readonly ports?: readonly { readonly machine: string; readonly name: string; readonly direction: "in" | "out" }[];
  readonly connections: readonly {
    readonly from: string;
    readonly to: string;
    readonly port: string;
    readonly kind?: "projection";
  }[];
}

// mermaid renders explicit input and output ports without evaluating views or effects.
export function mermaid(wiring: Wiring): string {
  const ids = new Map(wiring.machines.map((name, index) => [name, `m${index}`]));
  const label = (value: string) => Array.from(value, (char) => /[a-zA-Z0-9 _-]/.test(char) ? char : `#${char.codePointAt(0)};`).join("");
  const ports = new Map<string, { id: string; machine: string; name: string; direction: "in" | "out" }>();
  const key = (machine: string, direction: string, name: string) => JSON.stringify([machine, direction, name]);
  const port = (machine: string, direction: "in" | "out", name: string) => {
    const k = key(machine, direction, name);
    if (!ports.has(k)) ports.set(k, { id: `p${ports.size}`, machine, name, direction });
    return ports.get(k)!;
  };
  for (const p of wiring.ports ?? []) port(p.machine, p.direction, p.name);
  for (const edge of wiring.connections) {
    if (edge.kind === "projection") continue;
    port(edge.from, "out", edge.port);
    port(edge.to, "in", edge.port);
  }
  const lines = ["flowchart LR", "  classDef input fill:#edf2ff,stroke:#2450ff,color:#1744f5", "  classDef output fill:#eaf7ef,stroke:#398560,color:#24513b", "  classDef state fill:#f3f3ee,stroke:#dddcd4,color:#526073"];
  for (const name of wiring.machines) {
    const id = ids.get(name)!;
    const children = [...ports.values()].filter((p) => p.machine === name);
    lines.push(`  subgraph ${id}_box["${label(name)}"]`, "    direction LR", `    ${id}["state / view"]:::state`);
    for (const p of children) {
      lines.push(`    ${p.id}(["${p.direction.toUpperCase()}: ${label(p.name)}"]):::${p.direction === "in" ? "input" : "output"}`);
      lines.push(p.direction === "in" ? `    ${p.id} --> ${id}` : `    ${id} --> ${p.id}`);
    }
    lines.push("  end");
  }
  for (const edge of wiring.connections) {
    lines.push(edge.kind === "projection"
      ? `  ${ids.get(edge.from)} -.->|"state(log)"| ${ids.get(edge.to)}`
      : `  ${port(edge.from, "out", edge.port).id} --> ${port(edge.to, "in", edge.port).id}`);
  }
  return lines.join("\n");
}
