import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Platform, View } from "react-native";
import type { Workspace } from "../shared/model";
import type { Workstream } from "../shared/home";
import { IconButton, type Theme } from "./kit";
import { RowMenu, type DomNode, type RowMenuOpen } from "./row-menu";
import { useRowMenu } from "./row-actions";
import type { HomeSources } from "./home-data";

/**
 * The panel header's More button: the same row menu Home and the sidebar show for this workspace (Rename with AI
 * among it), so there is one menu everywhere. A popover under the button on desktop, the sheet on phones.
 */
export function PanelMore({ w, sources, theme, compact, openAgent, openQuestion, showMenu }: {
  w: Workspace; sources: HomeSources; theme: Theme; compact: boolean;
  openAgent?: (agentId: string) => void; openQuestion: (questionId: string) => void;
  /** Where the open menu draws: the panel's root, after its content (a menu inside the header is painted over). */
  showMenu: (menu: ReactNode) => void;
}) {
  const [open, setOpen] = useState<RowMenuOpen | null>(null);
  const anchor = useRef<View>(null);
  // The workspace's own Home row (`ws:<id>`, its main agent): what the row menu reads.
  const s = useMemo(() => ({ key: `ws:${w.id}`, agentId: w.mainAgentId, workspaceId: w.id, title: w.title, agent: null, word: null, line: "" }) as unknown as Workstream, [w.id, w.mainAgentId, w.title]);
  const menu = useRowMenu({ sources, overseerOn: false, openFull: x => { if (x.agentId) openAgent?.(x.agentId); }, openQuestion: (_x, q) => openQuestion(q) });
  const show = () => {
    const node = anchor.current as unknown as DomNode | null;
    // Anchored at the button's right edge: the menu flips left and lines up under it.
    const r = !compact && Platform.OS === "web" ? node?.getBoundingClientRect?.() as { right?: number; left: number; bottom: number } | undefined : null;
    setOpen({ s, anchor: r ? { x: r.right ?? r.left, y: r.bottom + 4 } : null, sections: menu.build(s), returnTo: node });
  };
  useEffect(() => { showMenu(open ? <RowMenu menu={open} theme={theme} onClose={() => setOpen(null)} onPick={item => menu.pick(open.s, item)} /> : null); }, [open, theme]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => showMenu(null), []); // eslint-disable-line react-hooks/exhaustive-deps
  return <View ref={anchor} collapsable={false}><IconButton icon="Ellipsis" label="More actions for this workspace" onPress={show} theme={theme} compact={compact} /></View>;
}
