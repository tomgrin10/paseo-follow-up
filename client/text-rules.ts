/**
 * When Follow-up's text can be selected (client/text.tsx). react-native-web sets user-select on a Text only when
 * `selectable` is passed; otherwise it inherits, and Paseo's containers set user-select: none. So on web (and the
 * desktop app) content says so explicitly, and a control's label says the opposite, so taps and drags on buttons,
 * chips and pills never start a selection. Native keeps its own default: there, long-press belongs to the row menu.
 */
export const CONTROL_ROLES: ReadonlySet<string> = new Set(["button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "togglebutton", "combobox"]);

export function selectableFor(explicit: boolean | undefined, inControl: boolean, os: string): boolean | undefined {
  if (explicit !== undefined) return explicit;
  if (os !== "web") return undefined;
  return !inControl;
}
