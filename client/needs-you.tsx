import { FINISH_ASK } from "../shared/status";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { Pressable, Text } from "./text";
import { Icon, useToast } from "@getpaseo/plugin/client/ui";
import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { checkPrActionRpc, controlRpc, sendRpc } from "../shared/contracts";
import { needsYou, shortRefs, workspaceSnoozed, type NeedItem } from "../shared/attention";
import { laterLabel } from "./inbox";
import { sameText } from "../shared/home";
import type { Workspace } from "../shared/model";
import { Button, Card, CardRow, Chip, errorText, text, type Theme } from "./kit";
import type { Colors } from "./theme";
import { QuestionBody, meanwhile } from "./questions";
import { needsYouBlock } from "../shared/needs-block";
import { age } from "../shared/inbox";
import { questionState } from "../shared/questions";
import type { Brief } from "../shared/brief";
import { useState, type ReactNode } from "react";
import { usePendingAnswer } from "./pending-answers";
import { useReviewerSettings } from "./reviewers";

import { overviewKey, workspaceKey } from "./keys";
import { RichText } from "./rich-text";
export { overviewKey, workspaceKey };

function glyph(item: NeedItem, colors: Colors): { name: string; color: string } {
  switch (item.kind) {
    case "hold": return { name: "CirclePause", color: colors.statusWarning };
    case "retry": return { name: "OctagonAlert", color: colors.statusDanger };
    case "capped": return { name: "CircleAlert", color: colors.statusWarning };
    case "check": return { name: "CircleHelp", color: colors.statusWarning };
    case "decision": return { name: "MessageCircleQuestion", color: colors.statusWarning };
    case "question": return { name: item.state === "stopped" ? "CirclePause" : "MessageCircleQuestion", color: colors.statusWarning };
    case "answer": return { name: "TriangleAlert", color: colors.statusWarning };
    case "send": return { name: item.finish ? "ListChecks" : "Send", color: colors.statusWarning };
    case "merge": return { name: "GitMerge", color: colors.statusSuccess };
    case "reviewers": return { name: "UserPlus", color: colors.foregroundMuted };
  }
}

export type NeedActions = {
  openAgent?: (agentId: string) => void;
  openPr?: (prKey: string, intent: "merge" | "reviewers") => void;
  openQuestion?: (questionId: string) => void;
  after?: () => void;
};

