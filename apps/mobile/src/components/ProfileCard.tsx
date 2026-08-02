import type { MobileProfile } from "@evisa-flow/protocol";
import { ChevronRight, KeyRound } from "lucide-react-native";
import { Pressable, StyleSheet, View } from "react-native";
import { useAppTheme } from "@/theme";
import { documentTypeLabels, maskDocumentNumber } from "@/utils/profile";
import type { SavedResult } from "@/vault/vault";
import { AppButton } from "./AppButton";
import { AppText as Text } from "./AppText";

interface ProfileCardProps {
  index: number;
  profile: MobileProfile;
  latestResult?: SavedResult;
  onGenerate: () => void;
  onOpen: () => void;
}

export function ProfileCard({
  index,
  profile,
  latestResult,
  onGenerate,
  onOpen,
}: ProfileCardProps) {
  const theme = useAppTheme();
  const initials = profile.displayName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");

  return (
    <View
      style={[
        styles.card,
        { backgroundColor: theme.colors.surface, borderColor: theme.colors.border },
      ]}
    >
      <Pressable
        accessibilityLabel={`Open ${profile.displayName}`}
        accessibilityRole="button"
        onPress={onOpen}
        style={({ pressed }) => [styles.identityRow, pressed && { opacity: 0.7 }]}
        testID={`family-profile-${index}`}
      >
        <View style={[styles.avatar, { backgroundColor: theme.colors.infoMuted }]}>
          <Text style={[styles.initials, { color: theme.colors.info }]}>{initials}</Text>
        </View>
        <View style={styles.identityText}>
          <Text numberOfLines={1} style={[styles.name, { color: theme.colors.text }]}>
            {profile.displayName}
          </Text>
          <Text
            numberOfLines={1}
            style={[styles.meta, { color: theme.colors.textMuted }]}
          >
            {documentTypeLabels[profile.applicant.identityDocument.type]} ·{" "}
            {maskDocumentNumber(profile.applicant.identityDocument.number)}
          </Text>
        </View>
        <ChevronRight color={theme.colors.textMuted} size={20} />
      </Pressable>

      <View style={[styles.divider, { backgroundColor: theme.colors.border }]} />

      <View style={styles.actionRow}>
        <View style={styles.statusCopy}>
          <Text style={[styles.statusLabel, { color: theme.colors.textMuted }]}>
            LATEST
          </Text>
          <Text style={[styles.statusValue, { color: theme.colors.text }]}>
            {latestResult
              ? `Saved ${new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(new Date(latestResult.savedAt))}`
              : "No proof saved"}
          </Text>
        </View>
        <AppButton
          icon={KeyRound}
          onPress={onGenerate}
          size="compact"
          testID={`family-generate-${index}`}
          title="Generate copy"
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderRadius: 8,
    overflow: "hidden",
  },
  identityRow: {
    minHeight: 76,
    paddingHorizontal: 14,
    paddingVertical: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 7,
    alignItems: "center",
    justifyContent: "center",
  },
  initials: {
    fontSize: 15,
    lineHeight: 19,
    fontWeight: "800",
  },
  identityText: {
    flex: 1,
    gap: 3,
  },
  name: {
    fontSize: 16,
    lineHeight: 21,
    fontWeight: "700",
  },
  meta: {
    fontSize: 13,
    lineHeight: 18,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginLeft: 70,
  },
  actionRow: {
    minHeight: 66,
    paddingHorizontal: 14,
    paddingVertical: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  statusCopy: {
    flex: 1,
    gap: 2,
  },
  statusLabel: {
    fontSize: 10,
    lineHeight: 13,
    fontWeight: "800",
  },
  statusValue: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "600",
  },
});
