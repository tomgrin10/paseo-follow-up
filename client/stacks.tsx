import { Pressable, Text, View } from "react-native";
import { Icon } from "@getpaseo/plugin/client/ui";
import type { Pr, Workspace } from "../shared/model";
import { compactPrStatus, orderedStacks, settledForDisplay } from "../shared/presentation";
import { mergeQueued, prTone, stackOrder } from "../shared/attention";
import { noReviewers } from "../shared/reviewers";
import { Card, FoldRow, text, type Theme } from "./kit";
import { Spinner } from "./motion";
import { mergedColor, tint, toneColor, type Colors } from "./theme";

const NODE = 16;

/** The rail node: the same state colour as the PR's stack-bar segment. */
function Node({ pr, colors }: { pr: Pr; colors: Colors }) {
  const tone = prTone(pr);
  const s = pr.snapshot;
  const color = toneColor(colors, tone);
  const ring = { width: NODE, height: NODE, borderRadius: NODE / 2, alignItems: "center" as const, justifyContent: "center" as const };
  if (tone === "pending") {
    if (s?.checksPending) return <View style={[ring, { borderWidth: 1.5, borderColor: colors.border, backgroundColor: colors.surface0 }]}><Spinner color={colors.foregroundMuted} size={9} label="Checks running" /></View>;
    return <View style={[ring, { borderWidth: 1.5, borderColor: colors.foregroundMuted, backgroundColor: colors.surface0 }]} />;
  }
  if (tone === "draft") return <View style={[ring, { borderWidth: 1.5, borderStyle: "dashed", borderColor: colors.foregroundMuted, backgroundColor: colors.surface0 }]} />;
  const icon = tone === "merged" ? "GitMerge" : tone === "approved" ? (mergeQueued(pr) ? "Clock" : "Check") : tone === "danger" ? (s?.conflict ? "TriangleAlert" : "X") : tone === "warning" ? (s?.threads.length || s?.reviewDecision === "CHANGES_REQUESTED" ? "MessageSquare" : "X") : tone === "closed" ? "X" : "CircleHelp";
  return <View style={[ring, { backgroundColor: colors.surface0 }]}><View style={[ring, { backgroundColor: tint(color, colors) }]}><Icon name={icon} size={10} color={color} /></View></View>;
}

function statusColor(colors: Colors, pr: Pr) {
  const { tone } = compactPrStatus(pr);
  return tone === "merged" ? mergedColor(colors) : tone === "approved" ? colors.statusSuccess : tone === "warning" ? (prTone(pr) === "danger" ? colors.statusDanger : colors.statusWarning) : colors.foregroundMuted;
}

export function PrRow({ pr, theme, first, last, showRepo, onOpen, compact }: { pr: Pr; theme: Theme; first: boolean; last: boolean; showRepo: boolean; onOpen: (key: string) => void; compact: boolean }) {
  const c = theme.colors; const t = text(c);
  const s = pr.snapshot;
  const status = compactPrStatus(pr);
  const label = mergeQueued(pr) ? "Queued to merge" : status.label;
  const line = c.border;
  const extras = [
    s?.state === "OPEN" && noReviewers(pr) ? "No reviewers" : null,
    s?.state === "OPEN" && s.mergeWhenReady === "on" && !mergeQueued(pr) ? "Merge when ready" : null,
  ].filter(Boolean) as string[];
  return <Pressable accessibilityRole="button" accessibilityLabel={`Pull request ${pr.number}: ${s?.title ?? pr.stack}. ${label}. Open details`} onPress={() => onOpen(pr.key)}
    style={state => ({ flexDirection: "row", gap: 10, paddingHorizontal: 12, minHeight: compact ? 52 : 44, backgroundColor: state.pressed ? c.surface2 : (state as { hovered?: boolean }).hovered ? c.surface1 : "transparent" })}>
    <View style={{ width: NODE, alignItems: "center" }}>
      <View style={{ width: 2, height: 10, backgroundColor: first ? "transparent" : line }} />
      <Node pr={pr} colors={c} />
      <View style={{ width: 2, flex: 1, minHeight: 4, backgroundColor: last ? "transparent" : line }} />
    </View>
    <View style={{ flex: 1, minWidth: 0, paddingVertical: 8, gap: 2 }}>
      <Text numberOfLines={2} style={[t.body, s?.state !== "OPEN" && s ? { color: c.foregroundMuted } : null]}>{s?.title ?? `${pr.repo} pull request`}</Text>
      <Text numberOfLines={1} style={t.meta}>
        <Text style={{ fontVariant: ["tabular-nums"] }}>{showRepo ? `${pr.repo.split("/")[1]} ` : ""}#{pr.number}</Text>
        {" · "}<Text style={{ color: statusColor(c, pr), fontWeight: "600" }}>{label}</Text>
        {extras.map(e => <Text key={e}>{` · ${e}`}</Text>)}
      </Text>
    </View>
    <View style={{ paddingTop: 11 }}><Icon name="ChevronRight" size={14} color={c.foregroundMuted} /></View>
  </Pressable>;
}