/** The developer's queue: one row per decision, each with its single action inline. `rows`: the block's rows (no questions); default every item. */
export function NeedsYouList({ workspace: w, theme, compact, actions, now = Date.now(), flush = false, rows }: { workspace: Workspace; theme: Theme; compact: boolean; actions: NeedActions; now?: number; flush?: boolean; rows?: readonly NeedItem[] }) {
  const c = theme.colors; const t = text(c, compact);
  useReviewerSettings();
  const toast = useToast();
  const cache = useQueryClient();
  const control = useRpc(controlRpc); const send = useRpc(sendRpc); const check = useRpc(checkPrActionRpc);
  const refresh = () => { void cache.invalidateQueries({ queryKey: workspaceKey(w.id) }); void cache.invalidateQueries({ queryKey: overviewKey }); };
  const fail = (error: Error) => { toast.error(errorText(error)); refresh(); };
  const resume = useMutation({ mutationFn: () => control({ workspaceId: w.id, clearHold: true }), onSuccess: () => { toast.show("Follow-up resumed", { variant: "success" }); refresh(); actions.after?.(); }, onError: fail });
  const retry = useMutation({ mutationFn: (batchId: string) => control({ workspaceId: w.id, retryBatchId: batchId }), onSuccess: () => { toast.show("Queued again"); refresh(); actions.after?.(); }, onError: fail });
  const retryTask = useMutation({ mutationFn: (taskKey: string) => control({ workspaceId: w.id, retryTask: taskKey }), onSuccess: () => { toast.show("Queued for the next message"); refresh(); actions.after?.(); }, onError: fail });
  // Say what actually happened to the batch: delivery can be deferred or unconfirmed without an error.
  const deliver = useMutation({ mutationFn: (batchId: string) => send({ workspaceId: w.id, batchId }), onSuccess: (result, batchId) => {
    const b = result.batches.find(x => x.id === batchId);
    if (!b || ["sent", "sending", "completed"].includes(b.state)) toast.show("Sent to the main agent", { variant: "success" });
    else if (b.state === "uncertain") toast.show("Delivery wasn't confirmed. Check the agent before retrying.", { variant: "warning" });
    else if (b.state === "pending") toast.show("Queued. It goes out when the agent is free.", { variant: "info" });
    else toast.error(b.result || "The message couldn't be sent.");
    refresh(); actions.after?.();
  }, onError: fail });
  const inspect = useMutation({ mutationFn: (actionId: string) => check({ workspaceId: w.id, actionId }), onSuccess: reply => { toast.show(reply.result, { variant: reply.state === "failed" ? "warning" : "info" }); refresh(); }, onError: fail });
  const items = rows ?? needsYou(w, now);
  if (!items.length) return null;
  const busy = resume.isPending || retry.isPending || retryTask.isPending || deliver.isPending || inspect.isPending;
  const openMain = actions.openAgent ? () => actions.openAgent!(w.mainAgentId) : undefined;
  const action = (item: NeedItem) => {
    switch (item.kind) {
      case "hold": return <Button theme={theme} compact={compact} kind="primary" icon="Play" title="Resume follow-up" loading={resume.isPending} disabled={busy} onPress={() => resume.mutate()} />;
      case "retry": return item.exhausted
        ? openMain && <Button theme={theme} compact={compact} icon="MessageSquare" title="Open main agent" onPress={openMain} />
        : <>
          <Button theme={theme} compact={compact} icon="RotateCcw" title="Retry" accessibilityLabel="Queue the message again" loading={retry.isPending} disabled={busy} onPress={() => retry.mutate(item.batchId)} />
          {openMain && <Button theme={theme} compact={compact} kind="ghost" icon="MessageSquare" title="Open agent" accessibilityLabel="Open main agent" onPress={openMain} />}
        </>;
      case "capped": return <>
          <Button theme={theme} compact={compact} kind="primary" icon="RotateCcw" title="Retry" accessibilityLabel={`Retry: ${item.title}`} loading={retryTask.isPending} disabled={busy} onPress={() => retryTask.mutate(item.taskKey)} />
          {openMain && <Button theme={theme} compact={compact} icon="MessageSquare" title="Open agent" accessibilityLabel="Open main agent" onPress={openMain} />}
        </>;
      case "check": return <Button theme={theme} compact={compact} icon="RefreshCw" title="Check state" loading={inspect.isPending} disabled={busy} onPress={() => inspect.mutate(item.actionId)} />;
      case "decision": return openMain && <Button theme={theme} compact={compact} icon="MessageSquare" title="Answer in chat" onPress={openMain} />;
      case "question": return actions.openQuestion && <Button theme={theme} compact={compact} icon="MessageCircleReply" title="Answer" accessibilityLabel={`Answer ${item.title}`} onPress={() => actions.openQuestion!(item.questionId)} />;
      case "answer": return actions.openQuestion && <Button theme={theme} compact={compact} icon="Eye" title="Check" accessibilityLabel={`Check the ${item.questionId} answer`} onPress={() => actions.openQuestion!(item.questionId)} />;
      case "send": return <Button theme={theme} compact={compact} kind="primary" icon="Send" title={item.finish ? "Ask to finish" : "Send to main agent"} accessibilityLabel={item.finish ? `Ask to finish: ${FINISH_ASK}` : `Send ${item.tasks.length} task${item.tasks.length === 1 ? "" : "s"} to the main agent`} accessibilityHint={item.blocker ?? undefined} loading={deliver.isPending} disabled={busy || !!item.blocker} onPress={() => deliver.mutate(item.batchId)} />;
      case "merge": return actions.openPr && <Button theme={theme} compact={compact} icon="GitMerge" title={`Merge #${item.number}`} accessibilityLabel={`Review and merge pull request ${item.number}`} onPress={() => actions.openPr!(item.prKey, "merge")} />;
      case "reviewers": return actions.openPr && <Button theme={theme} compact={compact} icon="UserPlus" title="Add reviewers" onPress={() => actions.openPr!(item.prKey, "reviewers")} />;
    }
  };
  return <View>
    {items.map((item, index) => {
      const g = glyph(item, c);
      const button = action(item);
      // Phones: the action sits at the row's right edge so rows never grow a second line of controls. A send batch
      // (the primary, with its task list) and Retry's pair keep their buttons full width under the row.
      const inline = compact && button && item.kind !== "send" && !(item.kind === "retry" && !item.exhausted);
      if (inline) return <CardRow key={item.key} theme={theme} compact first={index === 0 && flush} style={flush ? { paddingHorizontal: 0 } : undefined}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <Icon name={g.name} size={16} color={g.color} />
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <RichText numberOfLines={2} style={t.label}>{item.title}</RichText>
            {"detail" in item && !!item.detail && !sameText(item.detail, item.title.replace(/^Q\d+ · /, "")) && <RichText linkColor={c.foreground} numberOfLines={1} style={t.meta}>{item.detail}</RichText>}
          </View>
          {button}
        </View>
      </CardRow>;
      return <CardRow key={item.key} theme={theme} compact={compact} first={index === 0 && flush} style={flush ? { paddingHorizontal: 0 } : undefined}>
        <View style={{ flexDirection: "row", gap: 9 }}>
          <View style={{ paddingTop: 2 }}><Icon name={g.name} size={14} color={g.color} /></View>
          <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
            <RichText style={compact ? t.label : t.body}>{item.title}</RichText>
            {"detail" in item && !!item.detail && !sameText(item.detail, item.title.replace(/^Q\d+ · /, "")) && <RichText linkColor={c.foreground} numberOfLines={item.kind === "question" ? 2 : 3} style={t.meta}>{item.detail}</RichText>}
            {item.kind === "question" && <QuestionState workspace={w} questionId={item.questionId} theme={theme} />}
            {item.kind === "send" && !item.finish && <View style={{ gap: 2 }}>
              {item.tasks.slice(0, 4).map((task, i) => <Text key={i} numberOfLines={2} style={t.meta}><Text style={{ fontVariant: ["tabular-nums"] }}>{`${i + 1}. `}</Text>{shortRefs(task, w)}</Text>)}
              {item.tasks.length > 4 && <Text style={t.meta}>{`and ${item.tasks.length - 4} more`}</Text>}
            </View>}
            {(button || (item.kind === "send" && item.blocker)) && <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8, marginTop: 5 }}>
              {button}
              {item.kind === "send" && item.blocker && <Text style={[t.small, { flexShrink: 1 }]}>{item.blocker}</Text>}
            </View>}
          </View>
        </View>
      </CardRow>;
    })}
  </View>;
}

