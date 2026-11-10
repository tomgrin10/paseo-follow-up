import { useState, useSyncExternalStore } from "react";
import { browserKey, BROWSER_POLL_MS } from "./keys";
import { useWorkspace } from "./workspace-data";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { useRpc, type PluginButtonContentProps, type PluginButtonIconProps, type PluginButtonRegistration, type PluginClientContext } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { browserStatusRpc } from "../shared/contracts";
import { needsYou, type NeedItem } from "../shared/attention";
import { briefQuestionIds, HEADLINE_ICON, HEADLINE_TONE, pillState, todoLabel, withoutBriefQuestions, type PillState } from "../shared/headline";
import { snoozeUntil, type InboxRow } from "../shared/inbox";
import { laterChoices } from "../shared/row-menu";
import { isOpen as questionOpen } from "../shared/questions";
import type { Workspace } from "../shared/model";
import { Button, errorText, text, type Theme } from "./kit";
import { headlineColor, withAlpha } from "./theme";
import { useInbox } from "./inbox";
import type { InboxStore } from "./inbox-store";
import type { LiveStore } from "./live";
import { NeedsYouList } from "./needs-you";
import { PrSheet } from "./pr-sheet";
import { QuestionSheet, QuestionStepper } from "./questions";
import { useReviewerSettings } from "./reviewers";

export const PILL_ID = "follow-up";


type Deps = { inbox: InboxStore; live: LiveStore; openPanel: (workspaceId: string) => void; openNext: (from: string) => void };
type Target = { agentId: string; workspaceId: string; row: InboxRow | null; workspace: Workspace | null; items: NeedItem[] };

/** Every agent that may carry the pill: inbox rows with a workspace, plus each tracked workspace's main agent. */
export function targets(rows: InboxRow[], workspaces: Workspace[], now: number): Map<string, Target> {
  const out = new Map<string, Target>();
  for (const row of rows) if (row.workspaceId) out.set(row.agentId, { agentId: row.agentId, workspaceId: row.workspaceId, row, workspace: null, items: [] });
  for (const w of workspaces) {
    if (!w.mainAgentId) continue;
    const items = needsYou(w, now);
    const known = out.get(w.mainAgentId);
    if (known && known.workspaceId === w.id) { known.workspace = w; known.items = items; }
    else if (!known && items.length) out.set(w.mainAgentId, { agentId: w.mainAgentId, workspaceId: w.id, row: null, workspace: w, items });
  }
  return out;
}

const stateFor = (t: Target | undefined, recent: { agentIds: string[]; at: number } | null, now: number): PillState =>
  t ? pillState({ row: t.row, items: t.items, recent, now }) : null;

function useTarget(deps: Deps, agentId: string, workspaceId: string) {
  useReviewerSettings();
  useSyncExternalStore(deps.live.subscribe, deps.live.version, deps.live.version);
  useInbox(deps.inbox, () => deps.inbox.version());
  const now = Date.now();
  const row = deps.inbox.rows().find(r => r.agentId === agentId) ?? null;
  const w = deps.live.get(workspaceId) ?? null;
  const items = w && w.mainAgentId === agentId ? needsYou(w, now) : [];
  const target: Target = { agentId, workspaceId, row, workspace: w, items };
  return { target, state: stateFor(target, deps.inbox.recent(), now), now };
}

/**
 * Follow-up's one composer pill. It exists only while something needs you on this agent, leads with the
 * decisive word ("Decision 4m", "Merge #812", "2 questions"), and opens one popover with the sign-off,
 * Later… and, when relevant, the workspace's questions and PR actions.
 */
