import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

// Tom (2026-11-10): "When answering a question it loads a bit until it's sent to the agent, and then it displays
// another screen saying it was sent. When answering, just close the popup."
// Root cause: every dialog ran its RPC in a useMutation and closed in `onSuccess`, so the developer watched a spinner
// and then a confirmation screen. Quick actions close first and report through runAction's toast (client/toast-store.ts).

// ---------- invariant: no dialog waits on its RPC before closing ----------

/** A close of a dialog, sheet, picker or popover. */
const CLOSES = /\bonClose\(\)|\bonAnswered\?\.\(\)|\bsetPicking\(false\)|\bprops\.close\(\)|\bsetOpen\(false\)|\bsetPlan\(null\)|\bsetEditing\(null\)/;
/** Dialogs that stay open until the server answers, with the reason. Keep this short. */
const BLOCKING: Record<string, string> = {
  "pr-controls.tsx:submit": "Merge and merge-when-ready re-check the whole stack and can come back with blockers to confirm; the plan sheet stays until GitHub answers (invariant 6: nothing irreversible on its own).",
};

/** The text of a call's arguments, from just after its "(" to the matching ")", skipping strings and templates. */
function callArgs(source: string, open: number): string {
  let depth = 0; let quote: string | null = null;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (quote) { if (ch === "\\") i++; else if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") { depth--; if (depth === 0) return source.slice(open + 1, i); }
  }
  return source.slice(open + 1);
}

function closingOnSuccess(source: string): { name: string; line: number }[] {
  const out: { name: string; line: number }[] = [];
  for (const m of source.matchAll(/const (\w+) = useMutation\(/g)) {
    const args = callArgs(source, m.index! + m[0].length - 1);
    const at = args.search(/onSuccess:/);
    if (at < 0) continue;
    // onSuccess's own function: up to the next top-level option (onError, onSettled) or the end of the options.
    const success = /^onSuccess:([\s\S]*?)(?:,\s*on[A-Z]\w*:|$)/.exec(args.slice(at));
    if (success && CLOSES.test(success[1])) out.push({ name: m[1], line: source.slice(0, m.index).split("\n").length });
  }
  return out;
}

test("the scan catches a dialog that closes in onSuccess and passes one that closes first", () => {
  assert.equal(closingOnSuccess(`const run = useMutation({ mutationFn: () => save(), onSuccess: () => { toast.show("Saved"); onClose(); }, onError: e => toast.error(e) });`).length, 1);
  assert.equal(closingOnSuccess(`const run = useMutation({\n  onSuccess: (_, input) => {\n    toast.show("Saved", { variant: "success" });\n    onClose();\n  },\n  onError: e => e,\n});`).length, 1, "a toast's }); before the close doesn't end the scan");
  assert.equal(closingOnSuccess(`const send = useMutation({ mutationFn: f, onSuccess: (r, a) => { refresh(); onAnswered?.(); } });`).length, 1);
  assert.equal(closingOnSuccess(`const act = () => { onClose(); void runAction({ run: () => save() }); };\nconst run = useMutation({ mutationFn: f, onSuccess: () => refresh() });`).length, 0);
});

test("no dialog primary action awaits its RPC before closing (quick actions close first)", async () => {
  const dir = join(import.meta.dirname, "..", "client");
  const found: string[] = [];
  for (const f of (await readdir(dir)).filter(f => f.endsWith(".tsx"))) {
    for (const hit of closingOnSuccess(await readFile(join(dir, f), "utf8"))) if (!BLOCKING[`${f}:${hit.name}`]) found.push(`${f}:${hit.line} ${hit.name}`);
  }
  assert.deepEqual(found, [], "Close first and run the work through runAction (client/toast-store.ts), or add a BLOCKING reason");
});

test("Send and Copy on a question close the dialog before the server answers", async () => {
  const source = await readFile(join(import.meta.dirname, "..", "client", "questions.tsx"), "utf8");
  const quick = /const quick = \(action: "send" \| "copy"\) => \{([\s\S]*?)\n  \};/.exec(source);
  assert.ok(quick, "QuestionBody has its quick send");
  assert.match(quick[1], /setPendingAnswer\([\s\S]*void runAction\([\s\S]*\}\);\s*onClose\?\.\(\); onAnswered\?\.\(\);$/, "the answer is kept, the work starts, and the dialog closes without awaiting it");
  assert.match(source, /onPress=\{\(\) => quick\("send"\)\}/);
  assert.match(source, /onSubmit=\{\(\) => open \? quick\("send"\)/, "the keyboard's Send takes the same quick path");
});

test("one runAction and one toast path: every quick action, the row menu's included, uses client/toast-store.ts", async () => {
  const dir = join(import.meta.dirname, "..", "client");
  const defines: string[] = []; const imports: string[] = [];
  for (const f of (await readdir(dir)).filter(f => /\.tsx?$/.test(f))) {
    const source = await readFile(join(dir, f), "utf8");
    if (/function runAction\b|const runAction\s*=/.test(source)) defines.push(f);
    for (const m of source.matchAll(/import \{[^}]*\brunAction\b[^}]*\} from "([^"]+)"/g)) if (m[1] !== "./toast-store" && m[1] !== "./toasts") imports.push(`${f} ← ${m[1]}`);
  }
  assert.deepEqual(defines, ["toast-store.ts"], "a second runAction splits the toast path");
  assert.deepEqual(imports, []);
  assert.match(await readFile(join(dir, "row-actions.ts"), "utf8"), /from "\.\/toast-store"/, "the row menu's Later, Sign off and the rest report through the shared toasts");
});

