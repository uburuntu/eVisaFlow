import type { LucideIcon } from "lucide-react-native";
import { ActivityIndicator, Pressable, StyleSheet } from "react-native";
import { useAppTheme } from "@/theme";

interface IconButtonProps {
  accessibilityLabel: string;
  icon: LucideIcon;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
  testID?: string;
  tone?: "primary" | "neutral" | "inverse";
}

export function IconButton({
  accessibilityLabel,
  icon: Icon,
  onPress,
  disabled = false,
  loading = false,
  testID,
  tone = "neutral",
}: IconButtonProps) {
  const theme = useAppTheme();
  const primary = tone === "primary";
  const inverse = tone === "inverse";
  const foreground = primary
    ? theme.colors.primaryText
    : inverse
      ? theme.colors.inverseText
      : theme.colors.text;

  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled || loading, busy: loading }}
      disabled={disabled || loading}
      hitSlop={8}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: primary ? theme.colors.primary : theme.colors.surfaceMuted,
          borderColor: primary
            ? theme.colors.primary
            : inverse
              ? theme.colors.inverseMuted
              : theme.colors.border,
        },
        inverse && { backgroundColor: "transparent" },
        pressed && { opacity: 0.72 },
        (disabled || loading) && { opacity: 0.46 },
      ]}
    >
      {loading ? (
        <ActivityIndicator color={foreground} size="small" />
      ) : (
        <Icon color={foreground} size={21} strokeWidth={2.2} />
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    width: 42,
    height: 42,
    borderRadius: 7,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
});
