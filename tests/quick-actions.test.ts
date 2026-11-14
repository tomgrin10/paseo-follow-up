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

test("Send, Copy and Put in chat on a question close the dialog before the server answers", async () => {
  const source = await readFile(join(import.meta.dirname, "..", "client", "questions.tsx"), "utf8");
  const quick = /const quick = \(action: "send" \| "copy" \| "chat"\) => \{([\s\S]*?)\n  \};/.exec(source);
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
    assert.equal(error.message, "Answer to Q24 not sent", "with Open, the toast is one line; the reason waits on the card Open returns to");
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
    assert.deepEqual(host, ["show:Later · Tomorrow 9:00", "error:Stop following didn't work. offline."]);
    assert.equal(reopened, 1);
  } finally { bindToast(null); }
});

test("runUndoable: Undo inside the window sends nothing; otherwise the work runs once the toast goes", async t => {
  const { runUndoable, toastsNow, hosts, dismissToast } = await store();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  hosts.push(97);
  try {
    const sent: string[] = []; let undone = 0;
    const spec = { label: "Done", run: async () => { sent.push("Done: Rotate the key"); }, success: "Marked done", failure: "Done not sent" };
    runUndoable("Marked done", spec, () => { undone++; });
    const toast = toastsNow().at(-1)!;
    assert.equal(toast.message, "Marked done"); assert.deepEqual(toast.actions.map(a => a.label), ["Undo"]);
    toast.actions[0].onPress(); dismissToast(toast.id);
    t.mock.timers.tick(6_100); await new Promise(r => setImmediate(r));
    assert.deepEqual(sent, [], "undone: the agent never hears it"); assert.equal(undone, 1);
    runUndoable("Marked done", spec, () => { undone++; });
    assert.deepEqual(sent, [], "nothing goes out while Undo is on screen");
    t.mock.timers.tick(6_100); await new Promise(r => setImmediate(r));
    assert.deepEqual(sent, ["Done: Rotate the key"]);
    assert.equal(toastsNow().some(x => x.message === "Marked done" && x.actions.length === 0), false, "no second toast after the send");
  } finally { hosts.splice(hosts.indexOf(97), 1); for (const x of toastsNow()) dismissToast(x.id); t.mock.timers.reset(); }
});

test("runUndoable with no ToastHost: no Undo to offer, so it sends at once and the host toast confirms", async () => {
  const { runUndoable } = await store();
  const host: string[] = []; const sent: string[] = [];
  runUndoable("Marked done", { label: "Done", run: async () => { sent.push("x"); }, success: "Marked done", failure: "Done not sent", toast: { show: m => { host.push(m); }, error: () => undefined } }, () => undefined);
  await new Promise(r => setImmediate(r));
  assert.deepEqual(sent, ["x"]); assert.deepEqual(host, ["Marked done"]);
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
  assert.match(source, /export function meanwhile\(w: ListWorkspace, q: ListQuestion, pending: PendingAnswer \| null \| undefined\)/, "the pending answer is a required argument");
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

// Harness (2026-11-10): the Needs-you row read "No question Q999 in this workspace.. Open it to retry". Reasons arrive as
// full sentences (or not), so a reason followed by more text goes through sentence(), never a bare `${reason}.`.
test("a failure reason followed by more text ends in exactly one stop", async () => {
  const { sentence } = await import("../shared/errors");
  assert.equal(sentence("No question Q999 in this workspace."), "No question Q999 in this workspace.");
  assert.equal(sentence("Daemon offline"), "Daemon offline.");
  assert.equal(sentence("Is it running?  "), "Is it running?");
  for (const dir of ["client", "shared"]) for (const f of (await readdir(join(import.meta.dirname, "..", dir))).filter(f => /\.tsx?$/.test(f))) {
    const text = await readFile(join(import.meta.dirname, "..", dir, f), "utf8");
    for (const m of text.matchAll(/\$\{([^}]*)\}\.\s/g)) assert.doesNotMatch(m[1], /error|reason/i, `${dir}/${f}: \${${m[1]}}. can double the stop; use sentence()`);
  }
});

// ---------- 1.4.0-beta.59 polish ----------

// The error toast was twice the width of Paseo's own ("Answer to Q1 not sent. No question Q999 in this workspace." plus
// Retry, Open and ✕ filled the 480 px boundary and wrapped). With Open, the reason lives on the surface Open returns to,
// so the toast says only what failed; without Open the reason stays, in at most two lines.
test("an error toast stays as narrow as the host's: one line with Open, the reason on the surface", async () => {
  const { runAction, toastsNow, hosts, dismissToast } = await store();
  hosts.push(97);
  try {
    await runAction({ label: "Later", run: async () => { throw new Error("Request failed: daemon offline requestType=x"); }, success: null });
    assert.equal(toastsNow().at(-1)?.message, "Later didn't work. daemon offline.", "no surface to return to: the reason stays");
  } finally { hosts.splice(hosts.indexOf(97), 1); for (const t of toastsNow()) dismissToast(t.id); }
  const view = await readFile(join(import.meta.dirname, "..", "client", "toasts.tsx"), "utf8");
  assert.match(view, /numberOfLines=\{opens \? 2 : undefined\}>\{item\.message\}/, "a short Open toast clamps; the only copy of a reason never does");
  assert.match(view, /<View style=\{\{ flexShrink: 0 \}\}><Icon name=\{icon\}/, "the icon never shrinks beside a wrapping message");
  // Every caller with Open keeps the reason where Open lands.
  for (const f of (await readdir(join(import.meta.dirname, "..", "client"))).filter(f => f.endsWith(".tsx"))) {
    const text = await readFile(join(import.meta.dirname, "..", "client", f), "utf8");
    for (const m of text.matchAll(/run(?:Action|Undoable)\(([\s\S]*?)\n\s*\}\)?[,;)]/g)) if (/\bopen: /.test(m[1]))
      assert.match(m[1], /onError: [^\n]*(errorText|failPendingAnswer)\(/, `${f}: an action with Open records the reason on its surface in onError`);
  }
});

