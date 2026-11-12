import { useState } from "react";
import { View } from "react-native";
import { Pressable, Text } from "./text";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon, SettingsRow, useToast } from "@getpaseo/plugin/client/ui";
import { useQueryClient } from "@tanstack/react-query";
import { setPrWorkflowRpc } from "../shared/contracts";
import { noReviewRepoList, REVIEW_MODE_LABELS, REVIEW_MODES, setNoReviewRepos, type ReviewMode } from "../shared/pr-workflow";
import { repoKey } from "../shared/reviewers";
import { MenuItemContent, menuItemRow } from "./menu-item";
import { hasToastHost, pushToast, runAction } from "./toasts";
import { text, type Theme } from "./kit";
import { overviewKey } from "./keys";
import { reviewerSettingsKey } from "./reviewers";

/** How long the "no review" Undo lasts (held while the pointer or focus is on it), as a rename's does. */
export const REVIEW_UNDO_MS = 10_000;
const shippingKey = ["follow-up", "pr-workflow"];

/** "example/app: no review. The agent merges its own PRs once checks pass." The undo bar says the mode's one sentence. */
export const noReviewNotice = (repo: string) => `${repo}: no review. ${REVIEW_MODE_LABELS.none.hint}`;

/**
 * Sets a repository's review mode (Settings → PR workflow → Review, or the Needs-you reviewers row). The client's
 * No review set changes at once, so Needs you and the pill drop the asks before the server answers; then everything
 * that read the old set is fetched again.
 */
export function useSetReviewMode() {
  const write = useRpc(setPrWorkflowRpc); const cache = useQueryClient(); const toast = useToast();
  const refresh = () => {
    for (const queryKey of [["follow-up", "workspace"], overviewKey, reviewerSettingsKey, shippingKey]) void cache.invalidateQueries({ queryKey });
  };
  const local = (repo: string, mode: ReviewMode) => {
    const key = repoKey(repo); const rest = noReviewRepoList().filter(r => r !== key);
    setNoReviewRepos(mode === "none" ? [...rest, key] : rest);
  };
  const set = (repo: string, mode: ReviewMode, undoable: boolean) => {
    const before: ReviewMode = noReviewRepoList().includes(repoKey(repo)) ? "none" : "team";
    local(repo, mode); refresh();
    return runAction({ label: "Review", toast, run: () => write({ repo, review: mode === "team" ? null : mode }), onSuccess: refresh,
      failure: `Couldn't change review for ${repo}`,
      success: () => {
        const message = mode === "none" ? noReviewNotice(repo) : `${repo}: team review. ${REVIEW_MODE_LABELS.team.hint}`;
        if (!undoable || !hasToastHost()) return message;
        pushToast("success", message, [{ label: "Undo", onPress: () => void set(repo, before, false) }], { durationMs: REVIEW_UNDO_MS, keep: true });
        return null;
      } }, `review:${repoKey(repo)}`).then(ok => { if (!ok) { local(repo, before); refresh(); } return ok; });
  };
  return set;
}

/**
 * The reviewers row's quiet second action: a verb-first link under the detail line, so the row keeps its one button
 * (Add reviewers). 44 px tall on touch. Invariant a-no-review-repo-never-asks-for-review-or-merge.
 */
export function NoReviewLink({ repo, theme, compact }: { repo: string; theme: Theme; compact: boolean }) {
  const c = theme.colors; const t = text(c, compact);
  const set = useSetReviewMode();
  const label = `Let the agent merge in ${repo}`;
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityHint={REVIEW_MODE_LABELS.none.hint} onPress={() => void set(repo, "none", true)}
    hitSlop={compact ? 0 : 4} style={{ alignSelf: "flex-start", minHeight: compact ? 44 : 24, justifyContent: "center" }}>
    {state => <Text numberOfLines={1} style={[t.meta, { color: (state as { hovered?: boolean }).hovered ? c.foreground : c.foregroundMuted, textDecorationLine: "underline" }]}>{label}</Text>}
  </Pressable>;
}

/**
 * Settings → PR workflow → <repository> → Review: Team review or No review, each with its one sentence. A menu of its
 * own (not the host's select) so each choice carries its hint, built from the shared MenuItemContent
 * (invariant menu-glyphs-center-on-their-item): the check sits in the glyph slot, centred on the two-line item.
 */
export function ReviewModeRow({ repo, value, theme, compact, busy, onChange }: { repo: string; value: ReviewMode; theme: Theme; compact: boolean; busy: boolean; onChange: (mode: ReviewMode) => void }) {
  const c = theme.colors;
  const [open, setOpen] = useState(false);
  return <View style={{ zIndex: open ? 30 : undefined }}>
    <SettingsRow label="Review" hint={REVIEW_MODE_LABELS[value].hint}>
      <View style={{ position: "relative", alignSelf: compact ? "stretch" : "flex-end" }}>
        <Pressable accessibilityRole="button" accessibilityLabel={`Review for ${repo}: ${REVIEW_MODE_LABELS[value].label}`} aria-expanded={open} accessibilityState={{ expanded: open, disabled: busy }} disabled={busy}
          onPress={() => setOpen(o => !o)} hitSlop={compact ? 0 : 4}
          // The host select's shape (a pill with a hairline), so the row reads like Ship with and Merge method above it.
          style={state => ({ flexDirection: "row", alignItems: "center", justifyContent: compact ? "space-between" : "center", gap: 8, minHeight: compact ? 44 : 32, paddingHorizontal: 16,
            borderRadius: 999, borderWidth: 1, borderColor: c.border, opacity: busy ? 0.45 : 1,
            backgroundColor: open || (state as { hovered?: boolean }).hovered ? c.surface2 : "transparent" })}>
          <Text numberOfLines={1} style={{ color: c.foreground, fontSize: compact ? 15 : 14 }}>{REVIEW_MODE_LABELS[value].label}</Text>
          <Icon name="ChevronDown" size={compact ? 16 : 12} color={c.foregroundMuted} />
        </Pressable>
        {open && <View accessibilityRole="menu" accessibilityLabel={`Review for ${repo}`} style={{ position: "absolute", top: compact ? 50 : 38, ...(compact ? { left: 0, width: 264 } : { right: 0, width: 340 }), paddingVertical: 4,
          borderRadius: 8, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1, shadowColor: "#000", shadowOpacity: 0.25, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 8 }}>
          {REVIEW_MODES.map(mode => <Pressable key={mode} accessibilityRole="menuitem" accessibilityState={{ selected: mode === value }} onPress={() => { setOpen(false); if (mode !== value) onChange(mode); }}
            style={state => ({ ...menuItemRow(compact), minHeight: compact ? 56 : 44, paddingHorizontal: compact ? 12 : 10, paddingVertical: 6, backgroundColor: (state as { hovered?: boolean }).hovered ? c.surface2 : "transparent" })}>
            <MenuItemContent theme={theme} touch={compact} glyph={mode === value ? "Check" : null} label={REVIEW_MODE_LABELS[mode].label} hint={REVIEW_MODE_LABELS[mode].hint} hintLines={compact ? 2 : 1} />
          </Pressable>)}
        </View>}
      </View>
    </SettingsRow>
  </View>;
}
