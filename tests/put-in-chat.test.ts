import test from "node:test";
import assert from "node:assert/strict";
import { putInChat, putInChatOrCopy, type ChatComposer } from "../shared/put-in-chat";

/**
 * Invariant put-in-chat-never-rewrites-a-draft (shared/put-in-chat.ts). The fake composer behaves like Paseo 0.16's:
 * `focus` places the cursor (or rejects), `insertText` inserts at the cursor, `setPrompt` replaces everything, and
 * `onFocus` lets a test type a key while the composer comes on screen.
 */
function fakeComposer(draft = "", o: { cursor?: number; reject?: boolean; onFocus?: (c: Fake) => void } = {}) {
  const c = {
    prompt: draft, cursor: o.cursor ?? draft.length, setPrompts: 0, focuses: 0,
    insertText(text: string) { c.prompt = c.prompt.slice(0, c.cursor) + text + c.prompt.slice(c.cursor); c.cursor += text.length; },
    setPrompt(text: string) { c.setPrompts++; c.prompt = text; c.cursor = text.length; },
    type(key: string) { c.insertText(key); },
    async focus(options?: { selection?: { start: number; end: number } }) {
      c.focuses++;
      if (o.reject) throw new Error("The composer did not come on screen.");
      if (options?.selection) c.cursor = Math.min(options.selection.end, c.prompt.length);
      o.onFocus?.(c);
    },
  };
  return c;
}
type Fake = ReturnType<typeof fakeComposer>;
const ANSWER = "Follow-up answer Q1 (Retry declined cards?): A — Retry card_declined once after 24 hours";

test("an empty draft: the answer becomes the draft, with the cursor after it", async () => {
  const c = fakeComposer();
  assert.equal(await putInChat(c as ChatComposer, ANSWER), "inserted");
  assert.equal(c.prompt, ANSWER);
  assert.equal(c.cursor, ANSWER.length);
  assert.equal(c.setPrompts, 0);
});

test("a draft being typed, cursor mid-draft: the draft stays exactly, the answer follows a blank line, and a key typed meanwhile is kept", async () => {
  const draft = "Also check the retry cap before you merge";
  const c = fakeComposer(draft, { cursor: 10, onFocus: f => f.type("!") });
  await putInChat(c as ChatComposer, ANSWER);
  assert.equal(c.prompt, `${draft}!\n\n${ANSWER}`, "nothing the developer typed was moved, replaced or lost");
  assert.equal(c.setPrompts, 0, "setPrompt (which replaces the draft) is never called");
});

test("a draft ending in a newline gets just enough to leave one blank line", async () => {
  const c = fakeComposer("First line\n");
  await putInChat(c as ChatComposer, ANSWER);
  assert.equal(c.prompt, `First line\n\n${ANSWER}`);
});

test("a second press finds the answer already there and only focuses", async () => {
  const c = fakeComposer("Draft");
  await putInChat(c as ChatComposer, ANSWER);
  const once = c.prompt;
  assert.equal(await putInChat(c as ChatComposer, ANSWER), "already-there");
  assert.equal(c.prompt, once, "no duplicate");
  assert.equal(c.focuses, 2);
});

test("the composer can't be reached: nothing is inserted, the answer is copied instead, and nothing is recorded as in chat", async () => {
  const c = fakeComposer("My draft", { reject: true });
  const calls: string[] = [];
  const result = await putInChatOrCopy(c as ChatComposer, ANSWER, { inChat: () => calls.push("in-chat"), copy: () => calls.push("copy") });
  assert.equal(result, "copied");
  assert.deepEqual(calls, ["copy"]);
  assert.equal(c.prompt, "My draft");
  assert.equal(c.setPrompts, 0);
});

test("put in chat is recorded only once the answer is in the composer", async () => {
  const c = fakeComposer();
  const calls: string[] = [];
  await putInChatOrCopy(c as ChatComposer, ANSWER, { inChat: () => calls.push(`in-chat:${c.prompt === ANSWER}`), copy: () => calls.push("copy") });
  assert.deepEqual(calls, ["in-chat:true"]);
});

test("the agent's composer isn't on screen (the phone's Follow-up screen): focus reveals the agent's chat first, and the answer lands in its box, never into an unseen draft", async () => {
  // Paseo 0.16's focus() reveals the agent (w.reveal) and resolves once its composer is attached; insertText before
  // that would append to an off-screen draft the developer can't see.
  const draft = "Thanks, one more thing:";
  let revealed = false; const inserts: boolean[] = [];
  const c = fakeComposer(draft);
  const composer = {
    get prompt() { return c.prompt; },
    setPrompt: (t: string) => c.setPrompt(t),
    insertText: (t: string) => { inserts.push(revealed); c.insertText(t); },
    focus: async (o?: { selection?: { start: number; end: number } }) => { await new Promise(r => setTimeout(r, 5)); revealed = true; await c.focus(o); },
  };
  let recorded = "";
  assert.equal(await putInChatOrCopy(composer as ChatComposer, ANSWER, { inChat: () => { recorded = "in-chat"; }, copy: () => { recorded = "copied"; } }), "inserted");
  assert.deepEqual(inserts, [true], "inserted once, after the agent's chat came on screen");
  assert.equal(c.prompt, `${draft}\n\n${ANSWER}`);
  assert.equal(c.setPrompts, 0);
  assert.equal(recorded, "in-chat");
});