// Harness (2026-11-10): Follow-up's toasts were in the DOM but never on screen. Every root (sidebar row, panel, Home)
// sits in a clipped container, so position: fixed was trapped inside it. On web the stack renders in its own layer.
test("on web, toasts render in a layer on document.body, not inside a Follow-up root", async () => {
  const source = await readFile(join(import.meta.dirname, "..", "client", "toasts.tsx"), "utf8");
  assert.match(source, /doc\.body\.appendChild\(root\)/);
  assert.match(source, /AppRegistry\.runApplication\(LAYER_KEY, \{ rootTag: root/);
  assert.match(source, /pointer-events:none/, "the layer never blocks the page under it");
  assert.match(source, /if \(layered\) return null;/, "the root itself draws nothing inline on web");
  assert.match(source, /<Pressable pointerEvents="auto" accessibilityRole="alert"[^>]*focusable=\{false\}/, "pointer-events is inherited: each toast takes clicks back, or Undo and Retry can't be pressed");
});

// ---------- runAction and the toast store ----------

const store = () => import("../client/toast-store");

test("runAction: success becomes a toast; with no ToastHost mounted it goes to the host toast", async () => {
  const { runAction, toastsNow, hosts, dismissToast } = await store();
  const host: string[] = [];
  const toast = { show: (m: string) => { host.push(`show:${m}`); }, error: (m: string) => { host.push(`error:${m}`); } };
  await runAction({ label: "x", run: async () => 1, success: () => ({ message: "Sent to the main agent" }), failure: "Answer to Q1 not sent", toast });
  assert.deepEqual(host, ["show:Sent to the main agent"], "no ToastHost: the host toast says it");
  hosts.push(99);
  try {
    await runAction({ label: "x", run: async () => 1, success: () => ({ message: "Sent to the main agent" }), failure: "f", toast });
    assert.equal(toastsNow().at(-1)?.message, "Sent to the main agent");
    assert.equal(host.length, 1, "with a ToastHost, Follow-up's own stack shows it, not both");
  } finally { hosts.splice(hosts.indexOf(99), 1); for (const t of toastsNow()) dismissToast(t.id); }
});

test("runAction: a failure keeps Retry and Open, stays until dismissed, and Retry runs the work again", async () => {
  const { runAction, toastsNow, hosts, dismissToast } = await store();
  hosts.push(98);
  try {
    let calls = 0; let opened = 0; let failed = 0;
    await runAction({ label: "x", run: async () => { calls++; if (calls === 1) throw new Error("network down"); return 1; }, success: () => ({ message: "Sent" }), failure: "Answer to Q24 not sent", open: () => { opened++; }, onError: () => { failed++; } });
    const error = toastsNow().find(t => t.tone === "error")!;
    assert.match(error.message, /^Answer to Q24 not sent\. /);
    assert.equal(error.sticky, true, "errors stay until dismissed");
    assert.deepEqual(error.actions.map(a => a.label), ["Retry", "Open"]);
    assert.equal(failed, 1, "the caller keeps the input before the toast shows");
    error.actions[1].onPress(); assert.equal(opened, 1);
    error.actions[0].onPress(); await new Promise(r => setTimeout(r, 0));
    assert.equal(calls, 2, "Retry runs the same action again");
  } finally { hosts.splice(hosts.indexOf(98), 1); for (const t of toastsNow()) dismissToast(t.id); }
});

test("runAction: a plain-string success, a default failure, reopen, and a key that drops a duplicate in flight", async () => {
  const { runAction, bindToast } = await store();
  const host: string[] = [];
  bindToast({ show: m => { host.push(`show:${m}`); }, error: m => { host.push(`error:${m}`); } });
  try {
    let release!: () => void; const gate = new Promise<void>(r => { release = r; });
    const first = runAction({ label: "Later", run: () => gate, success: "Later · Tomorrow 9:00" }, "later:w1");
    assert.equal(await runAction({ label: "Later", run: async () => undefined, success: "dup" }, "later:w1"), false, "a second tap while the first runs does nothing");
    release(); assert.equal(await first, true);
    let reopened = 0;
    assert.equal(await runAction({ label: "Stop following", run: async () => { throw new Error("offline"); }, success: null, reopen: () => { reopened++; } }), false);
    assert.deepEqual(host, ["show:Later · Tomorrow 9:00", "error:Stop following didn't work. offline"]);
    assert.equal(reopened, 1);
  } finally { bindToast(null); }
});

test("runAction without a ToastHost: the host toast says it wasn't sent and where to retry", async () => {
  const { runAction } = await store();
  const host: string[] = [];
  await runAction({ label: "x", run: async () => { throw new Error("offline"); }, success: () => null, failure: "Answer to Q24 not sent", open: () => undefined,
    toast: { show: () => undefined, error: m => { host.push(m); } } });
  assert.deepEqual(host, ["Answer to Q24 not sent. Retry from Needs you."]);
});

test("a kept toast outlives the drop; hover holds its time; onExpire runs only on timeout", async t => {
  const { pushToast, holdToast, toastsNow, dismissToast } = await store();
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    let expired = 0;
    const kept = pushToast("info", "Telling the agent it's done", [], { durationMs: 6_000, keep: true, onExpire: () => { expired++; } });
    pushToast("success", "a"); pushToast("success", "b"); pushToast("success", "c");
    assert.ok(toastsNow().some(x => x.id === kept), "an Undo window is never pushed out by newer toasts");
    t.mock.timers.tick(3_000); holdToast(kept, true); t.mock.timers.tick(10_000);
    assert.equal(expired, 0, "held: the window doesn't run out under the pointer");
    holdToast(kept, false); t.mock.timers.tick(3_100);
    assert.equal(expired, 1); assert.equal(toastsNow().some(x => x.id === kept), false);
    const gone = pushToast("info", "x", [], { onExpire: () => { expired++; } }); dismissToast(gone); t.mock.timers.tick(10_000);
    assert.equal(expired, 1, "dismissed or acted on: never expires");
  } finally { for (const x of toastsNow()) dismissToast(x.id); t.mock.timers.reset(); }
});

test("the stack holds at most three; the oldest non-error goes first", async () => {
  const { pushToast, toastsNow, dismissToast } = await store();
  const error = pushToast("error", "e");
  pushToast("success", "a"); pushToast("success", "b"); pushToast("success", "c");
  assert.deepEqual(toastsNow().map(t => t.message), ["e", "b", "c"]);
  for (const t of toastsNow()) dismissToast(t.id);
  assert.equal(toastsNow().some(t => t.id === error), false);
});

// ---------- pending answers: nothing typed is lost ----------

test("a sent answer is kept until the server has it; a failure keeps the words and the reason", async () => {
  const { setPendingAnswer, failPendingAnswer, clearPendingAnswer, pendingAnswer } = await import("../client/pending-answers");
  setPendingAnswer("w1", "Q24", { choice: "other", words: "Cap retries at 5" });
  assert.equal(pendingAnswer("w1", "Q24")?.error, undefined, "in flight");
  failPendingAnswer("w1", "Q24", "Paseo is offline");
  assert.deepEqual({ ...pendingAnswer("w1", "Q24"), at: 0 }, { choice: "other", words: "Cap retries at 5", at: 0, error: "Paseo is offline" });
  clearPendingAnswer("w1", "Q24");
  assert.equal(pendingAnswer("w1", "Q24"), undefined);
});

test("pending answers survive a reload where localStorage exists, and an unconfirmed one comes back as not sent", async () => {
  const data = new Map<string, string>();
  const g = globalThis as { localStorage?: unknown };
  const before = g.localStorage;
  g.localStorage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } };
  try {
    const first = await import(`../client/pending-answers.ts?first=${Date.now()}`) as typeof import("../client/pending-answers");
    first.setPendingAnswer("w1", "Q7", { choice: "B" });
    const reloaded = await import(`../client/pending-answers.ts?reload=${Date.now()}`) as typeof import("../client/pending-answers");
    const back = reloaded.pendingAnswer("w1", "Q7");
    assert.equal(back?.choice, "B");
    assert.match(back?.error ?? "", /reloaded before Paseo confirmed/);
  } finally { g.localStorage = before; }
});

