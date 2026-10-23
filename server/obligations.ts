import { randomUUID } from "node:crypto";
import type { Obligation, Workspace } from "../shared/model";
import { lifecycleOnly } from "../shared/follow-up";
import { communicationKey, communicationSchema, replyRecorded, type Communication } from "../shared/communication";
import type { TaskTrigger } from "../shared/task-trigger";

type Update = {
  id?: string; title: string; status: Obligation["status"]; afterPrs?: string[]; evidence?: string;
  dependencyStage?: "merged" | "deployed"; enable_follow_up?: boolean; communication?: Pick<Communication, "threadUrl" | "recipient"> & Partial<Communication>;
  trigger?: TaskTrigger | null;
};
export function updateObligation(w: Workspace, input: Update): Obligation {
  const { id, title, status, dependencyStage, enable_follow_up, communication } = input;
  const existing = id ? w.obligations.find(o => o.id === id) : communication ? w.obligations.find(o => o.communication && !["done", "waived"].includes(o.status) && communicationKey(o.communication) === communicationKey(communicationSchema.parse(communication))) : undefined;
  if (id && !existing) throw new Error("Obligation does not exist. Omit id to add one.");
  const afterPrs = input.afterPrs ?? existing?.afterPrs ?? [];
  const evidence = input.evidence ?? existing?.evidence ?? "";
  if (["done", "waived"].includes(status) && !(existing?.status === status ? evidence.trim() : input.evidence?.trim())) throw new Error("Completed or waived work requires result evidence.");
  if (afterPrs.some(key => !w.prs.some(p => p.key === key))) throw new Error("Register dependency PRs before referencing them.");
  if (lifecycleOnly({ title, afterPrs })) throw new Error("PR approval, merging and deployment belong in Pull requests. Record a concrete follow-through action such as verifying behavior after deployment, with afterPrs and dependencyStage=deployed.");
  const destination = communication ? communicationSchema.parse({ ...existing?.communication, ...communication }) : existing?.communication;
  if (destination?.replyUrl && !replyRecorded(destination)) throw new Error("The reply receipt must be a different message in the original Slack workspace/channel/thread.");
  if (destination && status === "done" && !replyRecorded(destination)) throw new Error("A draft is not a sent reply. Record communication.replyUrl before completing this task; use blocked when posting is unavailable or uncertain.");
  const trigger = input.trigger === undefined ? existing?.trigger : input.trigger;
  if (trigger?.event === "now" && (afterPrs.length || trigger.delayDays)) throw new Error("Now requires no PR dependencies or delay. Choose a merge/deploy trigger for delayed work.");
  if (trigger && trigger.event !== "now" && !afterPrs.length) throw new Error("Select at least one owned PR for a merge/deploy trigger.");
  const stage = trigger?.event === "merge" ? "merged" : trigger?.event === "deploy" ? "deployed" : dependencyStage ?? existing?.dependencyStage ?? "deployed";
  const followUp = enable_follow_up ?? (input.trigger !== undefined ? !!trigger : existing?.enable_follow_up ?? false);
  const record = { title, status, afterPrs, evidence: evidence || (destination ? `Reply to ${destination.recipient}: ${destination.threadUrl}` : ""), enable_follow_up: followUp, dependencyStage: stage, category: "follow_up" as const, ...(destination ? { communication: destination } : {}), ...(trigger !== undefined ? { trigger } : {}) };
  if (existing) {
    const reopened = ["done", "waived", "blocked"].includes(existing.status) && ["pending", "waiting"].includes(status);
    if (reopened || existing.title !== title || JSON.stringify(existing.afterPrs) !== JSON.stringify(afterPrs) || existing.dependencyStage !== stage || JSON.stringify(existing.communication) !== JSON.stringify(destination) || JSON.stringify(existing.trigger) !== JSON.stringify(trigger) || existing.enable_follow_up !== followUp) existing.revision++;
    Object.assign(existing, record); return existing;
  }
  const added = { ...record, id: randomUUID(), revision: 0 };
  w.obligations.push(added); return added;
}
