// Every text field in Follow-up (`the-keyboard-never-covers-a-field`, tests/keyboard-field.test.ts): the SDK's
// TextInput, so Paseo still positions it inside its sheets, plus a report to the nearest KeyboardRoom
// (client/keyboard.tsx) when it gains or loses focus, so the room keeps it above a phone's keyboard.
// A one-line field's placeholder always fits its line (`a-placeholder-never-wraps`, invariant 153,
// shared/placeholder-fit.ts): Android's EditText wraps a one-line field's hint and the field clips the second line,
// so the field measures its own text room and draws the longest wording that fits.
import { forwardRef, useCallback, useRef, useState } from "react";
import { Platform, StyleSheet, useWindowDimensions, type LayoutChangeEvent, type TextInput as NativeTextInput, type TextInputProps } from "react-native";
import { TextInput } from "@getpaseo/plugin/client/ui";
import { useFieldRoom, type FocusedField } from "./keyboard";
import { drawnFontSize, estimateTextWidth, fitPlaceholder, fullPlaceholder, textRoom, type Placeholder } from "../shared/placeholder-fit";

export type FieldRef = NativeTextInput;
export type FieldProps = Omit<TextInputProps, "placeholder"> & {
  /** The hint, or its wordings preferred first ("Search or ask the Overseer", "Search or ask", "Search"). */
  placeholder?: Placeholder;
};

/** Android's EditText pads its text where the style sets no horizontal padding (Material: about 12 dp a side). */
const ANDROID_TEXT_PAD = 12;

type WebInput = { getBoundingClientRect?: () => unknown; ownerDocument?: { defaultView?: { getComputedStyle(n: unknown): Record<string, string> } } };
let canvas: { getContext(k: "2d"): { font: string; measureText(t: string): { width: number } } | null } | null = null;
/** The browser's own measure of `text` in this input's font, or null where there is none (native, tests). */
function webMeasure(node: unknown): ((text: string) => number) | null {
  const input = node as WebInput | null;
  const css = input?.ownerDocument?.defaultView?.getComputedStyle(input);
  const doc = (globalThis as { document?: { createElement(t: string): unknown } }).document;
  if (!css || !doc) return null;
  canvas ??= doc.createElement("canvas") as typeof canvas;
  const ctx = canvas?.getContext("2d");
  if (!ctx) return null;
  ctx.font = css.font || `${css.fontStyle} ${css.fontWeight} ${css.fontSize} ${css.fontFamily}`;
  const spacing = parseFloat(css.letterSpacing) || 0;
  return text => ctx.measureText(text).width + spacing * [...text].length + 1;
}

export const Field = forwardRef<NativeTextInput, FieldProps>(function Field({ onFocus, onBlur, onLayout, placeholder, accessibilityLabel, ...props }, ref) {
  const own = useRef<NativeTextInput | null>(null);
  const { room, scroll } = useFieldRoom();
  const me = useRef<FocusedField | null>(null);
  const [width, setWidth] = useState<number | null>(null);
  const { fontScale } = useWindowDimensions();
  const setRef = useCallback((input: NativeTextInput | null) => {
    own.current = input;
    if (typeof ref === "function") ref(input); else if (ref) ref.current = input;
  }, [ref]);
  const focus: NonNullable<TextInputProps["onFocus"]> = e => {
    me.current = {
      node: () => own.current,
      measure: f => (own.current as { measureInWindow?(g: (x: number, y: number, w: number, h: number) => void): void } | null)?.measureInWindow?.((_x, y, _w, h) => f(y, h)),
      scroll,
    };
    room?.focus(me.current);
    onFocus?.(e);
  };
  const blur: NonNullable<TextInputProps["onBlur"]> = e => {
    if (me.current) room?.blur(me.current);
    onBlur?.(e);
  };
  // Only a one-line field with a hint measures itself; a multi-line field's hint wraps as its text does.
  const fits = placeholder !== undefined && !props.multiline;
  const layout = (e: LayoutChangeEvent) => {
    const w = Math.round(e.nativeEvent.layout.width);
    if (fits && w !== width) setWidth(w);
    onLayout?.(e);
  };
  const full = placeholder === undefined ? undefined : fullPlaceholder(placeholder);
  // Before its width is known a phone field shows its shortest wording, so Android never draws one frame wrapped.
  let shown = fits && width === null && Platform.OS !== "web" ? fitPlaceholder(placeholder, null, () => 0, "shortest") : full;
  if (fits && width !== null) {
    const style = (StyleSheet.flatten(props.style) ?? {}) as Record<string, unknown>;
    const web = Platform.OS === "web" ? webMeasure(own.current) : null;
    const size = drawnFontSize(style, Platform.OS === "web" ? 1 : fontScale, props);
    const spacing = typeof style.letterSpacing === "number" ? style.letterSpacing : 0;
    const measure = web ?? ((t: string) => estimateTextWidth(t, size, spacing));
    shown = fitPlaceholder(placeholder, textRoom(width, style, Platform.OS === "android" ? ANDROID_TEXT_PAD : 0), measure);
  }
  // A one-line field is named by its full wording whatever the width shows, so a screen reader hears one name.
  const label = accessibilityLabel ?? (fits ? full : undefined);
  return <TextInput {...props} placeholder={shown} accessibilityLabel={label} numberOfLines={props.multiline ? props.numberOfLines : 1}
    ref={setRef} onFocus={focus} onBlur={blur} onLayout={fits || onLayout ? layout : undefined} />;
});
