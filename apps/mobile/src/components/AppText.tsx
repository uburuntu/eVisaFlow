import { Text as NativeText, type TextProps } from "react-native";

export const MAX_ACCESSIBLE_FONT_SCALE = 2;

export function AppText({ maxFontSizeMultiplier, ...props }: TextProps) {
  return (
    <NativeText
      maxFontSizeMultiplier={maxFontSizeMultiplier ?? MAX_ACCESSIBLE_FONT_SCALE}
      {...props}
    />
  );
}