// Ctrl/Cmd+Z undoes while an Undo toast is showing, and only then: never inside a text field, never with Shift (redo).
test("Ctrl/Cmd+Z runs the visible toast's Undo, and nothing else", async () => {
  const { pushToast, undoShortcut, toastsNow, dismissToast } = await store();
  const key = (o: Partial<{ key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; target: unknown }>) => ({ key: "z", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, target: null, ...o });
  assert.equal(undoShortcut(key({ ctrlKey: true }), false), false, "no Undo toast: the key is left alone");
  let undone = 0;
  const id = pushToast("info", "Telling the agent it's done", [{ label: "Undo", onPress: () => { undone++; } }], { durationMs: 60_000, keep: true });
  try {
    assert.equal(undoShortcut(key({ metaKey: true }), false), false, "Cmd is the Mac key, not Windows'");
    assert.equal(undoShortcut(key({ ctrlKey: true, shiftKey: true }), false), false, "Shift+Z is redo");
    assert.equal(undoShortcut(key({ ctrlKey: true, target: { tagName: "TEXTAREA" } }), false), false, "typing keeps its own undo");
    assert.equal(undoShortcut(key({ ctrlKey: true, target: { tagName: "DIV", isContentEditable: true } }), false), false);
    assert.equal(undone, 0);
    assert.equal(undoShortcut(key({ ctrlKey: true }), false), true);
    assert.equal(undone, 1); assert.equal(toastsNow().some(t => t.id === id), false, "the toast goes, like pressing Undo");
    assert.equal(undoShortcut(key({ ctrlKey: true }), false), false, "only once");
    pushToast("info", "x", [{ label: "Undo", onPress: () => { undone++; } }], { durationMs: 60_000 });
    assert.equal(undoShortcut(key({ ctrlKey: true }), true), false, "Ctrl+Z on a Mac isn't undo");
    assert.equal(undoShortcut(key({ key: "Z", metaKey: true }), true), true); assert.equal(undone, 2);
  } finally { for (const t of toastsNow()) dismissToast(t.id); }
  const view = await readFile(join(import.meta.dirname, "..", "client", "toasts.tsx"), "utf8");
  assert.match(view, /addEventListener\("keydown"/, "the toast layer listens for the key");
  assert.match(view, /if \(undoShortcut\(e, mac\)\) \{ e\.preventDefault\(\); e\.stopPropagation\(\); \}/, "the host's own undo never sees the same press");
});

// 1.4.0-beta.62: on a Hebrew (or any non-Latin) layout, Ctrl+Z reports e.key "ז", so the Undo shortcut never fired.
// The physical key (e.code "KeyZ") stands in when e.key isn't a Latin letter; a Latin layout's own letter still wins,
// so AZERTY/Dvorak users press the key labelled Z, not whatever sits where QWERTY's Z is.
test("the Undo shortcut works on non-Latin layouts through e.code, and only there", async () => {
  const { pushToast, undoShortcut, toastsNow, dismissToast } = await store();
  const key = (o: Record<string, unknown>) => ({ key: "z", code: "KeyZ", metaKey: false, ctrlKey: true, shiftKey: false, altKey: false, target: null, ...o }) as Parameters<typeof undoShortcut>[0];
  let undone = 0;
  const push = () => pushToast("info", "Telling the agent it's done", [{ label: "Undo", onPress: () => { undone++; } }], { durationMs: 60_000, keep: true });
  try {
    push(); assert.equal(undoShortcut(key({ key: "ז" }), false), true, "Hebrew layout: ז on KeyZ"); assert.equal(undone, 1);
    push(); assert.equal(undoShortcut(key({ key: "я", code: "KeyZ" }), false), true, "Cyrillic layout"); assert.equal(undone, 2);
    push(); assert.equal(undoShortcut(key({ key: "ז", metaKey: true, ctrlKey: false }), true), true, "Mac, Hebrew"); assert.equal(undone, 3);
    push();
    assert.equal(undoShortcut(key({ key: "w", code: "KeyZ" }), false), false, "a Latin layout's own letter wins (AZERTY's W sits on KeyZ)");
    assert.equal(undoShortcut(key({ key: "ז", code: "KeyX" }), false), false, "another physical key isn't Z");
    assert.equal(undoShortcut(key({ key: "z", code: "KeyY" }), false), true, "QWERTZ: the letter z is z wherever it sits"); assert.equal(undone, 4);
  } finally { for (const t of toastsNow()) dismissToast(t.id); }
});
