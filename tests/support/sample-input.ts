/**
 * A plausible input for any RPC contract, built from its zod schema, so the RPC acknowledgement invariant covers every
 * registered method without a hand-written list. Ids name the fixture's own records (FIXTURE), so handlers reach their
 * real paths instead of failing validation; tests/rpc-ack.test.ts overrides a method's input only where a schema can't
 * say enough (which decision a brief card answers).
 */
export const FIXTURE = { workspaceId: "workspace", agentId: "main-agent", questionId: "Q1", briefId: "brief:turn-1", prKey: "example/app#1", repo: "example/app", batchId: "batch-1", taskId: "task-1" };

const BY_KEY: Record<string, unknown> = {
  workspaceId: FIXTURE.workspaceId, agentId: FIXTURE.agentId, questionId: FIXTURE.questionId, briefId: FIXTURE.briefId,
  prKey: FIXTURE.prKey, key: FIXTURE.prKey, repo: FIXTURE.repo, batchId: FIXTURE.batchId, taskId: FIXTURE.taskId, decisionId: "D1",
  agentIds: [FIXTURE.agentId], workspaceIds: [FIXTURE.workspaceId], number: 1, url: "https://github.com/example/app/pull/1",
};

type Def = { type: string; [k: string]: any };
const def = (schema: any): Def => schema?._zod?.def ?? schema?.def ?? schema?._def;

export function sample(schema: any, key = ""): unknown {
  const d = def(schema);
  if (!d) return undefined;
  if (key in BY_KEY && ["string", "array", "number", "optional", "nullable", "default"].includes(d.type)) {
    const v = BY_KEY[key];
    // Only when the schema accepts it (a key can mean something else in another contract).
    if (schema.safeParse?.(v)?.success) return v;
  }
  switch (d.type) {
    case "object": {
      const out: Record<string, unknown> = {};
      for (const [k, child] of Object.entries(d.shape as Record<string, any>)) {
        const cd = def(child);
        // Optional fields stay out unless they name a fixture record: the handler takes its default path.
        if (cd?.type === "optional" && !(k in BY_KEY)) continue;
        const v = sample(child, k);
        if (v !== undefined) out[k] = v;
      }
      return out;
    }
    case "optional": case "nullable": case "default": case "prefault": case "readonly": case "catch": case "nonoptional":
      return sample(d.innerType, key);
    case "pipe": return sample(d.in, key);
    case "string": {
      const v = "a";
      return schema.safeParse?.(v)?.success ? v : schema.safeParse?.("A")?.success ? "A" : schema.safeParse?.("2026-01-01T10:00:00Z")?.success ? "2026-01-01T10:00:00Z" : v;
    }
    case "number": case "int": return 1;
    case "boolean": return true;
    case "literal": return d.values?.[0] ?? d.value;
    case "enum": return Object.values(d.entries)[0];
    case "array": { const v = sample(d.element, key); return v === undefined ? [] : [v]; }
    case "record": return {};
    case "union": return sample(d.options[0], key);
    case "discriminatedUnion": return sample(d.options[0], key);
    case "unknown": case "any": return {};
    case "lazy": return sample(d.getter(), key);
    default: return undefined;
  }
}
