import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { recoveryActions } from "../client/recovery-actions";

/**
 * recovery-offers-one-primary-action (2026-11-13). After a failed recovery the panel's Recovery block showed "Run
 * recovery", "Open recovery agent" and "Retry recovery" together; Run and Retry do the same thing from the developer's
 * view. One primary action per state: Retry after a failure, Run (or Run queued) otherwise, plus Open recovery agent
 * when an agent exists.
 */
const STATES = ["pending", "sending", "sent", "completed", "blocked", "cancelled", "uncertain"] as const;

test("recovery-offers-one-primary-action: no state offers both Run and Retry", () => {
  const rows: string[] = [];
  for (const state of [undefined, ...STATES]) for (const archived of [false, true]) for (const starting of [false, true]) for (const recipient of [null, "recovery-1"]) {
    const last = state ? { state, recipientAgentId: recipient } : undefined;
    const { primary, openAgent } = recoveryActions(last, { archived, starting });
    rows.push(`${state ?? "none"} ${primary.title}${primary.disabled ? " (disabled)" : ""}${openAgent ? " + Open recovery agent" : ""}`);
    assert.equal(openAgent, !!last?.recipientAgentId, `${state}: Open recovery agent exactly when an agent exists`);
    if (state === "blocked" || state === "uncertain") assert.equal(primary.kind, "retry", `${state}: after a failure the one action is Retry`);
    else assert.notEqual(primary.kind, "retry", `${state}: Retry only after a failure`);
  }
  assert.ok(rows.length > 0);
});

test("recovery-offers-one-primary-action: the action per state", () => {
  const at = (state: (typeof STATES)[number] | undefined, extra: { archived?: boolean; starting?: boolean } = {}) =>
    recoveryActions(state ? { state, recipientAgentId: "recovery-1" } : undefined, { archived: false, starting: false, ...extra }).primary;
  assert.deepEqual(at(undefined), { kind: "run", title: "Run recovery", disabled: false }, "idle, never run");
  assert.deepEqual(at("completed"), { kind: "run", title: "Run recovery", disabled: false }, "idle after a finished run");
  assert.deepEqual(at("cancelled"), { kind: "run", title: "Run recovery", disabled: false });
  assert.deepEqual(at("pending"), { kind: "run-queued", title: "Run queued recovery", disabled: false });
  assert.deepEqual(at("sending"), { kind: "run", title: "Starting recovery…", disabled: true });
  assert.deepEqual(at("sent"), { kind: "run", title: "Run recovery", disabled: true }, "running: nothing to start");
  assert.deepEqual(at("blocked"), { kind: "retry", title: "Retry recovery", disabled: false });
  assert.deepEqual(at("uncertain"), { kind: "retry", title: "Retry recovery", disabled: false });
  assert.deepEqual(at(undefined, { starting: true }), { kind: "run", title: "Starting recovery…", disabled: true });
  assert.equal(at("completed", { archived: true }).disabled, true, "an archived workspace starts no recovery");
});

test("recovery-offers-one-primary-action: the panel renders only what recoveryActions returns", async () => {
  const panel = await readFile(join(import.meta.dirname, "../client/panel.tsx"), "utf8");
  assert.match(panel, /recoveryActions\(last, \{ archived: w\.archived, starting: recovery\.isPending \}\)/);
  assert.doesNotMatch(panel, /title="(Run recovery|Retry recovery|Run queued recovery)"/, "no Recovery button with its own title beside the one primary");
  assert.doesNotMatch(panel, /"Run recovery"|"Retry recovery"/, "the titles live in client/recovery-actions.ts");
});
