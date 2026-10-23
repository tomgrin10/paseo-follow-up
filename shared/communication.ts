import { z } from "zod";

function slackMessage(value: string) {
  try {
    const url = new URL(value);
    const path = /^\/archives\/([A-Z0-9]+)\/p(\d{11,})$/.exec(url.pathname);
    if (url.protocol !== "https:" || !/^[a-z0-9-]+\.slack\.com$/.test(url.hostname) || url.port || url.username || url.password || !path) return null;
    const root = url.searchParams.get("thread_ts");
    if (root && !/^\d+\.\d{6}$/.test(root)) return null;
    return { host: url.hostname, channel: path[1], message: path[2], root: root?.replace(".", "") ?? path[2], explicitRoot: !!root };
  } catch { return null; }
}

const messageUrl = z.string().max(2000).refine(value => !!slackMessage(value), "Use an HTTPS Slack message permalink.");
export const communicationSchema = z.object({
  threadUrl: messageUrl,
  recipient: z.string().trim().min(1).max(200),
  purpose: z.enum(["progress", "verified"]).default("progress"),
  authorization: z.string().trim().max(2000).default(""),
  replyUrl: messageUrl.nullable().default(null),
});
export type Communication = z.infer<typeof communicationSchema>;

export function communicationKey(c: Communication): string {
  const source = slackMessage(c.threadUrl)!;
  return `${source.host}/${source.channel}/${source.root}/${c.recipient}/${c.purpose}`;
}
export function replyRecorded(c: Communication): boolean {
  const source = slackMessage(c.threadUrl), reply = c.replyUrl && slackMessage(c.replyUrl);
  return !!source && !!reply && source.host === reply.host && source.channel === reply.channel && source.root !== reply.message && (!reply.explicitRoot || source.root === reply.root);
}
export function communicationReady(c?: Communication): boolean {
  return !c || !!c.authorization.trim() && !c.replyUrl;
}
