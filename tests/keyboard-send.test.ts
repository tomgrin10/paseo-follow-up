import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

// Tom (2026-11-10): "when answering questions, I can't press command+enter to send (or enter for that matter)".
// Root cause: no card or sheet had a key handler, and the answer field is multiline, so Enter only added a newline.
// One SubmitScope (client/kit.tsx) now gives every dialog or card with a primary action Cmd/Ctrl+Enter, and plain
// Enter outside a field that uses Enter itself.

// kit.tsx imports react-native, so the pure rule is checked through a copy of its source, evaluated without RN.
async function submitKeyFn() {
  const src = await readFile(join(import.meta.dirname, "..", "client", "kit.tsx"), "utf8");
  const body = /export function submitKey\(([\s\S]*?)\): boolean \{([\s\S]*?)\n\}/.exec(src);
  assert.ok(body, "submitKey is exported from client/kit.tsx");
  const params = body[1].replace(/:\s*Pick<[^>]*>/, "").replace(/:\s*\{[^}]*\}/, "").replace(/:\s*boolean/, "");
  return new Function(...params.split(",").map(p => p.trim()), body[2]) as (e: object, target: object, mac: boolean) => boolean;
}
const key = (over: Record<string, unknown> = {}) => ({ key: "Enter", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, repeat: false, isComposing: false, ...over });

test("Cmd+Enter (Ctrl+Enter off a Mac) submits from anywhere, including the multiline answer field", async () => {
  const submitKey = await submitKeyFn();
  assert.equal(submitKey(key({ metaKey: true }), { tag: "TEXTAREA" }, true), true);
  assert.equal(submitKey(key({ ctrlKey: true }), { tag: "TEXTAREA" }, false), true);
  assert.equal(submitKey(key({ ctrlKey: true }), { tag: "TEXTAREA" }, true), false, "Ctrl+Enter on a Mac is not the shortcut");
  assert.equal(submitKey(key({ metaKey: true }), { tag: "BUTTON" }, true), true);
});

test("plain Enter submits only where nothing else uses Enter; repeats, Shift, Alt and IME never submit", async () => {
  const submitKey = await submitKeyFn();
  assert.equal(submitKey(key(), { tag: "DIV" }, true), true);
  assert.equal(submitKey(key(), { tag: "INPUT" }, true), true, "a single-line field submits on Enter");
  assert.equal(submitKey(key(), { tag: "TEXTAREA" }, true), false, "Enter is a newline in the answer field");
  for (const role of ["button", "link", "radio", "checkbox", "switch", "tab"]) assert.equal(submitKey(key(), { tag: "DIV", role }, true), false, role);
  assert.equal(submitKey(key({ repeat: true, metaKey: true }), { tag: "DIV" }, true), false);
  assert.equal(submitKey(key({ shiftKey: true }), { tag: "DIV" }, true), false);
  assert.equal(submitKey(key({ altKey: true, metaKey: true }), { tag: "DIV" }, true), false);
  assert.equal(submitKey(key({ isComposing: true }), { tag: "DIV" }, true), false);
  assert.equal(submitKey(key({ key: "a", metaKey: true }), { tag: "DIV" }, true), false);
});

// ---------- invariant: every dialog or card primary action is keyboard-sendable ----------

/** Primary actions that submit what the developer entered or picked in a dialog or card. */
const SUBMIT = /^(Send|Save|Request|Send answer|Send answers)\b/;
/** Primary buttons that are not a form's submit, with the reason. Keep this short and specific. */
const EXEMPT: Record<string, string> = {
  "needs-you.tsx:Send to main agent": "a list row's action (send queued repairs), not a dialog; Enter on the focused button already presses it",
};

function primaryButtons(source: string): { line: number; title: string; shortcut: boolean }[] {
  const out: { line: number; title: string; shortcut: boolean }[] = [];
  for (const m of source.matchAll(/<(Button|Btn)\b([^]*?)\/>/g)) {
    const props = m[2];
    const primary = m[1] === "Button" ? /kind="primary"|kind=\{[^}]*"primary"/.test(props) : /\bprimary\b/.test(props);
    if (!primary) continue;
    const title = /(?:title|label)=(?:"([^"]+)"|\{`([^`]+)`\}|\{([^}]+)\})/.exec(props);
    out.push({ line: source.slice(0, m.index).split("\n").length, title: (title?.[1] ?? title?.[2] ?? title?.[3] ?? "").trim(), shortcut: /\bshortcut\b/.test(props) });
  }
  return out;
}

test("every submit-style primary action in a dialog or card has the shortcut, inside a SubmitScope", async () => {
  const dir = join(import.meta.dirname, "..", "client");
  const missing: string[] = [];
  let wired = 0;
  for (const f of (await readdir(dir)).filter(f => f.endsWith(".tsx"))) {
    const source = await readFile(join(dir, f), "utf8");
    for (const b of primaryButtons(source)) {
      const literal = b.title.replace(/^busy === [^?]+\? "[^"]*" : /, "").replace(/^"|"$/g, "");
      const submits = SUBMIT.test(literal) || /^bar\.label$/.test(literal);
      if (b.shortcut) wired++;
      else if (submits && !EXEMPT[`${f}:${literal}`]) missing.push(`${f}:${b.line} ${literal}`);
    }
    if (/\bshortcut\b/.test(source) && f !== "kit.tsx") assert.match(source, /<SubmitScope\b/, `${f} marks a shortcut button but has no SubmitScope`);
  }
  assert.deepEqual(missing, [], "Wrap the dialog in <SubmitScope> and mark its primary Button with `shortcut`, or add an EXEMPT reason");
  assert.ok(wired >= 8, `only ${wired} wired actions found; the scan is broken`);
});
