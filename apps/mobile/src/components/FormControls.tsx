import { Check, Circle } from "lucide-react-native";
import {
  Pressable,
  StyleSheet,
  TextInput,
  type TextInputProps,
  View,
  type ViewStyle,
} from "react-native";
import { useAppTheme } from "@/theme";
import { MAX_ACCESSIBLE_FONT_SCALE, AppText as Text } from "./AppText";

interface TextFieldProps extends TextInputProps {
  label: string;
  error?: string;
  containerStyle?: ViewStyle;
}

export function TextField({
  label,
  error,
  containerStyle,
  style,
  ...inputProps
}: TextFieldProps) {
  const theme = useAppTheme();

  return (
    <View style={[styles.field, containerStyle]}>
      <Text style={[styles.label, { color: theme.colors.text }]}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        maxFontSizeMultiplier={MAX_ACCESSIBLE_FONT_SCALE}
        placeholderTextColor={theme.colors.textMuted}
        selectionColor={theme.colors.primary}
        style={[
          styles.input,
          {
            backgroundColor: theme.colors.input,
            borderColor: error ? theme.colors.danger : theme.colors.border,
            color: theme.colors.text,
          },
          style,
        ]}
        {...inputProps}
      />
      {error ? (
        <Text
          accessibilityRole="alert"
          style={[styles.error, { color: theme.colors.danger }]}
        >
          {error}
        </Text>
      ) : null}
    </View>
  );
}

interface Choice<T extends string> {
  value: T;
  label: string;
}

interface ChoiceGroupProps<T extends string> {
  label: string;
  value: T;
  choices: Choice<T>[];
  onChange: (value: T) => void;
  testID?: string;
}

export function ChoiceGroup<T extends string>({
  label,
  value,
  choices,
  onChange,
  testID,
}: ChoiceGroupProps<T>) {
  const theme = useAppTheme();

  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: theme.colors.text }]}>{label}</Text>
      <View accessibilityRole="radiogroup" style={styles.choiceGrid}>
        {choices.map((choice) => {
          const selected = choice.value === value;
          return (
            <Pressable
              accessibilityRole="radio"
              accessibilityState={{ checked: selected }}
              key={choice.value}
              onPress={() => onChange(choice.value)}
              testID={testID ? `${testID}-${choice.value}` : undefined}
              style={({ pressed }) => [
                styles.choice,
                {
                  backgroundColor: selected
                    ? theme.colors.surfaceMuted
                    : theme.colors.surface,
                  borderColor: selected ? theme.colors.primary : theme.colors.border,
                },
                pressed && { opacity: 0.72 },
              ]}
            >
              {selected ? (
                <Check color={theme.colors.primary} size={18} strokeWidth={2.4} />
              ) : (
                <Circle color={theme.colors.textMuted} size={18} strokeWidth={1.6} />
              )}
              <Text
                style={[
                  styles.choiceLabel,
                  { color: selected ? theme.colors.primary : theme.colors.text },
                ]}
              >
                {choice.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

interface ConfirmationRowProps {
  checked: boolean;
  label: string;
  onChange: (checked: boolean) => void;
  error?: string;
  testID?: string;
}

export function ConfirmationRow({
  checked,
  label,
  onChange,
  error,
  testID,
}: ConfirmationRowProps) {
  const theme = useAppTheme();

  return (
    <View style={styles.field}>
      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={{ checked }}
        onPress={() => onChange(!checked)}
        style={styles.confirmation}
        testID={testID}
      >
        <View
          style={[
            styles.checkbox,
            {
              backgroundColor: checked ? theme.colors.primary : "transparent",
              borderColor: error
                ? theme.colors.danger
                : checked
                  ? theme.colors.primary
                  : theme.colors.border,
            },
          ]}
        >
          {checked ? (
            <Check color={theme.colors.primaryText} size={17} strokeWidth={2.7} />
          ) : null}
        </View>
        <Text style={[styles.confirmationLabel, { color: theme.colors.text }]}>
          {label}
        </Text>
      </Pressable>
      {error ? (
        <Text
          accessibilityRole="alert"
          style={[styles.error, { color: theme.colors.danger }]}
        >
          {error}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  field: {
    gap: 8,
  },
  label: {
    fontSize: 14,
    fontWeight: "700",
  },
  input: {
    minHeight: 48,
    borderWidth: 1,
    borderRadius: 7,
    paddingHorizontal: 13,
    paddingVertical: 11,
    fontSize: 16,
  },
  error: {
    fontSize: 13,
    lineHeight: 18,
  },
  choiceGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  choice: {
    minHeight: 46,
    minWidth: "47%",
    flexGrow: 1,
    flexBasis: 150,
    borderWidth: 1,
    borderRadius: 7,
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
  },
  choiceLabel: {
    flex: 1,
    fontSize: 14,
    fontWeight: "600",
    lineHeight: 19,
  },
  confirmation: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
  },
  checkbox: {
    width: 24,
    height: 24,
    borderWidth: 1.5,
    borderRadius: 5,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 1,
  },
  confirmationLabel: {
    flex: 1,
    fontSize: 14,
    lineHeight: 21,
  },
});