// Harness (2026-11-10): after a failed send the question dialog said Not sent, but the panel's Needs-you row didn't.
test("every surface that describes a question says when its answer wasn't sent", async () => {
  const source = await readFile(join(import.meta.dirname, "..", "client", "questions.tsx"), "utf8");
  assert.match(source, /export function meanwhile\(w: Workspace, q: Question, pending: PendingAnswer \| null \| undefined\)/, "the pending answer is a required argument");
  const row = await readFile(join(import.meta.dirname, "..", "client", "needs-you.tsx"), "utf8");
  assert.match(row, /const pending = usePendingAnswer\(w\.id, questionId\);[\s\S]*meanwhile\(w, q, pending\)/);
  for (const f of (await readdir(join(import.meta.dirname, "..", "client"))).filter(f => f.endsWith(".tsx"))) {
    const text = await readFile(join(import.meta.dirname, "..", "client", f), "utf8");
    for (const m of text.matchAll(/meanwhile\(([^)]*)\)/g)) if (!m[1].startsWith("w: Workspace")) assert.equal(m[1].split(",").length, 3, `${f}: meanwhile(${m[1]}) must pass the pending answer`);
  }
});

test("the question card shows Not sent · Retry and the pill skips an answer on its way", async () => {
  const source = await readFile(join(import.meta.dirname, "..", "client", "questions.tsx"), "utf8");
  assert.match(source, /Not sent · \{unsent\.error\}/);
  assert.match(source, /accessibilityLabel=\{`Retry sending your \$\{q\.id\} answer`\}/);
  assert.match(source, /isOpen\(q\) && !\(pending\[pendingKey\(w\.id, q\.id\)\] && !pending\[pendingKey\(w\.id, q\.id\)\]\.error\)/);
});
