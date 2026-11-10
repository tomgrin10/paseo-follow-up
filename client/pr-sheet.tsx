import { Text, View } from "react-native";
import { openExternalUrl } from "@getpaseo/plugin/client";
import { Icon, Modal } from "@getpaseo/plugin/client/ui";
import type { Workspace } from "../shared/model";
import { compactPrStatus, graphitePrUrl } from "../shared/presentation";
import { ago, prTone, stackOrder } from "../shared/attention";
import { Button, Chip, text, type Theme } from "./kit";
import { PrControls } from "./pr-controls";
import { toneColor } from "./theme";

function Fact({ icon, color, children, theme }: { icon: string; color?: string; children: React.ReactNode; theme: Theme }) {
  const c = theme.colors;
  return <View style={{ flexDirection: "row", gap: 9 }}>
    <View style={{ paddingTop: 2 }}><Icon name={icon} size={14} color={color ?? c.foregroundMuted} /></View>
    <Text selectable style={[text(c).meta, { flex: 1, color: color ?? c.foregroundMuted }]}>{children}</Text>
  </View>;
}

/** Everything about one PR, with its merge and reviewer controls. A sheet on phones, a dialog on desktop. */
export function PrSheet({ workspace: w, prKey, intent, theme, compact, browserReady, onClose }: { workspace: Workspace; prKey: string | null; intent: "merge" | "reviewers" | null; theme: Theme; compact: boolean; browserReady: boolean; onClose: () => void }) {
  const c = theme.colors; const t = text(c, compact);
  const pr = w.prs.find(p => p.key === prKey) ?? null;
  const s = pr?.snapshot;
  const open = (url: string) => { void openExternalUrl(url).catch(() => undefined); };
  const status = pr ? compactPrStatus(pr) : null;
  const tone = pr ? prTone(pr) : "unknown";
  const stack = pr ? stackOrder(w.prs.filter(p => p.stack === pr.stack)) : [];
  const parent = pr?.parent ? w.prs.find(p => p.key === pr.parent) : null;
  const reviewers = s?.reviewers?.complete ? [...new Set([...s.reviewers.requested, ...s.reviewers.teams.map(team => `team/${team}`), ...s.reviewers.reviewed])] : [];
  return <Modal title={pr ? `Pull request #${pr.number}` : "Pull request"} icon={<Icon name={tone === "merged" ? "GitMerge" : "GitPullRequest"} size={18} color={toneColor(c, tone)} />} open={!!pr} onOpenChange={next => { if (!next) onClose(); }}>
    <Modal.Content contentContainerStyle={{ padding: compact ? 16 : 20, gap: compact ? 16 : 14, ...(compact ? { paddingBottom: 24 } : null) }}>
      {pr && <>
        <View style={{ gap: 6 }}>
          <Text selectable style={compact ? t.title : [t.title, { fontSize: 16, lineHeight: 22 }]}>{s?.title ?? `${pr.repo} pull request`}</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
            {status && <Chip theme={theme} label={status.label} color={toneColor(c, tone === "pending" || tone === "draft" ? "unknown" : tone)} />}
            <Text style={t.meta}>{pr.repo} · {pr.stack}{stack.length > 1 ? ` · ${stack.indexOf(pr) + 1} of ${stack.length}` : ""}</Text>
          </View>
        </View>
        <View style={{ gap: 8 }}>
          {pr.error && <Fact theme={theme} icon="TriangleAlert" color={c.statusWarning}>{pr.error}</Fact>}
          {parent && <Fact theme={theme} icon="CornerLeftDown">Stacked on #{parent.number} · {parent.snapshot?.title ?? parent.stack}</Fact>}
          {s?.conflict && <Fact theme={theme} icon="TriangleAlert" color={c.statusDanger}>Conflicts with its base branch</Fact>}
          {!!s?.failedChecks.length && <Fact theme={theme} icon="CircleX" color={c.statusDanger}>Required checks failed: {s.failedChecks.join(", ")}</Fact>}
          {!!s?.otherFailedChecks?.length && <Fact theme={theme} icon="CircleX" color={c.statusWarning}>Optional checks failed (not required to merge): {s.otherFailedChecks.join(", ")}</Fact>}
          {s?.state === "OPEN" && s.checksPending && <Fact theme={theme} icon="LoaderCircle">Required checks are still running</Fact>}
          {!!s?.threads.length && <Fact theme={theme} icon="MessageSquare" color={c.statusWarning}>{s.threads.length} unresolved review thread{s.threads.length === 1 ? "" : "s"}</Fact>}
          {s?.reviewDecision === "CHANGES_REQUESTED" && <Fact theme={theme} icon="MessageSquareWarning" color={c.statusWarning}>Changes requested</Fact>}
          {reviewers.length > 0 && <Fact theme={theme} icon="Users">Reviewers: {reviewers.join(", ")}</Fact>}
          {s?.deployment?.environment && <Fact theme={theme} icon="Rocket">{s.deployment.evidence}</Fact>}
          {s?.observedAt && <Fact theme={theme} icon="Clock">Checked {ago(s.observedAt)}</Fact>}
        </View>
        {s?.state === "OPEN" && <View style={{ paddingTop: 12, borderTopWidth: 1, borderTopColor: c.border }}>
          <PrControls key={`${pr.key}:${intent ?? ""}`} pr={pr} workspace={w} theme={theme} compact={compact} browserReady={browserReady} intent={intent} />
        </View>}
        {/* Phones: the links split the row evenly. GitHub-mode repositories have no Graphite link; GitHub is the link. */}
        <View style={{ flexDirection: "row", flexWrap: compact ? "nowrap" : "wrap", gap: 8, paddingTop: 12, borderTopWidth: 1, borderTopColor: c.border }}>
          {s?.prWorkflow !== "github" && <View style={compact ? { flex: 1 } : undefined}><Button theme={theme} compact={compact} grow={compact} icon="ExternalLink" title="Open in Graphite" accessibilityLabel={`Open ${pr.repo} pull request ${pr.number} in Graphite`} onPress={() => open(graphitePrUrl(pr))} /></View>}
          {s?.url && s.prWorkflow === "github" && <View style={compact ? { flex: 1 } : undefined}><Button theme={theme} compact={compact} grow={compact} icon="ExternalLink" title="Open on GitHub" accessibilityLabel={`Open ${pr.repo} pull request ${pr.number} on GitHub`} onPress={() => open(s.url)} /></View>}
          {s?.url && s.prWorkflow !== "github" && <View style={compact ? { flex: 1 } : undefined}><Button theme={theme} compact={compact} grow={compact} kind={compact ? "secondary" : "ghost"} icon="Github" title="GitHub" accessibilityLabel={`Open ${pr.repo} pull request ${pr.number} on GitHub`} onPress={() => open(s.url)} /></View>}
        </View>
      </>}
    </Modal.Content>
  </Modal>;
}
