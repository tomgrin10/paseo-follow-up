import { prReference, prRowStatus } from "../shared/pr-status";
import { View } from "react-native";
import { PagedRows } from "./paged-list";
import { Pressable, Text } from "./text";
import { openExternalUrl } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import type { Pr, Workspace } from "../shared/model";
import { compactPrStatus, githubWaitLine, orderedStacks, settledForDisplay } from "../shared/presentation";
import { githubOffLine } from "../shared/github-setup";
import { mergeQueued, prTone, quietFold, stackOrder, type StackItem } from "../shared/attention";
import { reviewersMissing } from "../shared/pr-workflow";
import { isGithubFlow } from "../shared/pr-actions";
import { Card, FoldRow, text, type Theme } from "./kit";
import { Spinner } from "./motion";
import { mergedColor, tint, toneColor, type Colors } from "./theme";
import { RichText } from "./rich-text";
import { HeldMerges } from "./merge-button";
import { Marked, NoMatchRow, useSectionSearch, ViaLine } from "./section-search";
import { prFields } from "../shared/section-search";
import type { ItemHit } from "../shared/search";

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

export function PrRow({ pr, theme, first, last, workspaceRepo, onOpen, compact, wide = false, hit }: { pr: Pr; theme: Theme; first: boolean; last: boolean; workspaceRepo?: string | null; onOpen: (key: string) => void; compact: boolean; wide?: boolean;
  /** A section search hit (prFields: title, number, then hidden branch and checks). */
  hit?: ItemHit }) {
  const c = theme.colors; const t = text(c);
  const s = pr.snapshot;
  const { label } = prRowStatus(pr);
  const line = c.border;
  const extras = [
    s?.state === "OPEN" && reviewersMissing(pr) ? "No reviewers" : null,
    s?.state === "OPEN" && s.mergeWhenReady === "on" && !mergeQueued(pr) ? isGithubFlow(s) ? "Auto-merge" : "Merge when ready" : null,
  ].filter(Boolean) as string[];
  const titleText = s?.title ?? `${pr.repo} pull request`;
  const titleStyle = [t.body, s?.state !== "OPEN" && s ? { color: c.foregroundMuted } : null];
  const title = hit ? <Marked numberOfLines={2} text={titleText} ranges={s?.title ? hit.ranges[0] : undefined} theme={theme} style={titleStyle} /> : <Text numberOfLines={2} style={titleStyle}>{titleText}</Text>;
  const ref = prReference(pr, workspaceRepo);
  const offset = ref.length - `#${pr.number}`.length;
  const number = hit ? <Marked text={ref} ranges={hit.ranges[1]?.map(([start, end]) => [start + offset, end + offset])} theme={theme} style={null} /> : ref;
  return <Pressable accessibilityRole="button" accessibilityLabel={`Pull request ${pr.number}: ${ref.startsWith("#") ? "" : `${pr.repo}. `}${s?.title ?? pr.stack}. ${label}. Open details`} onPress={() => onOpen(pr.key)}
    style={state => ({ flexDirection: "row", gap: 10, paddingHorizontal: 12, minHeight: compact ? 52 : 44, backgroundColor: state.pressed ? c.surface2 : (state as { hovered?: boolean }).hovered ? c.surface1 : "transparent" })}>
    <View style={{ width: NODE, alignItems: "center" }}>
      <View style={{ width: 2, height: 10, backgroundColor: first ? "transparent" : line }} />
      <Node pr={pr} colors={c} />
      <View style={{ width: 2, flex: 1, minHeight: 4, backgroundColor: last ? "transparent" : line }} />
    </View>
    {/* Wide views give each row a status column, so states line up; long titles wrap once. */}
    {wide ? <>
      <View style={{ flex: 1, minWidth: 0, paddingVertical: 8, gap: 2 }}>
        {title}
        {hit?.via ? <ViaLine via={hit.via} theme={theme} compact={compact} /> : <Text numberOfLines={1} style={t.meta}>{number}{extras.map(e => ` · ${e}`).join("")}</Text>}
      </View>
      <View style={{ width: 120, paddingTop: 8, alignItems: "flex-end" }}>
        <Text numberOfLines={1} style={[t.meta, { color: statusColor(c, pr), fontWeight: "600" }]}>{label}</Text>
      </View>
    </> : <View style={{ flex: 1, minWidth: 0, paddingVertical: 8, gap: 2 }}>
      {title}
      {hit?.via ? <ViaLine via={hit.via} theme={theme} compact={compact} /> : <Text numberOfLines={1} style={t.meta}>
        <Text style={{ fontVariant: ["tabular-nums"] }}>{number}</Text>
        {" · "}<Text style={{ color: statusColor(c, pr), fontWeight: "600" }}>{label}</Text>
        {extras.map(e => <Text key={e}>{` · ${e}`}</Text>)}
      </Text>}
    </View>}
    <View style={{ paddingTop: 11 }}><Icon name="ChevronRight" size={14} color={c.foregroundMuted} /></View>
  </Pressable>;
}

