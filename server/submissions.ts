import type { Pr, Workspace } from "../shared/model";

export type Submission = { repo: string; number: number; agentId: string; branch: string | null };
const reference = /https:\/\/(?:github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)|app\.graphite\.(?:com|dev)\/github\/pr\/([\w.-]+)\/([\w.-]+)\/(\d+))(?=[/?#\s]|$)/;

/** Ignore command-like text inside quoted arguments and comments; never execute shell text. */
function unquoted(command: string): string {
  let quote = "", result = "";
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === "\\" && quote !== "'") { result += "  "; i++; continue; }
    if (quote) { if (c === quote) quote = ""; result += " "; continue; }
    if (["'", '\"', "`"].includes(c)) { quote = c; result += " "; continue; }
    if (c === "#" && (i === 0 || /\s/.test(command[i - 1]))) {
      while (i < command.length && command[i] !== "\n") { result += " "; i++; }
      result += "\n"; continue;
    }
    result += c;
  }
  return result;
}

/** Submission receipts are ownership evidence. Links in chat, reviews or file reads are not. */
export function submittedPrs(items: readonly unknown[], agentId: string, repository: string | null): Submission[] {
  if (!repository) return [];
  const found = new Map<string, Submission>();
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const v = item as { type?: string; status?: string; error?: unknown; detail?: { type?: string; command?: string; output?: unknown } };
    const d = v.detail;
    if (v.type !== "tool_call" || v.status !== "completed" || v.error || d?.type !== "shell" || typeof d.command !== "string" || typeof d.output !== "string") continue;
    const command = unquoted(d.command);
    // Do not interpret arbitrary scripts or quoted documentation as commands.
    if (/<</.test(command) || /--(?:help|dry-run)\b/.test(command)) continue;
    const gh = /(?:^|[;&|\n])\s*(?:timeout\s+\d+\s+)?gh\s+pr\s+create\b/.test(command);
    const gt = /(?:^|[;&|\n])\s*(?:timeout\s+\d+\s+)?gt\s+(?:submit|ss)\b/.test(command);
    if (!gh && !gt) continue;
    const output = d.output.replace(/\x1b\[[0-9;]*m/g, "");
    for (const line of output.split(/\r?\n/)) {
      const match = reference.exec(line);
      if (!match) continue;
      const repo = `${match[1] ?? match[4]}/${match[2] ?? match[5]}`;
      const number = Number(match[3] ?? match[6]);
      if (repo.toLowerCase() !== repository.toLowerCase() || !Number.isSafeInteger(number) || number < 1) continue;
      const branch = gt ? /^(\S+): https:\/\/\S+ \((?:created|updated)\)\s*$/.exec(line)?.[1] ?? null : null;
      if (!(gh && line.trim() === match[0]) && !(gt && (branch || line.trim() === `View your PR at ${match[0]}`))) continue;
      const key = `${repository}#${number}`;
      const previous = found.get(key);
      found.set(key, { repo: repository, number, agentId, branch: branch ?? previous?.branch ?? null });
    }
  }
  return [...found.values()];
}

/** Only inferred relationships follow GitHub's observed base/head branches. Explicit edits win. */
export function reconcileSubmittedStacks(w: Workspace): void {
  for (const p of w.prs.filter(p => p.discoveredFromSubmission)) {
    const s = p.snapshot;
    if (p.error || !s?.complete || !s.headBranch || !s.base) continue;
    const parents = w.prs.filter(row => row.key !== p.key && row.repo === p.repo && !row.error && row.snapshot?.complete && row.snapshot.headBranch && row.snapshot.headBranch !== row.snapshot.trunk && row.snapshot.headBranch === s.base);
    const parent = parents.length === 1 ? parents[0] : null;
    let cursor: Pr | undefined = parent ?? undefined;
    const seen = new Set([p.key]); let cycle = false;
    while (cursor) { if (seen.has(cursor.key)) { cycle = true; break; } seen.add(cursor.key); cursor = w.prs.find(row => row.key === cursor!.parent); }
    if (!cycle) p.parent = parent?.key ?? null;
  }
  for (const p of w.prs.filter(p => p.discoveredFromSubmission && !p.parent)) {
    if (!p.error && p.snapshot?.complete && p.snapshot.headBranch) p.stack = p.snapshot.headBranch;
  }
  for (const p of w.prs.filter(p => p.discoveredFromSubmission)) {
    let root = p; const seen = new Set([p.key]);
    while (root.parent) { const parent = w.prs.find(row => row.key === root.parent); if (!parent || seen.has(parent.key)) break; seen.add(parent.key); root = parent; }
    p.stack = root.stack;
  }
}
