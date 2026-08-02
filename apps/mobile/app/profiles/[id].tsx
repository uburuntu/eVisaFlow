import { router, useLocalSearchParams } from "expo-router";
import {
  CalendarDays,
  Clock3,
  FileCheck2,
  KeyRound,
  type LucideIcon,
  ShieldCheck,
  Trash2,
  UserRound,
} from "lucide-react-native";
import { useState } from "react";
import { Alert, ScrollView, StyleSheet, View } from "react-native";
import { AppButton } from "@/components/AppButton";
import { AppText as Text } from "@/components/AppText";
import { useAppTheme } from "@/theme";
import {
  authorityLabels,
  documentTypeLabels,
  formatDateOfBirth,
  maskDocumentNumber,
  twoFactorLabels,
} from "@/utils/profile";
import { purposeLabels } from "@/utils/run";
import { ActiveRunError, useVault } from "@/vault/VaultContext";

export default function ProfileDetailsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const vault = useVault();
  const theme = useAppTheme();
  const [deleting, setDeleting] = useState(false);
  const profile = vault.profiles.find((candidate) => candidate.id === id);
  const results = vault.results.filter((result) => result.profileId === id);
  const activeRun = vault.activeRuns.find((run) => run.profileId === id);

  if (!profile) {
    return (
      <View style={[styles.missing, { backgroundColor: theme.colors.background }]}>
        <UserRound color={theme.colors.textMuted} size={32} />
        <Text style={[styles.title, { color: theme.colors.text }]}>Person not found</Text>
        <AppButton onPress={() => router.replace("/")} title="Back to documents" />
      </View>
    );
  }

  const confirmDelete = () => {
    Alert.alert(
      `Delete ${profile.displayName}?`,
      "This permanently removes the encrypted profile from this device.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => {
            setDeleting(true);
            void vault
              .deleteProfile(profile.id)
              .then(() => router.replace("/"))
              .catch((error: unknown) => {
                Alert.alert(
                  error instanceof ActiveRunError
                    ? "Run in progress"
                    : "Could not delete",
                  error instanceof ActiveRunError
                    ? "Cancel or finish the current run before deleting this person."
                    : "The encrypted vault could not be updated."
                );
              })
              .finally(() => setDeleting(false));
          },
        },
      ]
    );
  };

  const dateOfBirth =
    typeof profile.applicant.dateOfBirth === "string"
      ? formatDateOfBirth(profile.applicant.dateOfBirth)
      : `${profile.applicant.dateOfBirth.day}/${profile.applicant.dateOfBirth.month}/${profile.applicant.dateOfBirth.year}`;

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      style={{ backgroundColor: theme.colors.background }}
      testID="profile-details-screen"
    >
      <View style={styles.identity}>
        <View style={[styles.avatar, { backgroundColor: theme.colors.surfaceMuted }]}>
          <UserRound color={theme.colors.primary} size={31} strokeWidth={1.8} />
        </View>
        <Text style={[styles.title, { color: theme.colors.text }]}>
          {profile.displayName}
        </Text>
        <Text style={[styles.subtitle, { color: theme.colors.textMuted }]}>
          {documentTypeLabels[profile.applicant.identityDocument.type]} -{" "}
          {maskDocumentNumber(profile.applicant.identityDocument.number)}
        </Text>
      </View>

      <View
        style={[
          styles.details,
          { backgroundColor: theme.colors.surface, borderColor: theme.colors.border },
        ]}
      >
        <DetailRow icon={CalendarDays} label="Date of birth" value={dateOfBirth} />
        <View style={[styles.divider, { backgroundColor: theme.colors.border }]} />
        <DetailRow
          icon={KeyRound}
          label="Security code"
          value={twoFactorLabels[profile.preferredTwoFactorMethod]}
        />
        <View style={[styles.divider, { backgroundColor: theme.colors.border }]} />
        <DetailRow
          icon={ShieldCheck}
          label="Authority"
          value={authorityLabels[profile.authorityBasis]}
        />
      </View>

      <View style={styles.history}>
        <View style={styles.historyHeading}>
          <Clock3 color={theme.colors.textMuted} size={20} />
          <Text style={[styles.sectionHeading, { color: theme.colors.text }]}>
            Saved proofs
          </Text>
        </View>
        {activeRun ? (
          <AppButton
            icon={Clock3}
            onPress={() =>
              router.push({ pathname: "/runs/[id]", params: { id: activeRun.id } })
            }
            title="Resume current run"
            variant="secondary"
          />
        ) : null}
        {results.length === 0 ? (
          <Text style={[styles.emptyHistory, { color: theme.colors.textMuted }]}>
            No saved proofs yet.
          </Text>
        ) : (
          results.map((result) => (
            <AppButton
              icon={FileCheck2}
              key={result.id}
              onPress={() =>
                router.push({
                  pathname: "/documents/[id]",
                  params: { id: result.id },
                })
              }
              title={purposeLabels[result.purpose]}
              variant="secondary"
            />
          ))
        )}
      </View>

      {!activeRun ? (
        <AppButton
          icon={KeyRound}
          onPress={() =>
            router.push({ pathname: "/runs/new", params: { profileId: profile.id } })
          }
          title="Generate saved copy"
        />
      ) : null}

      <AppButton
        icon={Trash2}
        loading={deleting}
        onPress={confirmDelete}
        testID="profile-delete"
        title="Delete person"
        variant="danger"
      />
    </ScrollView>
  );
}

function DetailRow({
  icon: Icon,
  label,
  value,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
}) {
  const theme = useAppTheme();
  return (
    <View style={styles.detailRow}>
      <Icon color={theme.colors.primary} size={20} />
      <View style={styles.detailText}>
        <Text style={[styles.detailLabel, { color: theme.colors.textMuted }]}>
          {label}
        </Text>
        <Text style={[styles.detailValue, { color: theme.colors.text }]}>{value}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: 20,
    paddingTop: 28,
    paddingBottom: 44,
    gap: 24,
  },
  identity: {
    alignItems: "center",
    gap: 6,
  },
  avatar: {
    width: 64,
    height: 64,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 5,
  },
  title: {
    fontSize: 23,
    lineHeight: 29,
    fontWeight: "800",
    textAlign: "center",
  },
  subtitle: {
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
  },
  details: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 15,
  },
  detailRow: {
    minHeight: 68,
    flexDirection: "row",
    alignItems: "center",
    gap: 13,
  },
  detailText: {
    flex: 1,
    gap: 2,
  },
  detailLabel: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "700",
    textTransform: "uppercase",
  },
  detailValue: {
    fontSize: 15,
    lineHeight: 21,
    fontWeight: "600",
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginLeft: 33,
  },
  history: {
    minHeight: 112,
    gap: 13,
  },
  historyHeading: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
  },
  sectionHeading: {
    fontSize: 17,
    lineHeight: 22,
    fontWeight: "800",
  },
  emptyHistory: {
    fontSize: 14,
    lineHeight: 20,
  },
  missing: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 28,
    gap: 16,
  },
});
