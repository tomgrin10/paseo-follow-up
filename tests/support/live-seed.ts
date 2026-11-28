// The live-sized seed's big workspace (scripts/scale-seed.ts --live-sized: 153 PRs, 39 tasks, 300 questions, 400
// batches), built once per test process. Synthetic data only (example/app).
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Workspace } from "../../shared/model";

let cached: Workspace | null = null;
export function liveSizedWorkspace(): Workspace {
  if (cached) return structuredClone(cached);
  const dir = mkdtempSync(join(tmpdir(), "live-seed-"));
  try {
    writeFileSync(join(dir, "created.json"), JSON.stringify([{ workspaceId: "ws-big", agentId: "agent-big" }, { workspaceId: "ws-2", agentId: "agent-2" }]));
    execFileSync(process.execPath, ["--import", "tsx", "scripts/scale-seed.ts", join(dir, "state.json"), join(dir, "created.json"), "3", "0", join(dir, "inbox.json"), "--live-sized"], { stdio: "ignore" });
    cached = JSON.parse(readFileSync(join(dir, "state.json"), "utf8")).workspaces[0] as Workspace;
  } finally { rmSync(dir, { recursive: true, force: true }); }
  return structuredClone(cached);
}

/** The agents a busy workspace accumulates in the directory: a few live, hundreds closed or archived (live 2026-11-28: 345). */
export function busyAgents(w: Pick<Workspace, "mainAgentId">, total = 345) {
  return Array.from({ length: total }, (_, i) => ({
    id: i === 0 ? w.mainAgentId : `agent-${i}`, title: `Invoice retry helper ${i} for the shared queue rollout`,
    provider: i % 3 ? "claude" : "codex", status: i === 0 ? "idle" : i < 4 ? "running" : "closed", archived: i >= 4 && i % 2 === 0,
    lastActivityAt: new Date(Date.parse("2026-11-28T09:00:00Z") - i * 60_000).toISOString(),
  }));
}
