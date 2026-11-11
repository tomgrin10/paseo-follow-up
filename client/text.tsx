import { createContext, forwardRef, useContext, type ElementRef } from "react";
import { Platform, Pressable as RNPressable, Text as RNText, type PressableProps, type TextProps } from "react-native";
import { CONTROL_ROLES, selectableFor } from "./text-rules";

/**
 * Follow-up's Text and Pressable. Every surface imports these, never react-native's (tests/selectable-text.test.ts).
 * Text is selectable on web and desktop, so a person can copy what Follow-up shows; inside a control-role Pressable
 * (button, link, tab, radio…) it is the control's label and isn't. An explicit `selectable` wins.
 */
const InControl = createContext(false);

export const Text = forwardRef<ElementRef<typeof RNText>, TextProps>(function Text(props, ref) {
  const inControl = useContext(InControl);
  return <RNText ref={ref} {...props} selectable={selectableFor(props.selectable, inControl, Platform.OS)} />;
});

export const Pressable = forwardRef<ElementRef<typeof RNPressable>, PressableProps>(function Pressable(props, ref) {
  const role = (props.accessibilityRole ?? (props as { role?: string }).role) as string | undefined;
  const inner = <RNPressable ref={ref} {...props} />;
  return role && CONTROL_ROLES.has(role) ? <InControl.Provider value>{inner}</InControl.Provider> : inner;
});
