import { Compass } from "../../server/compass";
import { trackPersistence } from "./store-temp-dir";
import { SourceDirectory } from "../../server/source-tools";
import type { Runner } from "../../server/ai-jobs";

/**
 * A fake mcpproxy with a chat server (found by its tools' shapes, never its name) and a fake model, for Compass's
 * tests. Fictional people only: Dana (product), Avi (a teammate), the developer.
 */
export const DEV = "U0000DEV1";
export const DANA = "U0000DANA";
export const AVI = "U0000AVI1";

const tool = (name: string, props: string[], description = "") => ({ server_name: "talk", name, description, schema: { properties: Object.fromEntries(props.map(p => [p, { type: "string" }])), required: [] }, annotations: { readOnlyHint: true } });
export const CHAT_TOOLS = (history = true) => [
  tool("talk_search_messages", ["query", "filters", "sort", "limit"], `Search messages. Current logged in user's user_id is ${DEV}.`),
  tool("talk_search_channels", ["query", "limit"]),
  tool("talk_search_users", ["query", "limit"]),
  tool("talk_read_thread", ["channel_id", "message_ts"]),
  ...(history ? [tool("talk_read_channel", ["channel_id", "oldest", "limit", "cursor"])] : []),
];

export type Msg = { by: string; name: string; at: string; text: string };
/** The history tool's text form: "=== Message from Name (ID) at … ===", "Message TS:", the text. */
export const historyText = (msgs: readonly Msg[]) => JSON.stringify({ messages: `Channel: DM\n\n${[...msgs].reverse().map(m => `=== Message from ${m.name} (${m.by}) at ${m.at.replace("T", " ").slice(0, 19)} UTC === \nMessage TS: ${(Date.parse(m.at) / 1000).toFixed(6)}\n${m.text}`).join("\n\n")}`, pagination_info: "" });

/** The fake mcpproxy: discovery lists `tools`; each tool-read is recorded and answered by `answer`. */
export function fakeMcpproxy(opts: { tools?: ReturnType<typeof CHAT_TOOLS>; answer: (tool: string, args: Record<string, unknown>) => string }) {
  const calls: { tool: string; args: Record<string, unknown>; sub: string }[] = [];
  const run = async (_command: string, argv: string[]) => {
    if (argv[0] === "tools") return JSON.stringify(opts.tools ?? CHAT_TOOLS());
    if (argv[0] === "upstream") return "[]";
    const name = argv.find(a => a.startsWith("--tool-name="))!.slice(12);
    const args = JSON.parse(argv.find(a => a.startsWith("--json_args="))!.slice(12)) as Record<string, unknown>;
    calls.push({ tool: name, args, sub: argv[1] });
    return JSON.stringify({ content: [{ text: opts.answer(name, args) }] });
  };
  return { tools: new SourceDirectory(run), calls };
}

/** A fake model: records each prompt, answers with `reply(prompt)` as `claude -p` would. */
export function fakeModel(reply: (prompt: string) => unknown): { runner: Runner; prompts: string[] } {
  const prompts: string[] = [];
  const runner: Runner = async input => { prompts.push(input.prompt); return { text: JSON.stringify(reply(input.prompt)), costUsd: 0, inputTokens: 10, outputTokens: 10 }; };
  return { runner, prompts };
}

/** Keep background reads alive until completion before the shared temp-dir helper removes their files. */
export function testCompass(directory: string, deps: ConstructorParameters<typeof Compass>[0]): Compass {
  const compass = new Compass(deps);
  trackPersistence(directory, { flush: () => compass.idle() });
  return compass;
}