function StackRows({ name, prs, theme, open, toggle, onOpen, compact, workspaceRepo, settled, wide, hits }: { name: string; prs: Pr[]; theme: Theme; open: (key: string) => boolean; toggle: (key: string) => void; onOpen: (key: string) => void; compact: boolean; workspaceRepo?: string | null; settled: boolean; wide: boolean;
  /** While searching: only these PRs show, merged ones in place (the fold is ignored). */
  hits: Map<Pr, ItemHit> | null }) {
  const c = theme.colors; const t = text(c);
  // Graphite's orientation: the top of the stack first, its base (merged first) at the bottom.
  const ordered = stackOrder(prs).reverse();
  const done = ordered.filter(settledForDisplay);
  const active = ordered.filter(p => !settledForDisplay(p));
  const foldKey = `merged:${name}`;
  const showDone = settled || open(foldKey);
  const rows = hits ? ordered.filter(p => hits.has(p)) : settled ? ordered : [...active, ...(showDone ? done : [])];
  const fold = !hits && !settled && done.length > 0;
  // A long stack folds its quiet runs (a-long-stack-shows-its-problems); a search shows its hits as they are.
  const items: StackItem<Pr>[] = hits || settled ? rows.map(pr => ({ kind: "pr", pr })) : [...quietFold(active, open), ...(showDone ? done : []).map(pr => ({ kind: "pr" as const, pr }))];
  if (!rows.length) return null;
  const merged = prs.filter(p => p.snapshot?.state === "MERGED").length;
  return <View style={{ borderTopWidth: 1, borderTopColor: c.border }}>
    <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8, paddingHorizontal: 12, paddingTop: 9, paddingBottom: 3 }}>
      <Text numberOfLines={1} style={[t.label, { flex: 1, fontSize: 12, lineHeight: 17 }]}>{name}</Text>
      <Text style={[t.small, { fontVariant: ["tabular-nums"] }]}>{settled ? `${prs.length} PR${prs.length === 1 ? "" : "s"}` : `${merged} of ${prs.length} merged`}</Text>
    </View>
    {/* A stack's rows page (client/paged-list.tsx); the rail's ends are the stack's own, so it runs on across a page break. */}
    <PagedRows items={items} resetKey={hits ? "search" : ""} theme={theme} compact={compact} noun="PRs" row={(item, i) => {
      const first = i === 0, last = i === items.length - 1 && !fold;
      if (item.kind === "pr") return <PrRow key={item.pr.key} pr={item.pr} theme={theme} first={first} last={last} workspaceRepo={workspaceRepo} onOpen={onOpen} compact={compact} wide={wide} hit={hits?.get(item.pr)} />;
      const expanded = open(item.key), n = item.prs.length;
      const range = `#${item.prs[0]!.number} to #${item.prs.at(-1)!.number}`;
      return <Pressable key={item.key} accessibilityRole="button" aria-expanded={expanded} accessibilityState={{ expanded }} accessibilityLabel={`${expanded ? "Hide" : "Show"} ${n} PRs in review, ${range}, in ${name}`} onPress={() => toggle(item.key)}
        style={state => ({ flexDirection: "row", gap: 10, paddingHorizontal: 12, minHeight: compact ? 44 : 32, backgroundColor: state.pressed ? c.surface2 : (state as { hovered?: boolean }).hovered ? c.surface1 : "transparent" })}>
        {/* The node and the words sit on the row's middle (the rail runs through both ends), and the ring and chevron
            take the in-review nodes' muted ink, not the border's, so the fold reads as a row you can open. */}
        <View style={{ width: NODE, alignItems: "center" }}>
          <View style={{ width: 2, flex: 1, minHeight: 4, backgroundColor: first ? "transparent" : c.border }} />
          <View style={{ width: NODE, height: NODE, borderRadius: NODE / 2, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: c.foregroundMuted, backgroundColor: c.surface0 }}>
            <Icon name={expanded ? "ChevronUp" : "ChevronsUpDown"} size={12} color={c.foregroundMuted} />
          </View>
          <View style={{ width: 2, flex: 1, minHeight: 4, backgroundColor: last ? "transparent" : c.border }} />
        </View>
        <View style={{ flex: 1, justifyContent: "center", paddingVertical: 4 }}>
          <Text style={[t.meta, { color: c.foreground, fontVariant: ["tabular-nums"] }]}>{expanded ? `Hide ${n} in review` : `+${n} in review`}<Text style={{ color: c.foregroundMuted }}>{` · #${item.prs[0]!.number}–#${item.prs.at(-1)!.number}`}</Text></Text>
        </View>
      </Pressable>;
    }} />
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

/** Stacks on one page of the Pull requests card; each stack pages its own rows. */
export const STACKS_PER_PAGE = 10;

