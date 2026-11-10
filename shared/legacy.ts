/**
 * Follow-up 1.x ran under its old internal name, "follow-through". 2.0 is Follow-up everywhere, and this is the only
 * module that still knows the old name: it recognises what 1.x left behind and cleans it up. Nothing here writes the
 * old name into anything new, except the two compatibility files named below (the recovery shim and the heartbeat).
 * tests/no-legacy-name.test.ts allows the old name only here and in CHANGELOG.md; scripts/rename-legacy-name.mjs is
 * the mechanical rename for everything else.
 *
 * Each export says when it can go. "Keep" means as long as 1.x data, agents or transcripts may exist.
 */

/** The plugin id. */
export const PLUGIN_ID = "follow-up";
/** 1.x's plugin id. An upgraded install keeps it until the one-time move (server/plugin-move.ts). Keep. */
export const LEGACY_PLUGIN_ID = "follow-through";
/** Ids that may be Follow-up, newest first. Cross-plugin callers try them in this order. */
export const PLUGIN_IDS = [PLUGIN_ID, LEGACY_PLUGIN_ID] as const;

/** `$PASEO_HOME/plugin-data/<dir>`. */
export const DATA_DIR = "follow-up";
/** 1.x's data directory. 2.0 copies it once (server/data-move.ts) and never deletes it. Keep. */
export const LEGACY_DATA_DIR = "follow-through";

// ── Agent labels ──────────────────────────────────────────────────────────────────────────────────────────────────
export const RECOVERY_LABEL = "follow-up.recovery";
export const RECOVERY_BATCH_LABEL = "follow-up.recovery-batch";
/** Recovery agents 1.x started carry these. Keep while such agents may exist. */
const LEGACY_RECOVERY_LABEL = "follow-through.recovery";
const LEGACY_RECOVERY_BATCH_LABEL = "follow-through.recovery-batch";
/** Whether an agent is a Follow-up recovery agent, whichever version started it. */
export function isRecovery(labels: Record<string, string> | null | undefined): boolean {
  return !!labels && (!!labels[RECOVERY_LABEL] || !!labels[LEGACY_RECOVERY_LABEL]);
}
/** The batch a recovery agent works on, whichever version started it. */
export function recoveryBatch(labels: Record<string, string> | null | undefined): string | undefined {
  return labels?.[RECOVERY_BATCH_LABEL] ?? labels?.[LEGACY_RECOVERY_BATCH_LABEL];
}

// ── Message prefixes (what Follow-up sends agents as user messages) ────────────────────────────────────────────────
export const BATCH_PREFIX = "Follow-up batch";
export const WORKSPACE_BATCH_PREFIX = "Workspace Follow-up batch";
export const RECOVERY_TITLE = "Follow-up recovery";
/** 1.x's prefixes, still in old transcripts. Same pattern as FORWARD_PREFIXES/isForwarded. Keep. */
export const LEGACY_BATCH_PREFIXES = ["Workspace follow-through batch", "Follow-through batch"] as const;
const LEGACY_RECOVERY_TITLE = "Follow-through recovery";
export const BATCH_PREFIXES = [WORKSPACE_BATCH_PREFIX, BATCH_PREFIX, ...LEGACY_BATCH_PREFIXES] as const;
export const RECOVERY_TITLES = [RECOVERY_TITLE, LEGACY_RECOVERY_TITLE] as const;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** `<prefix> <batchId>\n\n<body>` for any version's batch prefix; null when it isn't one. */
export function splitBatchText(text: string): { body: string } | null {
  const match = new RegExp(`^(?:${BATCH_PREFIXES.map(escape).join("|")}) \\S+\\n\\n([\\s\\S]+)$`).exec(text.trim());
  return match ? { body: match[1] } : null;
}
/** 1.x's hook text that named the old sidebar; old transcripts carry it. Keep. */
export const LEGACY_HOOK_TEXT_PREFIXES = ["Maintain this tracked workspace's Follow-through sidebar"] as const;
export function isRecoveryText(text: string): boolean {
  return new RegExp(`^(?:${RECOVERY_TITLES.map(escape).join("|")}) \\S+`).test(text.trim());
}

// ── Tool names in transcripts ──────────────────────────────────────────────────────────────────────────────────────
/** The stdio bridge's MCP server name (Paseo 0.14 and recovery agents). */
export const MCP_SERVER = "follow-up";
/** 1.x's bridge name: 1.x recovery agents and old transcripts. Keep. */
export const LEGACY_MCP_SERVER = "follow-through";
export const MCP_SERVERS = [MCP_SERVER, LEGACY_MCP_SERVER] as const;
/** Claude's mcp__<server>__x, Codex's <server>.x, for either bridge name. */
export const BRIDGE_TOOL = new RegExp(`^(?:mcp__)?(?:${MCP_SERVERS.map(escape).join("|")})(?:__|\\.|\\/|:)([a-z_]+)$`);
/** The CLI fallback: node …/plugin-data/<dir>/mcp.mjs call <tool> '<json>', for either data directory. */
export const BRIDGE_SHELL_CALL = new RegExp(`plugin-data\\/(?:${[DATA_DIR, LEGACY_DATA_DIR].map(escape).join("|")})\\/mcp\\.mjs['"]?\\s+call\\s+([a-z_]+)(?:\\s+'((?:[^']|'"'"')*)')?`);

