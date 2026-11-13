/**
 * Put in chat (Paseo 0.16): the developer's answer goes into the asking agent's composer, ready to read over and send,
 * instead of round-tripping through the clipboard. Paseo 0.15 has no composer controls; the card keeps Copy.
 *
 * Invariant put-in-chat-never-rewrites-a-draft: whatever the developer already typed in that composer stays exactly
 * as it is. Paseo's `setPrompt` replaces the whole draft, so it is never called. The composer is focused with the
 * cursor at the end of its draft (Paseo opens the agent's tab first when it isn't on screen), and only then is the
 * answer inserted at that cursor, after a blank line when there is a draft. A second press finds the answer already
 * there and only focuses. When the composer can't be reached, nothing is inserted and the caller falls back to Copy.
 * The hook that finds the composer is client/put-in-chat.ts. Guarded by tests/put-in-chat.test.ts.
 */
export type ChatComposer = {
  readonly prompt: string;
  insertText(text: string): void;
  focus(options?: { selection?: { start: number; end: number } }): Promise<void>;
};

/** What goes between the developer's draft and the answer: nothing on an empty draft, else enough to leave a blank line. */
export function separator(draft: string): string {
  if (!draft.trim()) return "";
  return draft.endsWith("\n\n") ? "" : draft.endsWith("\n") ? "\n" : "\n\n";
}

/**
 * Puts `text` at the end of the composer's draft and leaves the cursor after it. Rejects (having inserted nothing) when
 * the composer can't be focused: the agent is gone, or its chat didn't come on screen.
 */
export async function putInChat(composer: ChatComposer, text: string): Promise<"inserted" | "already-there"> {
  const before = composer.prompt;
  await composer.focus({ selection: { start: before.length, end: before.length } });
  const draft = composer.prompt;
  if (draft.includes(text)) return "already-there";
  composer.insertText(`${separator(draft)}${text}`);
  return "inserted";
}

/**
 * The card's Put in chat: the answer goes into the chat and is recorded there (`inChat`), or, when the composer can't
 * be reached, nothing was inserted and the answer is copied instead (`copy`), so the developer never loses it.
 */
export async function putInChatOrCopy(composer: ChatComposer, text: string, on: { inChat(): void; copy(): void }): Promise<"inserted" | "already-there" | "copied"> {
  let result: "inserted" | "already-there";
  try { result = await putInChat(composer, text); } catch { on.copy(); return "copied"; }
  on.inChat();
  return result;
}
