// A question's own context, the same on every surface that shows it (one-answer-flow-for-every-question): the agent's
// note, its links, the PR and task it is about, and More context. QuestionBody draws it, and so does the brief card for
// each decision that is a tracked question, so a question in the chat timeline never drops what the panel shows.
import { View } from "react-native";
import { Pressable, Text } from "./text";
import { openExternalUrl } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import type { ListQuestion, ListWorkspace } from "../shared/list";
import { prLinksByNumber } from "../shared/presentation";
import { text, type Theme } from "./kit";
import { mergedColor } from "./theme";
import { PrLinksProvider, RichText } from "./rich-text";
import { QuestionMoreContext } from "./more-context";
import { CardLinkRow } from "./shown-cards";
import { CardHere } from "./card-data";
import { useContext } from "react";

export function hostOf(url: string): string {
  try { return new URL(url).host.replace(/^www\./, ""); } catch { return ""; }
}

/**
 * Whether a question has context to draw: its note, links, PR or task (`inline` hides a task line that only repeats
 * the question's title, which the Needs you block's header already says).
 */
export function hasQuestionContext(w: Pick<ListWorkspace, "prs" | "obligations">, q: ListQuestion, inline = false): boolean {
  const task = q.taskId ? w.obligations.find(o => o.id === q.taskId) : null;
  return !!q.background || !!q.links?.length || (!!q.prKey && w.prs.some(p => p.key === q.prKey)) || (!!task && !(inline && task.title.trim() === q.title.trim()));
}

/** The note, links, PR line and task line. `dense` (the pill) keeps only a 3-line note: its Open button has the rest. */
export function QuestionContext({ workspace: w, question: q, theme, dense = false, inline = false, compact = false }: { workspace: Pick<ListWorkspace, "prs" | "obligations"> & Partial<Pick<ListWorkspace, "id" | "shownCards">>; question: ListQuestion; theme: Theme; compact?: boolean; dense?: boolean; inline?: boolean }) {
  const here = useContext(CardHere);
  if (!hasQuestionContext(w, q, inline)) return null;
  const c = theme.colors; const t = text(c);
  const pr = q.prKey ? w.prs.find(p => p.key === q.prKey) : null;
  const task = q.taskId ? w.obligations.find(o => o.id === q.taskId) : null;
  return <View style={{ gap: 8 }}>
    {!!q.background && <RichText selectable linkColor={c.foreground} numberOfLines={dense ? 3 : undefined} style={t.meta}>{q.background}</RichText>}
    {/* A card the agent showed in the view: one row (its thumbnail, title, what it holds, "below"); dense, one line. */}
    {w.id && q.links?.filter(link => link.card && link.card !== here).map((link, i) => <CardLinkRow key={`card${i}`} workspace={{ id: w.id!, shownCards: w.shownCards }} cardId={link.card!} theme={theme} compact={compact} dense={dense} />)}
    {!dense && q.links?.filter(link => !link.card).map((link, i) => <View key={i} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Icon name={link.url ? "Globe" : "FileText"} size={13} color={c.foregroundMuted} />
      {link.url ? <Pressable accessibilityRole="link" accessibilityLabel={`Open ${link.label || link.url}`} onPress={() => { void openExternalUrl(link.url!).catch(() => undefined); }} hitSlop={4}
        style={state => ({ flexShrink: 1, flexDirection: "row", alignItems: "baseline", gap: 8, opacity: state.pressed ? 0.7 : 1 })}>
        {/* The host is a sibling, not nested: on web an underline carries into nested text whatever its own style says. */}
        <Text numberOfLines={1} style={[t.meta, { flexShrink: 1, color: c.foreground, textDecorationLine: "underline" }]}>{link.label || link.url}</Text>
        {!!link.label && <Text numberOfLines={1} style={[t.meta, { color: c.foregroundMuted }]}>{hostOf(link.url)}</Text>}
      </Pressable> : <Text selectable numberOfLines={1} style={[t.meta, { flexShrink: 1, color: c.foreground }]}>{link.label ? `${link.label}  ` : ""}<Text style={{ color: c.foregroundMuted, fontFamily: "monospace", fontSize: 11 }}>{link.path}</Text></Text>}
    </View>)}
    {!dense && pr && <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Icon name="GitPullRequest" size={13} color={pr.snapshot?.state === "MERGED" ? mergedColor(c) : c.foregroundMuted} />
      {/* "#142" opens the PR (a-row-that-names-a-pr-opens-it-in-one-click). */}
      <PrLinksProvider prs={prLinksByNumber([pr])}><RichText linkColor={c.foreground} numberOfLines={1} style={[t.meta, { flexShrink: 1 }]}>{`About #${pr.number}${pr.snapshot?.title ? ` · ${pr.snapshot.title}` : ""}`}</RichText></PrLinksProvider>
    </View>}
    {!dense && task && !(inline && task.title.trim() === q.title.trim()) && <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Icon name="ListChecks" size={13} color={c.foregroundMuted} />
      <RichText linkColor={c.foreground} numberOfLines={2} style={[t.meta, { flexShrink: 1 }]}>{`Task: ${task.title}`}</RichText>
    </View>}
  </View>;
}

/** The context, then More context while the question is open: what QuestionBody and the brief card draw under the ask. */
export function QuestionContextBlock({ workspace: w, question: q, theme, compact, dense = false, inline = false, open, moreContext = true, openAgent }: { workspace: ListWorkspace; question: ListQuestion; theme: Theme; compact: boolean; dense?: boolean; inline?: boolean; open: boolean; moreContext?: boolean; openAgent?: (agentId: string) => void }) {
  return <>
    <QuestionContext workspace={w} question={q} theme={theme} compact={compact} dense={dense} inline={inline} />
    {open && moreContext && <QuestionMoreContext workspace={w} question={q} theme={theme} compact={compact} openAgent={openAgent} />}
  </>;
}