function StackRows({ name, prs, theme, open, toggle, onOpen, compact, showRepo, settled }: { name: string; prs: Pr[]; theme: Theme; open: (key: string) => boolean; toggle: (key: string) => void; onOpen: (key: string) => void; compact: boolean; showRepo: boolean; settled: boolean }) {
  const c = theme.colors; const t = text(c);
  // Graphite's orientation: the top of the stack first, its base (merged first) at the bottom.
  const ordered = stackOrder(prs).reverse();
  const done = ordered.filter(settledForDisplay);
  const active = ordered.filter(p => !settledForDisplay(p));
  const foldKey = `merged:${name}`;
  const showDone = settled || open(foldKey);
  const rows = settled ? ordered : [...active, ...(showDone ? done : [])];
  const fold = !settled && done.length > 0;
  const merged = prs.filter(p => p.snapshot?.state === "MERGED").length;
  return <View style={{ borderTopWidth: 1, borderTopColor: c.border }}>
    <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8, paddingHorizontal: 12, paddingTop: 9, paddingBottom: 3 }}>
      <Text numberOfLines={1} style={[t.label, { flex: 1, fontSize: 12, lineHeight: 17 }]}>{name}</Text>
      <Text style={[t.small, { fontVariant: ["tabular-nums"] }]}>{settled ? `${prs.length} PR${prs.length === 1 ? "" : "s"}` : `${merged} of ${prs.length} merged`}</Text>
    </View>
    {rows.map((pr, i) => <PrRow key={pr.key} pr={pr} theme={theme} first={i === 0} last={i === rows.length - 1 && !fold} showRepo={showRepo} onOpen={onOpen} compact={compact} />)}
    {fold && <Pressable accessibilityRole="button" aria-expanded={showDone} accessibilityState={{ expanded: showDone }} accessibilityLabel={`${showDone ? "Hide" : "Show"} ${done.length} merged PR${done.length === 1 ? "" : "s"} in ${name}`} onPress={() => toggle(foldKey)}
      style={state => ({ flexDirection: "row", gap: 10, paddingHorizontal: 12, minHeight: compact ? 44 : 30, backgroundColor: state.pressed ? c.surface2 : (state as { hovered?: boolean }).hovered ? c.surface1 : "transparent" })}>
      <View style={{ width: NODE, alignItems: "center" }}>
        <View style={{ width: 2, height: 7, backgroundColor: c.border }} />
        <View style={{ width: NODE, height: NODE, borderRadius: NODE / 2, alignItems: "center", justifyContent: "center", backgroundColor: showDone ? c.surface0 : tint(mergedColor(c), c) }}>
          <Icon name={showDone ? "ChevronUp" : "GitMerge"} size={10} color={showDone ? c.foregroundMuted : mergedColor(c)} />
        </View>
      </View>
      <Text style={[t.meta, { paddingTop: 7, fontVariant: ["tabular-nums"] }]}>{showDone ? "Hide merged" : `${done.length} merged below`}</Text>
    </Pressable>}
    <View style={{ height: 6 }} />
  </View>;
}

export function StacksCard({ workspace: w, theme, compact, open, toggle, onOpen }: { workspace: Workspace; theme: Theme; compact: boolean; open: (key: string) => boolean; toggle: (key: string) => void; onOpen: (key: string) => void }) {
  const c = theme.colors; const t = text(c);
  const stacks = orderedStacks(w.prs);
  const active = stacks.filter(s => !s.prs.every(settledForDisplay));
  const settled = stacks.filter(s => s.prs.every(settledForDisplay));
  const showRepo = new Set(w.prs.map(p => p.repo)).size > 1;
  const openCount = w.prs.filter(p => p.snapshot?.state === "OPEN").length;
  const inFlight = w.prActions.filter(a => a.state === "sending");
  const settledOpen = open("settled");
  const settledPrs = settled.reduce((n, s) => n + s.prs.length, 0);
  return <Card theme={theme} compact={compact} icon="GitPullRequest" title="Pull requests" count={openCount ? `${openCount} open` : undefined}>
    {inFlight.map(a => <View key={a.id} style={{ flexDirection: "row", gap: 8, paddingHorizontal: 12, paddingVertical: 8, borderTopWidth: 1, borderTopColor: c.border }}>
      <View style={{ paddingTop: 3 }}><Spinner color={c.accent} size={12} /></View>
      <Text style={[t.meta, { flex: 1, color: c.foreground }]}>{a.result || "Submitting to Graphite…"}</Text>
    </View>)}
    {!w.prs.length && <View style={{ paddingHorizontal: 12, paddingVertical: 10, borderTopWidth: 1, borderTopColor: c.border, gap: 4 }}>
      <Text style={t.body}>No PRs yet</Text>
      <Text style={t.meta}>The main agent registers each PR it opens, and Follow-up also picks up PRs submitted from this workspace's sessions.</Text>
    </View>}
    {active.map(s => <StackRows key={s.name} name={s.name} prs={s.prs} theme={theme} open={open} toggle={toggle} onOpen={onOpen} compact={compact} showRepo={showRepo} settled={false} />)}
    {settled.length > 0 && <>
      <FoldRow theme={theme} open={settledOpen} onPress={() => toggle("settled")} icon="Archive" iconColor={c.foregroundMuted}
        label={`${settled.length} settled stack${settled.length === 1 ? "" : "s"} · ${settledPrs} PR${settledPrs === 1 ? "" : "s"}`} />
      {settledOpen && settled.map(s => <StackRows key={s.name} name={s.name} prs={s.prs} theme={theme} open={open} toggle={toggle} onOpen={onOpen} compact={compact} showRepo={showRepo} settled />)}
    </>}
  </Card>;
}