// ── Environment ────────────────────────────────────────────────────────────────────────────────────────────────────
export const ENV_PREFIX = "FOLLOW_UP_";
/**
 * 1.x set FOLLOW_THROUGH_<NAME> in agent sessions. A session opened before the upgrade keeps that env until Paseo
 * reopens it, and its hook and bridge run with it. Can go in the release after 2.0.0.
 */
export const LEGACY_ENV_PREFIX = "FOLLOW_THROUGH_";
export function readEnv(name: string, env: Record<string, string | undefined> = process.env): string | undefined {
  return env[ENV_PREFIX + name] ?? env[LEGACY_ENV_PREFIX + name];
}
/**
 * The standalone scripts (agent-hook.mjs, mcp.mjs) run outside the worker and can't import this module. The worker
 * writes them with this prelude (after the shebang); they read `globalThis.followUpRuntime`: the plugin ids to try
 * (the old one answers until the move finishes) and the 1.x names they still recognise.
 * The legacy fields can go with LEGACY_ENV_PREFIX.
 */
export function withRuntimePrelude(source: string): string {
  const prelude = `globalThis.followUpRuntime = ${JSON.stringify({ pluginIds: PLUGIN_IDS, legacyEnvPrefix: LEGACY_ENV_PREFIX, legacyMcpServer: LEGACY_MCP_SERVER })};\n`;
  return source.startsWith("#!") ? source.replace(/^(#![^\n]*\n)/, `$1${prelude}`) : prelude + source;
}

// ── Registrations 1.x wrote into other tools' config ───────────────────────────────────────────────────────────────
export const HOOK_MARKER = "# paseo-follow-up-hook";
/** 1.x's Claude/Codex hook marker. reconcileHooks drops both, then adds the new one. Keep. */
export const LEGACY_HOOK_MARKER = "# paseo-follow-through-hook";
export const HOOK_MARKERS = [HOOK_MARKER, LEGACY_HOOK_MARKER] as const;
/** Pre-1.4.0-beta.2 user-scope MCP entry (Claude .claude.json, Codex config.toml) and the env flag that marks it ours. */
export const LEGACY_GLOBAL_MCP = { name: LEGACY_MCP_SERVER, managedEnv: `${LEGACY_ENV_PREFIX}MANAGED`, backup: ".follow-through-unregister.bak" } as const;

// ── Plugin settings and screens ────────────────────────────────────────────────────────────────────────────────────
/** Settings screens earlier versions registered; the client redirects them. Keep while saved tabs may name them. */
export const LEGACY_SETTINGS_SCREEN = "follow-through-settings";

// ── Compatibility files in the old data directory ──────────────────────────────────────────────────────────────────
/**
 * Recovery agents 1.x started run `plugin-data/<old>/mcp.mjs`, which calls the plugin by its old id. After the move
 * 2.0 replaces that one generated file with this shim, which runs the new bridge. Keep while 1.x recovery agents may
 * be resumed.
 */
export function recoveryShimSource(newBridge: string): string {
  return `// Follow-up 2.0: this ${LEGACY_DATA_DIR} directory is 1.x's backup. Recovery agents started by 1.x still run this file,\n// so it runs the current bridge.\nglobalThis.followUpRunAsBridge = true;\nawait import(${JSON.stringify(new URL(`file://${newBridge}`).href)});\n`;
}
/**
 * The 1.x installer (#61) watches heartbeat.json in the old directory during probation; 2.0 writes it there too, or
 * a good update would be rolled back. Can go in the release after 2.0.0, once no 1.x installer can be on probation.
 */
export const LEGACY_HEARTBEAT = true;

/** Follow-up's own messages to an agent (batches, recovery briefs, answers), any version: never the developer's words. */
export function isPluginPrompt(text: string): boolean {
  return new RegExp(`^(?:${[...BATCH_PREFIXES, ...RECOVERY_TITLES, "Follow-up answer"].map(escape).join("|")}) `).test(text);
}
/** A recovery agent's initial task for this batch, any version. */
export function isRecoveryTaskFor(text: string, batchId: string): boolean {
  return RECOVERY_TITLES.some(title => text.startsWith(`${title} ${batchId}\n`));
}

/** Paseo's answer when no plugin runs under an id ("Plugin is not available: <id>" on 0.15 and 0.16). */
export function isAbsentPlugin(error: unknown): boolean {
  return /plugin (?:is )?not (?:available|installed|configured)|unknown plugin/i.test(error instanceof Error ? error.message : String(error));
}
/** Calls Follow-up's own RPC under whichever id it runs as (the old one until the move finishes). */
export async function invokeSelf<T>(invoke: (pluginId: string) => Promise<T>): Promise<T> {
  let last: unknown;
  for (const id of PLUGIN_IDS) {
    try { return await invoke(id); } catch (error) { if (!isAbsentPlugin(error)) throw error; last = error; }
  }
  throw last;
}
/** The row Paseo lists for this install: the running one of either id, else whichever exists, newest id first. */
export function ownRow<R extends { id: string; status?: string | null }>(rows: readonly R[]): R | undefined {
  const ours = PLUGIN_IDS.map(id => rows.find(r => r.id === id)).filter((r): r is R => !!r);
  return ours.find(r => r.status === "running") ?? ours[0];
}
