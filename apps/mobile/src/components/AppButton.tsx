import type { LucideIcon } from "lucide-react-native";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  type ViewStyle,
} from "react-native";
import { useAppTheme } from "@/theme";

interface AppButtonProps {
  title: string;
  onPress: () => void;
  icon?: LucideIcon;
  variant?: "primary" | "secondary" | "danger";
  disabled?: boolean;
  loading?: boolean;
  style?: ViewStyle;
  testID?: string;
}

export function AppButton({
  title,
  onPress,
  icon: Icon,
  variant = "primary",
  disabled = false,
  loading = false,
  style,
  testID,
}: AppButtonProps) {
  const theme = useAppTheme();
  const isDisabled = disabled || loading;
  const foreground =
    variant === "primary"
      ? theme.colors.primaryText
      : variant === "danger"
        ? theme.colors.danger
        : theme.colors.text;

  return (
    <Pressable
      accessibilityLabel={title}
      accessibilityRole="button"
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      disabled={isDisabled}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [
        styles.button,
        variant === "primary" && {
          backgroundColor: pressed ? theme.colors.primaryPressed : theme.colors.primary,
          borderColor: theme.colors.primary,
        },
        variant === "secondary" && {
          backgroundColor: pressed ? theme.colors.surfaceMuted : theme.colors.surface,
          borderColor: theme.colors.border,
        },
        variant === "danger" && {
          backgroundColor: pressed ? theme.colors.dangerMuted : "transparent",
          borderColor: theme.colors.danger,
        },
        isDisabled && styles.disabled,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={foreground} size="small" />
      ) : (
        Icon && <Icon color={foreground} size={19} strokeWidth={2.2} />
      )}
      <Text style={[styles.label, { color: foreground }]}>{title}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: 48,
    paddingHorizontal: 18,
    borderRadius: 7,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 9,
  },
  label: {
    fontSize: 16,
    fontWeight: "700",
  },
  disabled: {
    opacity: 0.46,
  },
});