function QuestionState({ workspace: w, questionId, theme }: { workspace: Workspace; questionId: string; theme: Theme }) {
  const c = theme.colors;
  const pending = usePendingAnswer(w.id, questionId);
  const q = w.questions.find(x => x.id === questionId);
  if (!q) return null;
  const state = meanwhile(w, q, pending);
  return <View style={{ flexDirection: "row", gap: 5 }}>
    <View style={{ paddingTop: 2 }}><Icon name={state.icon} size={11} color={state.color(c)} /></View>
    <Text numberOfLines={4} style={[text(c).small, { flex: 1, color: state.color(c) }]}>{state.text}</Text>
  </View>;
}

/**
 * The surface's one Needs you block (the panel, the larger view, Home's detail pane): a "Needs you · N" frame whose
 * first sections are the asks, then a row per other decision. Every open question renders exactly once
 * (shared/needs-block.ts, invariant an-open-question-renders-once-per-surface): the agent's open brief that points at
 * a question becomes that question's section, carrying the brief's context; a brief that points at none keeps its own
 * card (`briefCard`, drawn bare inside the frame). Questions answer in place through follow.answer-question.
 */
export function NeedsYouBlock({ workspace: w, theme, compact, actions, now, brief = null, briefCard = null, style }: {
  workspace: Workspace; theme: Theme; compact: boolean; actions: NeedActions; now: number;
  /** The agent's open brief this surface shows, or null. */ brief?: Pick<Brief, "questionIds" | "context"> | null;
  /** That brief's own card, drawn when it points at no open question. */ briefCard?: ReactNode; style?: StyleProp<ViewStyle>;
}) {
  const all = needsYou(w, now);
  const block = needsYouBlock(all, brief && briefCard ? brief : null, w.questions);
  // An accordion: one question open at a time (the block's first by default); its header closes it again.
  const [openId, setOpenId] = useState<string | null | undefined>(undefined);
  if (!block.count) return null;
  // In Later the block stays (its moves still work) but reads Later, without the attention border.
  const later = workspaceSnoozed(w, all, now) && w.snooze ? laterLabel(w.snooze.until, now) : null;
  return <Card theme={theme} compact={compact} icon={later ? "AlarmClock" : "CircleAlert"} title={later ? `Later ${later}` : "Needs you"} tone={later ? "plain" : "attention"} count={block.count} style={style}>
    {block.cards.map(card => card.kind === "brief"
      ? <View key="brief" style={{ borderTopWidth: 1, borderTopColor: theme.colors.border }}>{briefCard}</View>
      : <QuestionAsk key={card.questionId} workspace={w} questionId={card.questionId} context={card.brief ? brief?.context ?? null : null} theme={theme} compact={compact} now={now} openAgent={actions.openAgent}
        open={openId === undefined ? card.expanded : openId === card.questionId} onToggle={() => setOpenId(id => (id === undefined ? (card.expanded ? card.questionId : null) : id) === card.questionId ? null : card.questionId)} />)}
    <NeedsYouList workspace={w} theme={theme} compact={compact} actions={actions} now={now} rows={block.rows} />
  </Card>;
}

