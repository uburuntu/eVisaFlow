import { formatShareCodeValidUntil, type MobileProfile } from "@evisa-flow/protocol";
import { ChevronRight, FileCheck2 } from "lucide-react-native";
import { Pressable, StyleSheet, View } from "react-native";
import { useAppTheme } from "@/theme";
import { getExpiryState } from "@/utils/expiry";
import { purposeLabels } from "@/utils/run";
import type { SavedResult } from "@/vault/vault";
import { AppText as Text } from "./AppText";

interface SavedDocumentCardProps {
  index: number;
  profile?: MobileProfile;
  result: SavedResult;
  onOpen: () => void;
}

export function SavedDocumentCard({
  index,
  profile,
  result,
  onOpen,
}: SavedDocumentCardProps) {
  const theme = useAppTheme();
  const expiryState = getExpiryState(result.validUntil);
  const expiry = result.validUntil
    ? formatShareCodeValidUntil(result.validUntil, {
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : "No expiry supplied";
  const stateColor =
    expiryState === "expired"
      ? theme.colors.danger
      : expiryState === "expiring_soon"
        ? theme.colors.warning
        : theme.colors.success;
  const stateBackground =
    expiryState === "expired"
      ? theme.colors.dangerMuted
      : expiryState === "expiring_soon"
        ? theme.colors.warningMuted
        : theme.colors.successMuted;
  const stateLabel =
    expiryState === "expired"
      ? "EXPIRED"
      : expiryState === "expiring_soon"
        ? "EXPIRES SOON"
        : "OFFLINE";

  return (
    <Pressable
      accessibilityLabel={`Open saved eVisa proof for ${profile?.displayName ?? "person"}`}
      accessibilityRole="button"
      onPress={onOpen}
      style={({ pressed }) => [
        styles.card,
        { backgroundColor: theme.colors.surface, borderColor: theme.colors.border },
        pressed && { opacity: 0.72 },
      ]}
      testID={`saved-document-${index}`}
    >
      <View style={[styles.icon, { backgroundColor: stateBackground }]}>
        <FileCheck2 color={stateColor} size={23} />
      </View>
      <View style={styles.copy}>
        <View style={styles.titleRow}>
          <Text numberOfLines={1} style={[styles.title, { color: theme.colors.text }]}>
            {profile?.displayName ?? "Saved eVisa"}
          </Text>
          <Text style={[styles.offline, { color: stateColor }]}>{stateLabel}</Text>
        </View>
        <Text style={[styles.purpose, { color: theme.colors.textMuted }]}>
          {purposeLabels[result.purpose]}
        </Text>
        <Text style={[styles.expiry, { color: theme.colors.text }]}>
          Share code {expiryState === "expired" ? "expired" : "valid until"} {expiry}
        </Text>
      </View>
      <ChevronRight color={theme.colors.textMuted} size={20} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    minHeight: 88,
    borderWidth: 1,
    borderRadius: 8,
    padding: 13,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  icon: {
    width: 46,
    height: 46,
    borderRadius: 7,
    alignItems: "center",
    justifyContent: "center",
  },
  copy: { flex: 1, gap: 2 },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  title: { flex: 1, fontSize: 15, lineHeight: 20, fontWeight: "700" },
  offline: { fontSize: 9, lineHeight: 12, fontWeight: "800" },
  purpose: { fontSize: 12, lineHeight: 17 },
  expiry: { fontSize: 12, lineHeight: 17, fontWeight: "600" },
});