export function StacksCard({ workspace: w, theme, compact, open, toggle, onOpen, wide = false }: { workspace: Workspace; theme: Theme; compact: boolean; open: (key: string) => boolean; toggle: (key: string) => void; onOpen: (key: string) => void; wide?: boolean }) {
  const c = theme.colors; const t = text(c);
  const stacks = orderedStacks(w.prs);
  const active = stacks.filter(s => !s.prs.every(settledForDisplay));
  const settled = stacks.filter(s => s.prs.every(settledForDisplay));
  const openCount = w.prs.filter(p => p.snapshot?.state === "OPEN").length;
  const inFlight = w.prActions.filter(a => a.state === "sending");
  // One slot for why the statuses below may be missing or behind: GitHub off (works-without-github), else the budget.
  const off = githubOffLine(w.githubOff);
  const wait = off ?? githubWaitLine(w, Date.now());
  const settledOpen = open("settled");
  const settledPrs = settled.reduce((n, s) => n + s.prs.length, 0);
  // Every PR in the order the card draws them, settled stacks included: the search's "n of N" and its filter.
  const search = useSectionSearch(w.id, "prs", { theme, compact, items: [...active, ...settled].flatMap(s => stackOrder(s.prs).reverse()), fields: prFields });
  const hits = search.hits;
  // Stacks page too (client/paged-list.tsx): a long-lived workspace keeps hundreds of settled ones. A search pages only
  // the stacks with a hit, so no page is empty.
  const stackRows = (list: typeof stacks, isSettled: boolean) => <PagedRows items={hits ? list.filter(s => s.prs.some(p => hits.has(p))) : list} size={STACKS_PER_PAGE} resetKey={search.query ?? ""} theme={theme} compact={compact} noun="stacks"
    row={s => <StackRows key={s.name} name={s.name} prs={s.prs} theme={theme} open={open} toggle={toggle} onOpen={onOpen} compact={compact} workspaceRepo={w.repo} settled={isSettled} wide={wide} hits={hits} />} />;
  return <Card theme={theme} compact={compact} icon="GitPullRequest" title="Pull requests" count={openCount ? `${openCount} open` : undefined} right={search.button} search={search.header}>
    {hits && !hits.size && <NoMatchRow section="prs" query={search.query!} theme={theme} compact={compact} />}
    {!hits && inFlight.map(a => <View key={a.id} style={{ flexDirection: "row", gap: 8, paddingHorizontal: 12, paddingVertical: 8, borderTopWidth: 1, borderTopColor: c.border }}>
      <View style={{ paddingTop: 3 }}><Spinner color={c.accent} size={12} /></View>
      <RichText style={[t.meta, { flex: 1, color: c.foreground }]}>{a.result || (isGithubFlow(w.prs.find(p => p.key === a.prs[0])?.snapshot) ? "Sending to GitHub…" : "Submitting to Graphite…")}</RichText>
    </View>)}
    {!hits && wait && <View accessible accessibilityLabel={wait.label} style={{ flexDirection: "row", gap: 8, paddingHorizontal: 12, paddingVertical: 8, borderTopWidth: 1, borderTopColor: c.border }}>
      <View style={{ paddingTop: 2 }}><Icon name={off ? "CircleMinus" : "CirclePause"} size={13} color={c.foregroundMuted} /></View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[t.meta, { color: c.foreground, fontVariant: ["tabular-nums"] }]}>{wait.title}</Text>
        <Text style={t.meta}>{wait.detail}</Text>
        {off?.url && <Pressable accessibilityRole="link" accessibilityLabel="Get the GitHub CLI (opens cli.github.com)" onPress={() => void openExternalUrl(off.url!).catch(() => undefined)} hitSlop={compact ? 10 : 6} style={{ alignSelf: "flex-start", minHeight: compact ? 44 : undefined, justifyContent: "center" }}>
          <Text style={[t.meta, { color: c.accent }]}>Get the GitHub CLI</Text>
        </Pressable>}
      </View>
    </View>}
    {!hits && <HeldMerges workspace={w} theme={theme} compact={compact} framed />}
    {!hits && !w.prs.length && <View style={{ paddingHorizontal: 12, paddingVertical: 10, borderTopWidth: 1, borderTopColor: c.border, gap: 4 }}>
      <Text style={t.body}>No PRs yet</Text>
      <Text style={t.meta}>The main agent registers each PR it opens, and Follow-up also picks up PRs submitted from this workspace's sessions.</Text>
    </View>}
    {stackRows(active, false)}
    {hits && stackRows(settled, true)}
    {!hits && settled.length > 0 && <>
      <FoldRow theme={theme} compact={compact} open={settledOpen} onPress={() => toggle("settled")} icon="Archive" iconColor={c.foregroundMuted}
        label={`${settled.length} settled stack${settled.length === 1 ? "" : "s"} · ${settledPrs} PR${settledPrs === 1 ? "" : "s"}`} />
      {settledOpen && stackRows(settled, true)}
    </>}
  </Card>;
}
