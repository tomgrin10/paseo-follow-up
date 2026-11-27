import { PagedRows } from "./paged-list";
import { sendButton } from "../shared/send-words";
import { FINISH_ASK } from "../shared/status";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { Pressable, Text } from "./text";
import { Icon, useToast } from "@getpaseo/plugin/client/ui";
import { openExternalUrl, useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { answerQuestionRpc, checkPrActionRpc, controlRpc, queueActionRpc, sendRpc } from "../shared/contracts";
import { agentName, needsYou, workspaceSnoozed, type NeedItem } from "../shared/attention";
import { laterLabel } from "./inbox";
import { sameText } from "../shared/home";
import type { ListWorkspace as Workspace } from "../shared/list";
import { Button, Card, CardRow, Chip, PrLinkButton, errorText, text, type Theme } from "./kit";
import type { Colors } from "./theme";
import { QuestionBody, QuestionDismissX, meanwhile } from "./questions";
import { needsYouBlock } from "../shared/needs-block";
import { age } from "../shared/inbox";
import { isDoneOnly, questionState } from "../shared/questions";
import type { Brief } from "../shared/brief";
import { useState, type ReactNode } from "react";
import { usePendingAnswer } from "./pending-answers";
import { useReviewerSettings } from "./reviewers";
import { NoReviewLink } from "./review-mode";
import { DismissX, RevealScope, useDismiss } from "./dismiss";

import { overviewKey, workspaceKey } from "./keys";
import { PrLinksProvider, RichText } from "./rich-text";
import { useMergeButtons } from "./merge-button";
import { reviewerClick, useHeldNeeds, useReviewerButtons } from "./reviewers-button";
import { mergeScope } from "../shared/merge-click";
import { prLinksByNumber } from "../shared/presentation";
import { deliveryStatus } from "../shared/queue";
export { overviewKey, workspaceKey };

function glyph(item: NeedItem, colors: Colors): { name: string; color: string } {
  switch (item.kind) {
    case "hold": return { name: "CirclePause", color: colors.statusWarning };
    case "retry": return { name: "OctagonAlert", color: colors.statusDanger };
    case "capped": return { name: "CircleAlert", color: colors.statusWarning };
    case "person": return { name: "UserRound", color: colors.statusWarning };
    case "check": return { name: "CircleHelp", color: colors.statusWarning };
    case "message": return { name: "MessageSquareWarning", color: colors.statusWarning };
    case "decision": return { name: "MessageCircleQuestion", color: colors.statusWarning };
    case "question": return { name: item.state === "stopped" ? "CirclePause" : "MessageCircleQuestion", color: colors.statusWarning };
    case "answer": return item.waiting ? { name: item.waiting === "in-chat" ? "MessageSquareText" : "Copy", color: colors.statusWarning } : { name: "TriangleAlert", color: colors.statusWarning };
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
export function NeedsYouList({ workspace: w, theme, compact, actions, now = Date.now(), flush = false, rows, untitled }: { workspace: Workspace; theme: Theme; compact: boolean; actions: NeedActions; now?: number; flush?: boolean; rows?: readonly NeedItem[]; /** say-it-once: rows whose title the headline above already says; they keep their controls. */ untitled?: ReadonlySet<string> }) {
  const c = theme.colors; const t = text(c, compact);
  useReviewerSettings();
  const toast = useToast();
  const cache = useQueryClient();
  const control = useRpc(controlRpc); const send = useRpc(sendRpc); const check = useRpc(checkPrActionRpc); const answer = useRpc(answerQuestionRpc); const queueAction = useRpc(queueActionRpc);
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
  // A waiting answer (copied or put in the agent's chat) is already decided: Send delivers the recorded pick and note
  // in one click, then reads like any other Send (sent, queued for the agent, or unconfirmed).
  const sendAnswer = useMutation({ mutationFn: (questionId: string) => {
    const a = w.questions.find(q => q.id === questionId)?.answer;
    if (!a) throw new Error(`${questionId} has no recorded answer`);
    return answer({ workspaceId: w.id, questionId, choice: a.choice, words: a.words ?? undefined, action: "send" });
  }, onSuccess: (result, questionId) => {
    const d = result.question.answer?.delivery;
    if (d?.state === "sent") toast.show(`Sent your ${questionId} answer to ${agentName(w)}`, { variant: "success" });
    else if (d?.state === "failed" || d?.state === "cancelled") toast.show(deliveryStatus({ state: d.state, reason: d.reason }).detail, { variant: "warning" });
    else toast.show(`Sending your ${questionId} answer to ${agentName(w)}`, { variant: "info" });
    refresh(); actions.after?.();
  }, onError: fail });
  // Retry on a failed answer: the developer checked the chat, so the queue resends it now (shared/queue.ts).
  const resendAnswer = useMutation({ mutationFn: (questionId: string) => {
    const a = w.questions.find(q => q.id === questionId)?.answer;
    if (!a) throw new Error(`${questionId} has no recorded answer`);
    return answer({ workspaceId: w.id, questionId, choice: a.choice, words: a.words ?? undefined, action: "resend" });
  }, onSuccess: (_result, questionId) => { toast.show(`Sending your ${questionId} answer again`, { variant: "info" }); refresh(); actions.after?.(); }, onError: fail });
  // A forward or report that didn't go out (Workspace.undelivered): Retry or Cancel its queue item, the queue tools' path.
  const queueAct = useMutation({ mutationFn: (input: { itemId: string; action: "retry" | "cancel" }) => queueAction(input),
    onSuccess: (_r, input) => { toast.show(input.action === "retry" ? "Sending it again" : "Cancelled; it won't be sent", { variant: "info" }); refresh(); actions.after?.(); }, onError: fail });
  const inspect = useMutation({ mutationFn: (actionId: string) => check({ workspaceId: w.id, actionId }), onSuccess: reply => { toast.show(reply.result, { variant: reply.state === "failed" ? "warning" : "info" }); refresh(); }, onError: fail });
  const reviewerControl = useReviewerButtons(w);
  // a-clicked-row-holds-its-place: a row clicked here keeps its spot (with its outcome) after the next read drops it,
  // so a run of clicks down the list lands on the rows aimed at. A surface passing `rows` held them itself (the block).
  const held = useHeldNeeds(w.id, rows ? [] : needsYou(w, now));
  const items = rows ?? held;
  const mergeControl = useMergeButtons(w);
  const dismiss = useDismiss();
  if (!items.length) return null;
  const busy = resume.isPending || retry.isPending || retryTask.isPending || deliver.isPending || sendAnswer.isPending || resendAnswer.isPending || queueAct.isPending || inspect.isPending;
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
      // The agent said only a person can move it: ask the reviewer again (the PR sheet's reviewers), or hand it back.
      // Only a part of it (one thread waits on the reviewer's call): the developer's first move is to read that part on the PR.
      case "person": if (item.part) return item.pr
        ? <Button theme={theme} compact={compact} icon="ExternalLink" title={`Open #${item.pr.number}`} accessibilityLabel={`Open #${item.pr.number} to see ${item.detail || item.title}`} accessibilityHint="Opens in your browser" onPress={() => void openExternalUrl(item.pr!.url).catch(() => undefined)} />
        : null;
      return item.review && item.prKey && actions.openPr
        ? <Button theme={theme} compact={compact} icon="UserPlus" title="Ask for re-review" accessibilityLabel={`Ask for a re-review: ${item.title}`} onPress={() => actions.openPr!(item.prKey!, "reviewers")} />
        : null;
      case "check": return <Button theme={theme} compact={compact} icon="RefreshCw" title="Check state" loading={inspect.isPending} disabled={busy} onPress={() => inspect.mutate(item.actionId)} />;
      case "message": return <>
        <Button theme={theme} compact={compact} kind="primary" icon="RotateCcw" title="Retry" accessibilityLabel={`Send it again: ${item.title}`} loading={queueAct.isPending && queueAct.variables?.action === "retry"} disabled={busy} onPress={() => queueAct.mutate({ itemId: item.itemId, action: "retry" })} />
        <Button theme={theme} compact={compact} kind="ghost" icon="X" title="Cancel" accessibilityLabel={`Don't send it: ${item.title}`} loading={queueAct.isPending && queueAct.variables?.action === "cancel"} disabled={busy} onPress={() => queueAct.mutate({ itemId: item.itemId, action: "cancel" })} />
      </>;
      case "decision": return openMain && <Button theme={theme} compact={compact} icon="MessageSquare" title="Answer in chat" onPress={openMain} />;
      case "question": return actions.openQuestion && <Button theme={theme} compact={compact} icon="MessageCircleReply" title="Answer" accessibilityLabel={`Answer ${item.title}`} onPress={() => actions.openQuestion!(item.questionId)} />;
      case "answer": return item.waiting
        ? <>
          <Button theme={theme} compact={compact} icon="Send" title="Send" accessibilityLabel={`Send your ${item.questionId} answer to ${agentName(w)}`} loading={sendAnswer.isPending} disabled={busy} onPress={() => sendAnswer.mutate(item.questionId)} />
          {actions.openQuestion && !compact && <Button theme={theme} compact={compact} kind="ghost" title="Open" accessibilityLabel={`Open ${item.questionId}`} onPress={() => actions.openQuestion!(item.questionId)} />}
        </>
        : <>
          <Button theme={theme} compact={compact} kind="primary" icon="RotateCcw" title="Retry" accessibilityLabel={`Send your ${item.questionId} answer again`} loading={resendAnswer.isPending} disabled={busy} onPress={() => resendAnswer.mutate(item.questionId)} />
          {actions.openAgent && <Button theme={theme} compact={compact} kind="ghost" icon="MessageSquare" title="Open agent" accessibilityLabel={`Open the agent's chat to check for your ${item.questionId} answer`} onPress={() => { const q = w.questions.find(x => x.id === item.questionId); actions.openAgent!(q?.askedBy ?? w.mainAgentId); }} />}
        </>;
      case "send": return <Button theme={theme} compact={compact} kind="primary" icon="Send" title={item.finish ? "Ask to finish" : sendButton(item.what)} accessibilityLabel={item.finish ? `Ask to finish: ${FINISH_ASK}` : `Send ${item.what} to ${agentName(w)}`} accessibilityHint={item.blocker ?? undefined} loading={deliver.isPending} disabled={busy || !!item.blocker} onPress={() => deliver.mutate(item.batchId)} />;
      // One click merges what the button names (a-click-on-merge-merges); the sheet's confirm only when the scope can't be known.
      case "merge": return mergeControl(item.prKey, { theme, compact, fallback: actions.openPr ? () => actions.openPr!(item.prKey, "merge") : undefined }).button;
      // One click asks the people the row names (a-click-on-add-reviewers-asks); the sheet's picker only when nobody is set.
      case "reviewers": return reviewerControl(item.prKey, { theme, compact, after: actions.after, fallback: actions.openPr ? () => actions.openPr!(item.prKey, "reviewers") : undefined })?.button ?? null;
    }
  };
  // A second, quieter action after the primary and its PR link, so the link never wraps onto a line of its own.
  const secondary = (item: NeedItem) => item.kind === "person"
    ? <Button theme={theme} compact={compact} kind="ghost" icon="RotateCcw" title={compact ? "Hand back" : "Hand back to agent"} accessibilityLabel={`Hand it back to ${agentName(w)}: ${item.title}`} loading={retryTask.isPending} disabled={busy} onPress={() => retryTask.mutate(item.taskKey)} />
    : null;
  return <PrLinksProvider prs={prLinksByNumber(w.prs)}><View>
    <PagedRows items={items} theme={theme} compact={compact} noun="items" row={(item, index) => {
      const g = glyph(item, c);
      // A row about one PR opens it in one click, beside its action and never instead of it.
      // A person part's own action is Open #N, so it doesn't draw the link a second time.
      let link = item.pr ? <PrLinkButton link={item.pr} theme={theme} compact={compact} /> : null;
      if (item.kind === "person" && item.part && item.pr) link = null;
      const act = action(item);
      // A stack's Merge names its scope on the row ("Merges #1628, #1629, then #1630"); a click-time blocker shows here too.
      const merging = item.kind === "merge" ? mergeControl(item.prKey, { theme, compact }) : null;
      const scopeLine = item.kind === "merge" ? mergeScope(w, item.prKey)?.detail ?? null : null;
      const notice = merging?.notice ?? null;
      // A reviewers row's why-not sits in its own text column on phones too, so the row never changes layout under the next tap.
      const asked = item.kind === "reviewers" ? reviewerControl(item.prKey, { theme, compact })?.notice ?? null : null;
      // The action and its link are one group, so the link never wraps under the button (a long "Add reviewers").
      const pair = act && link ? <View style={{ flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 0 }}>{act}{link}</View> : null;
      const more = secondary(item);
      const button = act || link || more ? <>{pair ?? <>{act}{link}</>}{more}</> : null;
      const said = !!untitled?.has(item.key);
      // A reviewers row whose request went out reads as a receipt: muted title, nothing left to remove.
      const receipt = item.kind === "reviewers" && reviewerClick(w.id, item.prKey)?.outcome?.state === "submitted";
      const titleStyle = (base: object) => receipt ? [base, { color: c.foregroundMuted }] : base;
      // The small x, top right, on every kind (dismissing-anything-in-needs-you-sends-the-agent-nothing).
      const x = receipt ? null : <DismissX theme={theme} compact={compact} label={`Remove ${item.kind === "question" ? item.questionId : item.title}`}
        onPress={() => dismiss({ workspaceId: w.id, key: item.key }, { onDismissed: actions.after })} />;
      // Phones: the action sits at the row's right edge so rows never grow a second line of controls. A send batch
      // (the primary, with its task list) and Retry's pair keep their buttons full width under the row.
      // A stack's scope line and a blocker need the row's full width, so those rows put their button under the text.
      // So does a reviewers row: its one click asks the people its title names, so the title shows them in full.
      const inline = compact && button && item.kind !== "send" && !(item.kind === "retry" && !item.exhausted) && item.kind !== "person" && item.kind !== "reviewers" && !scopeLine && !notice;
      if (inline) return <CardRow key={item.key} theme={theme} compact first={index === 0 && flush} style={flush ? { paddingHorizontal: 0 } : undefined}>
        <RevealScope style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <View><Icon name={g.name} size={16} color={g.color} /></View>
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            {!said && <RichText numberOfLines={2} style={titleStyle(t.label)}>{item.title}</RichText>}
            {"detail" in item && !!item.detail && !sameText(item.detail, item.title.replace(/^Q\d+ · /, "")) && <RichText linkColor={c.foreground} numberOfLines={item.kind === "answer" || item.kind === "message" ? 3 : 1} style={t.meta}>{item.detail}</RichText>}
          </View>
          <View>{pair ?? button}</View>
          {/* Top right, a step away from the action so a thumb aimed at it doesn't land here. */}
          {/* Flush (Catch up's bordered card): no pull to the edge, so the armed Dismiss pill keeps clear of the border. */}
          <View style={{ alignSelf: "flex-start", marginTop: -4, marginRight: flush ? 0 : -6, marginLeft: 2 }}>{x}</View>
        </RevealScope>
      </CardRow>;
      return <CardRow key={item.key} theme={theme} compact={compact} first={index === 0 && flush} style={flush ? { paddingHorizontal: 0 } : undefined}>
        <RevealScope style={{ flexDirection: "row", gap: 9 }}>
          <View style={{ paddingTop: 2 }}><Icon name={g.name} size={14} color={g.color} /></View>
          <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
            {!said && <RichText style={titleStyle(compact ? t.label : t.body)}>{item.title}</RichText>}
            {"detail" in item && !!item.detail && !sameText(item.detail, item.title.replace(/^Q\d+ · /, "")) && <RichText linkColor={c.foreground} numberOfLines={item.kind === "question" ? 2 : 3} style={t.meta}>{item.detail}</RichText>}
            {scopeLine && <RichText style={t.meta}>{scopeLine}</RichText>}
            {item.kind === "question" && <QuestionState workspace={w} questionId={item.questionId} theme={theme} />}
            {item.kind === "reviewers" && <NoReviewLink repo={item.prKey.split("#")[0]} theme={theme} compact={compact} />}
            {(button || (item.kind === "send" && item.blocker)) && <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8, marginTop: 5 }}>
              {button}
              {item.kind === "send" && item.blocker && <Text style={[t.small, { flexShrink: 1 }]}>{item.blocker}</Text>}
            </View>}
            {notice ?? asked}
          </View>
          <View style={{ marginTop: -3, marginRight: flush ? 2 : -5 }}>{x}</View>
        </RevealScope>
      </CardRow>;
    }} />
  </View></PrLinksProvider>;
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
export function NeedsYouBlock({ workspace: w, theme, compact, actions, now, brief = null, briefCard = null, style, fold = false }: {
  workspace: Workspace; theme: Theme; compact: boolean; actions: NeedActions; now: number;
  /** The agent's open brief this surface shows, or null. */ brief?: Pick<Brief, "questionIds" | "context" | "kind" | "moves"> | null;
  /** That brief's own card, drawn when it points at no open question. */ briefCard?: ReactNode; style?: StyleProp<ViewStyle>;
  /** The workspace panel's section: it folds (client/fold.tsx), and folded its header names the first ask. */ fold?: boolean;
}) {
  useReviewerSettings(); // re-renders on a No review change, so the block's rows and count drop the asks at once
  // Held before grouping: a clicked reviewers row keeps its place, and the brief it folds stays folded.
  const live = needsYou(w, now);
  const all = useHeldNeeds(w.id, live);
  const block = needsYouBlock(all, brief && briefCard ? brief : null, w.questions);
  // The count is the rows still open or still in flight; a held row whose request is done is drawn as a receipt, not
  // counted. Mid-run the number matches the rows on screen; once every held row is done the card says so.
  const held = all.filter(i => !live.includes(i));
  const inFlight = held.filter(i => i.kind === "reviewers" && reviewerClick(w.id, i.prKey)?.running).length;
  const count = block.count - held.length + inFlight;
  const asked = !count && held.length > 0 && held.every(i => i.kind === "reviewers");
  // An accordion: one question open at a time (the block's first by default); its header closes it again.
  const [openId, setOpenId] = useState<string | null | undefined>(undefined);
  if (!block.count) return null; // held rows keep the block drawn after its last ask is done
  // In Later the block stays (its moves still work) but reads Later, without the attention border.
  const later = workspaceSnoozed(w, all, now) && w.snooze ? laterLabel(w.snooze.until, now) : null;
  return <Card theme={theme} compact={compact} icon={later ? "AlarmClock" : asked ? "Check" : "CircleAlert"} title={later ? `Later ${later}` : asked ? "Reviewers requested" : "Needs you"} tone={later || !count ? "plain" : "attention"} count={count || undefined} style={style}
    fold={fold ? { id: "needs", summary: firstAsk(block, w), label: `${count || block.count} open` } : undefined}>
    <PagedRows items={block.cards} theme={theme} compact={compact} noun="questions" row={card => card.kind === "brief"
      ? <View key="brief" style={{ borderTopWidth: 1, borderTopColor: theme.colors.border }}>{briefCard}</View>
      : <QuestionAsk key={card.questionId} workspace={w} questionId={card.questionId} context={card.brief ? brief?.context ?? null : null} theme={theme} compact={compact} now={now} openAgent={actions.openAgent}
        open={openId === undefined ? card.expanded : openId === card.questionId} onToggle={() => setOpenId(id => (id === undefined ? (card.expanded ? card.questionId : null) : id) === card.questionId ? null : card.questionId)} />} />
    <NeedsYouList workspace={w} theme={theme} compact={compact} actions={actions} now={now} rows={block.rows} />
  </Card>;
}

