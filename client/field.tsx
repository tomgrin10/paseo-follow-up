// Every text field in Follow-up (`the-keyboard-never-covers-a-field`, tests/keyboard-field.test.ts): the SDK's
// TextInput, so Paseo still positions it inside its sheets, plus a report to the nearest KeyboardRoom
// (client/keyboard.tsx) when it gains or loses focus, so the room keeps it above a phone's keyboard.
import { forwardRef, useCallback, useRef } from "react";
import type { TextInput as NativeTextInput, TextInputProps } from "react-native";
import { TextInput } from "@getpaseo/plugin/client/ui";
import { useFieldRoom, type FocusedField } from "./keyboard";

export type FieldRef = NativeTextInput;

export const Field = forwardRef<NativeTextInput, TextInputProps>(function Field({ onFocus, onBlur, ...props }, ref) {
  const own = useRef<NativeTextInput | null>(null);
  const { room, scroll } = useFieldRoom();
  const me = useRef<FocusedField | null>(null);
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
  return <TextInput {...props} ref={setRef} onFocus={focus} onBlur={blur} />;
});
