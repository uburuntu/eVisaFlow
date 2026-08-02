import type { Purpose } from "@evisa-flow/protocol";
import { randomUUID } from "expo-crypto";
import { router, useLocalSearchParams } from "expo-router";
import { Check, KeyRound, LockKeyhole, UserRound } from "lucide-react-native";
import { useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { MobileApiRequestError } from "@/api/client";
import { MobileServiceUnavailableError, useMobileService } from "@/api/ServiceContext";
import { AppButton } from "@/components/AppButton";
import { AppText as Text } from "@/components/AppText";
import { useAppTheme } from "@/theme";
import { purposeOptions } from "@/utils/run";
import { useVault } from "@/vault/VaultContext";

export default function NewRunScreen() {
  const { profileId } = useLocalSearchParams<{ profileId: string }>();
  const vault = useVault();
  const service = useMobileService();
  const theme = useAppTheme();
  const profile = vault.profiles.find((candidate) => candidate.id === profileId);
  const [purpose, setPurpose] = useState<Purpose>(
    profile?.lastPurpose ?? "right_to_work"
  );
  const [starting, setStarting] = useState(false);

  if (!profile) {
    return (
      <View style={[styles.missing, { backgroundColor: theme.colors.background }]}>
        <UserRound color={theme.colors.textMuted} size={31} />
        <Text style={[styles.title, { color: theme.colors.text }]}>Person not found</Text>
        <AppButton onPress={() => router.replace("/")} title="Back to documents" />
      </View>
    );
  }

  const begin = async () => {
    const activeRun = vault.activeRuns[0];
    if (activeRun) {
      router.replace({ pathname: "/runs/[id]", params: { id: activeRun.id } });
      return;
    }

    setStarting(true);
    try {
      await service.connect();
      const client = service.getClient();
      await client.putProfileSlot(profile.id, { profileId: profile.id });
      const run = await client.createRun({
        clientRunId: randomUUID(),
        profileId: profile.id,
        applicant: profile.applicant,
        purpose,
        preferredTwoFactorMethod: profile.preferredTwoFactorMethod,
        authorityBasis: profile.authorityBasis,
        attestedAt: profile.attestedAt,
        termsVersion: profile.termsVersion,
      });
      await vault.trackRun({
        id: run.id,
        profileId: profile.id,
        purpose,
        createdAt: run.createdAt,
      });
      router.replace({ pathname: "/runs/[id]", params: { id: run.id } });
    } catch (error) {
      if (
        error instanceof MobileApiRequestError &&
        ["FREE_RUN_LIMIT", "PROFILE_LIMIT"].includes(error.code)
      ) {
        Alert.alert(
          "eVisaFlow Pro required",
          error.code === "FREE_RUN_LIMIT"
            ? "The three free saved results have been used."
            : "The free plan supports one person."
        );
      } else if (error instanceof MobileServiceUnavailableError) {
        Alert.alert(
          "Service unavailable",
          "This build is not connected to the secure eVisaFlow service."
        );
      } else {
        Alert.alert(
          "Could not start",
          error instanceof Error ? error.message : "The secure run could not be started."
        );
      }
    } finally {
      setStarting(false);
    }
  };

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      style={{ backgroundColor: theme.colors.background }}
      testID="run-purpose-screen"
    >
      <View style={styles.intro}>
        <Text style={[styles.eyebrow, { color: theme.colors.primary }]}>
          CURRENT EVISA PROOF
        </Text>
        <Text style={[styles.title, { color: theme.colors.text }]}>What is it for?</Text>
        <Text style={[styles.subtitle, { color: theme.colors.textMuted }]}>
          A purpose is required for each GOV.UK share code.
        </Text>
      </View>

      <View
        style={[
          styles.personRow,
          { backgroundColor: theme.colors.surface, borderColor: theme.colors.border },
        ]}
      >
        <View style={[styles.personIcon, { backgroundColor: theme.colors.infoMuted }]}>
          <UserRound color={theme.colors.info} size={20} />
        </View>
        <View style={styles.personCopy}>
          <Text style={[styles.personLabel, { color: theme.colors.textMuted }]}>
            PERSON
          </Text>
          <Text style={[styles.personName, { color: theme.colors.text }]}>
            {profile.displayName}
          </Text>
        </View>
      </View>

      <View accessibilityRole="radiogroup" style={styles.options}>
        {purposeOptions.map((option) => {
          const selected = purpose === option.value;
          const Icon = option.icon;
          return (
            <Pressable
              accessibilityRole="radio"
              accessibilityState={{ checked: selected }}
              key={option.value}
              onPress={() => setPurpose(option.value)}
              style={({ pressed }) => [
                styles.option,
                {
                  backgroundColor: selected
                    ? theme.colors.primaryMuted
                    : theme.colors.surface,
                  borderColor: selected ? theme.colors.primary : theme.colors.border,
                },
                pressed && { opacity: 0.72 },
              ]}
              testID={`run-purpose-${option.value}`}
            >
              <View
                style={[
                  styles.optionIcon,
                  {
                    backgroundColor: selected
                      ? theme.colors.surface
                      : theme.colors.surfaceMuted,
                  },
                ]}
              >
                <Icon
                  color={selected ? theme.colors.primary : theme.colors.textMuted}
                  size={21}
                />
              </View>
              <View style={styles.optionCopy}>
                <Text style={[styles.optionTitle, { color: theme.colors.text }]}>
                  {option.label}
                </Text>
                <Text
                  style={[styles.optionDescription, { color: theme.colors.textMuted }]}
                >
                  {option.description}
                </Text>
              </View>
              <View
                style={[
                  styles.radio,
                  {
                    backgroundColor: selected ? theme.colors.primary : "transparent",
                    borderColor: selected ? theme.colors.primary : theme.colors.border,
                  },
                ]}
              >
                {selected ? (
                  <Check color={theme.colors.primaryText} size={15} strokeWidth={2.8} />
                ) : null}
              </View>
            </Pressable>
          );
        })}
      </View>

      <View style={[styles.requirement, { backgroundColor: theme.colors.warningMuted }]}>
        <KeyRound color={theme.colors.warning} size={20} />
        <View style={styles.requirementCopy}>
          <Text style={[styles.requirementTitle, { color: theme.colors.text }]}>
            Security code required
          </Text>
          <Text style={[styles.requirementBody, { color: theme.colors.textMuted }]}>
            Have access to the account's{" "}
            {profile.preferredTwoFactorMethod === "sms" ? "text messages" : "email"}.
          </Text>
        </View>
      </View>

      <View style={styles.actions}>
        <AppButton
          icon={LockKeyhole}
          loading={starting}
          onPress={() => void begin()}
          testID="run-start"
          title="Start secure sign-in"
        />
        <Text style={[styles.processingNote, { color: theme.colors.textMuted }]}>
          Details are sent only for this run and removed by the service afterward.
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 20, paddingTop: 24, paddingBottom: 44, gap: 22 },
  intro: { gap: 6 },
  eyebrow: { fontSize: 11, lineHeight: 14, fontWeight: "800" },
  title: { fontSize: 25, lineHeight: 31, fontWeight: "800" },
  subtitle: { fontSize: 14, lineHeight: 20 },
  personRow: {
    minHeight: 66,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 13,
    flexDirection: "row",
    alignItems: "center",
    gap: 11,
  },
  personIcon: {
    width: 40,
    height: 40,
    borderRadius: 7,
    alignItems: "center",
    justifyContent: "center",
  },
  personCopy: { flex: 1, gap: 2 },
  personLabel: { fontSize: 10, lineHeight: 13, fontWeight: "800" },
  personName: { fontSize: 15, lineHeight: 20, fontWeight: "700" },
  options: { gap: 10 },
  option: {
    minHeight: 78,
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  optionIcon: {
    width: 42,
    height: 42,
    borderRadius: 7,
    alignItems: "center",
    justifyContent: "center",
  },
  optionCopy: { flex: 1, gap: 2 },
  optionTitle: { fontSize: 15, lineHeight: 20, fontWeight: "700" },
  optionDescription: { fontSize: 12, lineHeight: 17 },
  radio: {
    width: 23,
    height: 23,
    borderRadius: 12,
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
  },
  requirement: {
    minHeight: 72,
    borderRadius: 8,
    padding: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  requirementCopy: { flex: 1, gap: 2 },
  requirementTitle: { fontSize: 13, lineHeight: 18, fontWeight: "700" },
  requirementBody: { fontSize: 12, lineHeight: 17 },
  actions: { gap: 10 },
  processingNote: { fontSize: 12, lineHeight: 18, textAlign: "center" },
  missing: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 28,
    gap: 16,
  },
});