export function contributeFollowUpPill(client: PluginClientContext, deps: Deps) {
  const { inbox, live } = deps;
  const pills = new Map<string, { workspaceId: string; key: string; pill: PluginButtonRegistration }>();
  let undoTimer: ReturnType<typeof setTimeout> | null = null;

  function PillIcon(props: PluginButtonIconProps) {
    const agentId = props.context === "agent" ? props.agentId : "";
    const { state } = useTarget(deps, agentId, props.workspaceId);
    const c = props.theme.colors;
    if (!state || state.mode === "undo") return <Icon name="Undo2" size={props.size} color={c.foregroundMuted} />;
    return <Icon name={HEADLINE_ICON[state.headline.key]} size={props.size} color={headlineColor(HEADLINE_TONE[state.headline.key], c)} />;
  }

  const Content = (props: PluginButtonContentProps) => <PillPopover {...props} deps={deps} />;

  const publish = () => {
    const now = Date.now();
    const recent = inbox.recent();
    const wanted = new Map<string, { target: Target; state: Exclude<PillState, null> }>();
    for (const [agentId, target] of targets(inbox.rows(), live.all(), now)) {
      const state = stateFor(target, recent, now);
      if (state) wanted.set(agentId, { target, state });
    }
    for (const [agentId, entry] of pills) {
      const next = wanted.get(agentId);
      if (!next || next.target.workspaceId !== entry.workspaceId) { entry.pill.remove(); pills.delete(agentId); }
    }
    for (const [agentId, { target, state }] of wanted) try {
      const undo = state.mode === "undo";
      const label = undo ? state.label : state.headline.label;
      // The tooltip (and accessible name) says whose pill it is and what kind of ask. On phones the host shows it as the
      // sheet's title right above the popover, which carries the ask itself in full, so the title doesn't repeat it.
      const title = undo ? "Follow-up: signed off. Open to undo." : `Follow-up · ${state.headline.label}${state.todo && state.mode === "flag" ? ` · ${todoLabel(withoutBriefQuestions(target.items, target.row))} in this workspace` : ""}`;
      const key = `${state.mode}|${label}|${title}`;
      // Always a popover, Undo included: Paseo 0.16 draws a chevron on popover pills, so switching kinds for the undo
      // window made the chevron and the pill's width jump (tests/pill-popover.test.ts).
      const button = { title, label, behavior: { kind: "popover" as const, Content } };
      const entry = pills.get(agentId);
      if (!entry) pills.set(agentId, { workspaceId: target.workspaceId, key, pill: client.addComposerPill({ id: PILL_ID, workspaceId: target.workspaceId, agentId, button: { ...button, icon: PillIcon } }) });
      else if (entry.key !== key) { entry.pill.update(button); entry.key = key; }
    } catch { /* One agent's pill must never hide the others. */ }
    if (recent && now - recent.at < 6_000) { if (undoTimer) clearTimeout(undoTimer); undoTimer = setTimeout(publish, 6_000 - (Date.now() - recent.at) + 50); }
  };
  const offInbox = inbox.subscribe(publish);
  const offLive = live.subscribe(publish);
  // Ages count up between polls.
  const ticker = setInterval(publish, 60_000);
  publish();
  return () => { offInbox(); offLive(); clearInterval(ticker); if (undoTimer) clearTimeout(undoTimer); for (const p of pills.values()) p.pill.remove(); pills.clear(); };
}

function Chip({ title, onPress, theme, compact }: { title: string; onPress: () => void; theme: Theme; compact: boolean }) {
  const c = theme.colors;
  return <Pressable accessibilityRole="button" accessibilityLabel={`Later: ${title}`} onPress={onPress} hitSlop={compact ? 0 : 3}
    style={(s: { pressed: boolean; hovered?: boolean }) => ({ minHeight: compact ? 44 : 26, paddingHorizontal: compact ? 14 : 9, borderRadius: 999, borderWidth: 1, borderColor: c.border, alignItems: "center", justifyContent: "center", backgroundColor: s.pressed || s.hovered ? c.surface2 : "transparent" })}>
    <Text numberOfLines={1} style={{ color: c.foreground, fontSize: compact ? 13 : 12, lineHeight: compact ? 18 : 16 }}>{title}</Text>
  </Pressable>;
}

function FooterLink({ title, icon, onPress, theme, compact, hint }: { title: string; icon: string; onPress: () => void; theme: Theme; compact: boolean; hint?: string }) {
  const c = theme.colors;
  return <Pressable accessibilityRole="button" accessibilityLabel={title} accessibilityHint={hint} onPress={onPress} hitSlop={compact ? 0 : 4}
    style={(s: { pressed: boolean; hovered?: boolean }) => ({ flexDirection: "row", alignItems: "center", gap: 5, minHeight: compact ? 44 : 26, paddingHorizontal: 6, borderRadius: 6, backgroundColor: s.pressed || s.hovered ? c.surface2 : "transparent" })}>
    <Icon name={icon} size={13} color={c.foregroundMuted} />
    <Text numberOfLines={1} style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 16 }}>{title}</Text>
  </Pressable>;
}


