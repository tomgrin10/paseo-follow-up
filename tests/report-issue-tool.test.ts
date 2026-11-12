import test from "node:test";
import assert from "node:assert/strict";
import { actionTools, toolList } from "../server/mcp.mjs";
import { nativeTools } from "../server/native-tools";
import { MAX_DESCRIPTION, reportToolDescription, reportToolProperties } from "../server/report-issue";
import { reportPrompt } from "../server/report-issue-adapter";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Invariant `report-issue-costs-no-standing-context`: Follow-up's report_issue tool is one short line in the tool list
 * every root agent receives, and nothing about reporting is injected anywhere else (hooks, instructions).
 */
const tuple = (actionTools as [string, string, string, Record<string, unknown>, string[]][]).find(t => t[0] === "report_issue")!;

test("report-issue-costs-no-standing-context: the bridge's tuple is the module's one-line description and schema", () => {
  assert.ok(tuple, "report_issue is an action tool");
  assert.equal(tuple[1], reportToolDescription("Follow-up"));
  assert.ok(tuple[1].length <= MAX_DESCRIPTION, `${tuple[1].length} chars`);
  assert.deepEqual(Object.keys(tuple[3]).sort(), Object.keys(reportToolProperties).sort());
  assert.deepEqual(tuple[4], []);
});

test("report-issue-costs-no-standing-context: no hook, instruction or prompt text mentions reporting", async () => {
  const root = join(import.meta.dirname, "..");
  for (const f of ["server/agent-hook.mjs", "server/overseer-prompt.md"]) {
    const src = await readFile(join(root, f), "utf8");
    // The hook may list the tool's name (it recognises Follow-up's own calls), never describe it.
    assert.ok(!/report (a|an) (bug|issue)|report_issue\b(?!")/i.test(src.replace(/TOOL_NAMES = \[[^\]]*\]/, "")), `${f} talks about reporting`);
  }
  const mcp = await readFile(join(root, "server/mcp.mjs"), "utf8");
  for (const name of ["actionInstruction", "overseerInstruction", "needsYouInstruction", "waitInstruction", "backgroundWorkInstruction"]) {
    const line = new RegExp(`const ${name} = "([^"]*)"`).exec(mcp)?.[1] ?? "";
    assert.ok(!/report (a|an) (bug|issue)|report_issue/i.test(line), `${name} mentions reporting`);
  }
});

test("report_issue reaches root agents and contributors, never recovery sessions", () => {
  const names = (list: unknown[][]) => list.map(t => t[0]);
  assert.ok(names(toolList(false, false, false, false, true)).includes("report_issue"));
  assert.ok(names(toolList(false, true, false, false, true)).includes("report_issue"));
  assert.ok(!names(toolList(true, false, false, false, true)).includes("report_issue"));
  void nativeTools;
});

test("the sheet's prompt names the tool and the developer's words, and asks to see the issue first", () => {
  const p = reportPrompt("bug", "Send fails", "Send repairs didn't work: GitHub HTTP 502");
  assert.match(p, /^Report a bug about Follow-up for me: Send fails/);
  assert.match(p, /The error I saw: Send repairs didn't work/);
  assert.match(p, /follow_report_issue/);
  assert.match(p, /show me the exact issue before filing/);
  assert.match(reportPrompt("feature", ""), /^Report a feature request about Follow-up for me: \(I'll describe it/);
});

test("every error toast offers Report this, which opens the sheet with the error; other toasts don't", async () => {
  const toasts = await import("../client/toast-store");
  const opened: { message: string; at: number }[] = [];
  toasts.setReportError((message, at) => opened.push({ message, at }));
  try {
    const id = toasts.pushToast("error", "Send repairs didn't work: GitHub HTTP 502", [{ label: "Retry", onPress: () => {} }]);
    const t = toasts.toastsNow().find(x => x.id === id)!;
    assert.deepEqual(t.actions.map(a => a.label), ["Retry", toasts.REPORT_THIS]);
    t.actions[1].onPress();
    assert.equal(opened[0].message, "Send repairs didn't work: GitHub HTTP 502");
    assert.ok(!toasts.toastsNow().some(x => x.id === id), "Report this closes the toast");
    const info = toasts.pushToast("info", "Sent");
    assert.deepEqual(toasts.toastsNow().find(x => x.id === info)!.actions, []);
    toasts.dismissToast(info);
  } finally { toasts.setReportError(null); }
});
