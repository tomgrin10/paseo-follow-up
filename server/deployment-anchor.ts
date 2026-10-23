import type { Pr, Snapshot } from "../shared/model";
import { deployed } from "../shared/follow-up";

export function recordSnapshot(pr: Pr, snapshot: Snapshot, now: number): void {
  pr.snapshot = snapshot;
  if (snapshot.state !== "MERGED" || !snapshot.mergeCommit || pr.deploymentAnchor?.mergeCommit !== snapshot.mergeCommit || ["pending", "partial"].includes(snapshot.deployment?.state ?? "")) delete pr.deploymentAnchor;
  if (!pr.deploymentAnchor && snapshot.mergeCommit && deployed(pr, now)) pr.deploymentAnchor = { mergeCommit: snapshot.mergeCommit, at: snapshot.deployment!.observedAt };
}