/**
 * The popover. Paseo mounts popover content twice on web (#9103) and may leave a stray copy (#7235), so it
 * does no work on mount beyond shared, de-duplicated queries; every write is a click, and the inbox store
 * drops a second sign-off or snooze for the same agent while the first is in flight.
 */
export function PillPopover(props: PluginButtonContentProps & { deps: Deps }) {
  const { deps } = props;
  const agentId = props.context === "agent" ? props.agentId : "";
  const touch = props.layout.compact;
  const c = props.theme.colors; const t = text(c, touch);
  const { target, state, now } = useTarget(deps, agentId, props.workspaceId);
  const browserRead = useRpc(browserStatusRpc);
  const main = !!target.workspace && target.workspace.mainAgentId === agentId;
  // The live store already holds this workspace; the popover reads it once on open (Paseo can leave a stray mounted
  // copy, so nothing here polls it: 1.4.0).
  const query = useWorkspace(deps.live, props.workspaceId, { enabled: main });
  const browser = useQuery({ queryKey: browserKey, queryFn: () => browserRead({}), refetchInterval: BROWSER_POLL_MS, enabled: main });
  const [sheet, setSheet] = useState<{ key: string; intent: "merge" | "reviewers" } | null>(null);
  const [question, setQuestion] = useState<string | null>(null);
  const w = main ? query.workspace ?? target.workspace : null;
  const row = target.row;
  const flagged = state?.mode === "flag";
  const running = !!row && ["running", "initializing"].includes(row.status);
  // The flagged brief's own decision is its ask above; don't repeat it as Q1 in the stepper or the count.
  const asked = briefQuestionIds(row);
  const asking = !!w?.questions.some(q => questionOpen(q) && !asked.has(q.id));
  const items = w ? withoutBriefQuestions(needsYou(w, now), row) : [];
  const done = (work: () => void) => { props.close(); work(); };
  const headline = state && state.mode !== "undo" ? state.headline : null;
  // Phones: one primary per sheet. While the workspace has something to act on, that's the primary and Sign off steps back.
  const itemFirst = touch && !!w && (asking || items.length > 0);
  const tone = headline ? headlineColor(HEADLINE_TONE[headline.key], c) : c.foregroundMuted;

  // The 6 s after a sign-off: the pill stays a popover, and Undo is its one action.
  if (state?.mode === "undo") return <View style={{ width: 380, maxWidth: "100%", gap: 10, marginTop: touch ? -12 : 0 }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
      <Icon name="Check" size={14} color={c.foregroundMuted} />
      <Text style={t.meta}>Signed off. It leaves Needs you in a few seconds.</Text>
    </View>
    <View style={{ flexDirection: "row" }}>
      <Button theme={props.theme} compact={touch} grow={touch} kind="primary" icon="Undo2" title="Undo" accessibilityHint="Puts this agent back in Needs you"
        onPress={() => done(() => void deps.inbox.undo([agentId]))} />
    </View>
  </View>;

  return <View style={{ width: 380, maxWidth: "100%", gap: 12, marginTop: touch ? -12 : 0 }}>
    {/* 1. The ask, in one line. */}
    {headline ? <View style={{ gap: 3 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
        <Icon name={HEADLINE_ICON[headline.key]} size={14} color={tone} />
        {/* Phones: the host's sheet title already says "Follow-up · <label>", so the meta line doesn't repeat it. */}
        {touch
          ? <Text style={t.small}>{main ? "Main agent" : "This agent"}{flagged && state.todo > 0 ? ` · ${todoLabel(items.length ? items : withoutBriefQuestions(target.items, row))} in this workspace` : ""}</Text>
          : <>
            <Text style={{ color: tone, fontSize: 12, lineHeight: 16, fontWeight: "600" }}>{headline.label}</Text>
            {flagged && state.todo > 0 && <Text style={t.small}>· {todoLabel(items.length ? items : withoutBriefQuestions(target.items, row))} in this workspace</Text>}
          </>}
      </View>
      <Text numberOfLines={touch ? 3 : 2} style={touch ? t.ask : { color: c.foreground, fontSize: 14, lineHeight: 20, fontWeight: "600" }}>{headline.line}</Text>
    </View> : <Text style={t.meta}>Nothing needs you here right now.</Text>}

    {/* 2. Sign off, with "& next" beside it, then Later. Only for a flagged agent. */}
    {flagged && <View style={{ gap: 10 }}>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Button theme={props.theme} compact={touch} grow={touch} kind={itemFirst ? "secondary" : "primary"} icon="Check" title="Sign off" accessibilityHint="Clears this agent from Needs you"
          onPress={() => done(() => void deps.inbox.signOff([agentId]))} />
        <Button theme={props.theme} compact={touch} grow={touch} icon="ArrowRight" title="Sign off & next"
          onPress={() => done(() => { void deps.inbox.signOff([agentId]); deps.openNext(agentId); })} />
      </View>
      {touch
        // Phones: one row that scrolls sideways, never a second line of chips.
        ? <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text style={t.meta}>Later</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flex: 1 }} contentContainerStyle={{ gap: 6, paddingRight: 8 }}>
            {laterChoices(new Date()).map(([id, title]) => <Chip key={id} title={title.replace(/^In 1 hour$/, "1 hour")} theme={props.theme} compact onPress={() => done(() => void deps.inbox.snooze([agentId], snoozeUntil(id, new Date())))} />)}
          </ScrollView>
        </View>
        : <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
          <Text style={[t.meta, { marginRight: 2 }]}>Later</Text>
          {laterChoices(new Date()).map(([id, title]) => <Chip key={id} title={title} theme={props.theme} compact={touch} onPress={() => done(() => void deps.inbox.snooze([agentId], snoozeUntil(id, new Date())))} />)}
        </View>}
    </View>}

    {/* 3. The workspace's own items, only when there are some. */}
    {w && (asking || items.length > 0) && <View style={{ gap: 8, paddingTop: flagged ? 12 : 0, borderTopWidth: flagged ? 1 : 0, borderTopColor: c.border }}>
      {flagged && <Text style={touch ? t.section : [t.small, { fontWeight: "600" }]}>In this workspace · {todoLabel(items)}</Text>}
      {asking
        ? <QuestionStepper workspace={w} theme={props.theme} compact={touch} bodyMaxHeight={touch ? undefined : 200} onDetails={setQuestion} onAnswered={() => deps.live.refresh()} />
        : <NeedsYouList workspace={w} theme={props.theme} compact={touch} flush feature={touch}
          actions={{ after: () => deps.live.refresh(), openPr: (key, intent) => setSheet({ key, intent }), openQuestion: setQuestion }} />}
      {asking && items.some(i => i.kind !== "question") && <Text numberOfLines={2} style={t.small}>Also: {items.filter(i => i.kind !== "question").map(i => i.title).join(" · ")}</Text>}
      <PrSheet workspace={w} prKey={sheet?.key ?? null} intent={sheet?.intent ?? null} theme={props.theme} compact={touch} browserReady={browser.data?.ready ?? false} onClose={() => { setSheet(null); deps.live.refresh(); }} />
      <QuestionSheet workspace={w} questionId={question} theme={props.theme} compact={touch} onClose={() => { setQuestion(null); deps.live.refresh(); }} />
    </View>}
    {main && !w && query.error && <Text style={t.meta}>Couldn't read Follow-up: {errorText(query.error)}</Text>}

    {/* 4. Quiet footer. */}
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 2, rowGap: 0, marginHorizontal: -6, paddingTop: 8, borderTopWidth: 1, borderTopColor: withAlpha(c.border, 0.8) }}>
      {flagged && running && <FooterLink theme={props.theme} compact={touch} icon="BellOff" title="Sign off & mute this turn" onPress={() => done(() => void deps.inbox.signOff([agentId], { muteTurn: true }))} />}
      {row && <FooterLink theme={props.theme} compact={touch} icon={row.enable_finish_flags ? "BellMinus" : "Bell"} title={row.enable_finish_flags ? "Don't flag finishes" : "Flag finishes again"}
        hint="Permission prompts and errors still flag this agent" onPress={() => void deps.inbox.setFinishFlags(agentId, !row.enable_finish_flags)} />}
      <View style={{ flex: 1 }} />
      <FooterLink theme={props.theme} compact={touch} icon="PanelRight" title="Open Follow-up" onPress={() => done(() => deps.openPanel(props.workspaceId))} />
    </View>
  </View>;
}