/** Folded, the header names what is first in the block: its first question or row, in the rows' own words. */
function firstAsk(block: ReturnType<typeof needsYouBlock>, w: Workspace): string | null {
  const first = block.cards[0];
  if (first?.kind === "question") return w.questions.find(q => q.id === first.questionId)?.title ?? null;
  if (first) return null; // the brief's card: the count says it
  return block.rows[0]?.title ?? null;
}

/**
 * One open question as a section of the block. Open: title, Q chip and asked age; the brief's context when the agent
 * pointed its brief at it, under what the agent does meanwhile; then the options with Send. Collapsed: the
 * header alone, which opens it in place.
 */
function QuestionAsk({ workspace: w, questionId, context, theme, compact, now, open, onToggle, openAgent }: { workspace: Workspace; questionId: string; context: string | null; theme: Theme; compact: boolean; now: number; open: boolean; onToggle: () => void; openAgent?: (agentId: string) => void }) {
  const c = theme.colors; const t = text(c, compact);
  const pending = usePendingAnswer(w.id, questionId);
  const dismiss = useDismiss();
  const q = w.questions.find(x => x.id === questionId);
  if (!q) return null;
  const state = meanwhile(w, q, pending);
  // "Q1 · title" (DESIGN.md): the chip leads so a long title wraps under itself, and the age stays on the right.
  const header = <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
    <View style={{ paddingTop: 2 }}><Icon name={questionState(q) === "stopped" ? "CirclePause" : q.need === "action" ? "Hand" : "MessageCircleQuestion"} size={compact ? 16 : 14} color={c.statusWarning} /></View>
    {/* An action card carries no Q chip (one-done-button): there is nothing to cite, only something to do. */}
    {!isDoneOnly(q) && <View style={{ paddingTop: 1 }}><Chip theme={theme} label={q.id} color={c.foregroundMuted} /></View>}
    <RichText accessibilityRole="header" numberOfLines={open ? undefined : 1} style={[open ? t.ask : t.label, { flex: 1, minWidth: 0 }]}>{q.title}</RichText>
    <Text style={[t.meta, { paddingTop: 1 }]}>{age(q.askedAt, now)}</Text>
    <View style={{ paddingTop: 1 }}><Icon name={open ? "ChevronUp" : "ChevronDown"} size={14} color={c.foregroundMuted} /></View>
  </View>;
  // The x sits beside the header, outside its toggle, so dismissing never also opens or closes the section.
  const x = <View style={{ marginTop: compact ? -4 : -3, marginRight: compact ? -8 : -6 }}><QuestionDismissX workspaceId={w.id} questionId={q.id} theme={theme} compact={compact} dismiss={dismiss} /></View>;
  if (!open) return <CardRow theme={theme} compact={compact} style={{ minHeight: compact ? 48 : undefined, justifyContent: "center" }}>
    <RevealScope style={{ flexDirection: "row", alignItems: "flex-start", gap: 6 }}>
      <Pressable accessibilityRole="button" accessibilityLabel={`Show ${q.id}: ${q.title}`} onPress={onToggle} style={{ flex: 1, minWidth: 0, minHeight: compact ? 44 : undefined, justifyContent: "center" }}>{header}</Pressable>
      {x}
    </RevealScope>
  </CardRow>;
  return <CardRow theme={theme} compact={compact} style={{ paddingVertical: compact ? 14 : 12 }}>
    <RevealScope style={{ gap: 12 }}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 6 }}>
        <Pressable accessibilityRole="button" aria-expanded accessibilityState={{ expanded: true }} accessibilityLabel={`Hide ${q.id}: ${q.title}`} onPress={onToggle} style={{ flex: 1, minWidth: 0, minHeight: compact ? 44 : undefined }}>{header}</Pressable>
        {x}
      </View>
      {/* The ask first (as in the chat's card), then the brief's context and what the agent does meanwhile under it;
          under the buttons goes what they do. */}
      <QuestionBody workspace={w} question={q} theme={theme} compact={compact} now={now} openAgent={openAgent} inline afterAsk={<>
        {!!context && <RichText selectable linkColor={c.foreground} style={[t.body, { color: c.foregroundMuted }]}>{context}</RichText>}
        <View style={{ flexDirection: "row", gap: 6 }}>
          <View style={{ paddingTop: 2 }}><Icon name={state.icon} size={12} color={state.color(c)} /></View>
          <Text style={[t.small, { flex: 1, color: state.color(c) }]}>{state.text}</Text>
        </View>
      </>} />
    </RevealScope>
  </CardRow>;
}