/**
 * One open question as a section of the block. Open: title, Q chip and asked age; the brief's context when the agent
 * pointed its brief at it; the options with Send; and what the agent does meanwhile, as the footer. Collapsed: the
 * header alone, which opens it in place.
 */
function QuestionAsk({ workspace: w, questionId, context, theme, compact, now, open, onToggle, openAgent }: { workspace: Workspace; questionId: string; context: string | null; theme: Theme; compact: boolean; now: number; open: boolean; onToggle: () => void; openAgent?: (agentId: string) => void }) {
  const c = theme.colors; const t = text(c, compact);
  const pending = usePendingAnswer(w.id, questionId);
  const q = w.questions.find(x => x.id === questionId);
  if (!q) return null;
  const state = meanwhile(w, q, pending);
  // "Q1 · title" (DESIGN.md): the chip leads so a long title wraps under itself, and the age stays on the right.
  const header = <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
    <View style={{ paddingTop: 2 }}><Icon name={questionState(q) === "stopped" ? "CirclePause" : "MessageCircleQuestion"} size={compact ? 16 : 14} color={c.statusWarning} /></View>
    <View style={{ paddingTop: 1 }}><Chip theme={theme} label={q.id} color={c.foregroundMuted} /></View>
    <RichText accessibilityRole="header" numberOfLines={open ? undefined : 1} style={[open ? t.ask : t.label, { flex: 1, minWidth: 0 }]}>{q.title}</RichText>
    <Text style={[t.meta, { paddingTop: 1 }]}>{age(q.askedAt, now)}</Text>
    <View style={{ paddingTop: 1 }}><Icon name={open ? "ChevronUp" : "ChevronDown"} size={14} color={c.foregroundMuted} /></View>
  </View>;
  if (!open) return <CardRow theme={theme} compact={compact} onPress={onToggle} accessibilityLabel={`Show ${q.id}: ${q.title}`} style={{ minHeight: compact ? 48 : undefined, justifyContent: "center" }}>{header}</CardRow>;
  return <CardRow theme={theme} compact={compact} style={{ paddingVertical: compact ? 14 : 12 }}>
    <View style={{ gap: 12 }}>
      <Pressable accessibilityRole="button" aria-expanded accessibilityState={{ expanded: true }} accessibilityLabel={`Hide ${q.id}: ${q.title}`} onPress={onToggle} style={{ minHeight: compact ? 44 : undefined }}>{header}</Pressable>
      {!!context && <RichText selectable linkColor={c.foreground} style={[t.body, { color: c.foregroundMuted }]}>{context}</RichText>}
      <QuestionBody workspace={w} question={q} theme={theme} compact={compact} now={now} openAgent={openAgent} inline />
      <View style={{ flexDirection: "row", gap: 6 }}>
        <View style={{ paddingTop: 2 }}><Icon name={state.icon} size={12} color={state.color(c)} /></View>
        <Text style={[t.small, { flex: 1, color: state.color(c) }]}>{state.text}</Text>
      </View>
    </View>
  </CardRow>;
}
