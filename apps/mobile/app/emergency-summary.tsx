import { FileText, Printer, Share2, ShieldAlert } from "lucide-react-native";
import { useMemo, useState } from "react";
import { Alert, ScrollView, StyleSheet, View } from "react-native";
import { AppButton } from "@/components/AppButton";
import { AppText as Text } from "@/components/AppText";
import { ConfirmationRow } from "@/components/FormControls";
import { useAppTheme } from "@/theme";
import { purposeLabels } from "@/utils/run";
import { printEmergencySummary, shareEmergencySummary } from "@/vault/emergency-summary";
import { useVault } from "@/vault/VaultContext";

export default function EmergencySummaryScreen() {
  const vault = useVault();
  const theme = useAppTheme();
  const available = useMemo(() => latestResults(vault.results), [vault.results]);
  const [selected, setSelected] = useState(
    () => new Set(available.map((item) => item.id))
  );
  const [busy, setBusy] = useState<"share" | "print" | null>(null);
  const selectedItems = available
    .filter((result) => selected.has(result.id))
    .map((result) => ({
      result,
      profile: vault.profiles.find((profile) => profile.id === result.profileId),
    }));

  const runAction = async (action: "share" | "print") => {
    if (selectedItems.length === 0) {
      Alert.alert("Select a proof", "Choose at least one saved proof for the summary.");
      return;
    }
    setBusy(action);
    try {
      if (action === "share") await shareEmergencySummary(selectedItems);
      else await printEmergencySummary(selectedItems);
    } catch (error) {
      Alert.alert(
        action === "share" ? "Could not share summary" : "Could not print summary",
        error instanceof Error ? error.message : "The summary could not be created."
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      style={{ backgroundColor: theme.colors.background }}
      testID="emergency-summary-screen"
    >
      <View style={styles.heading}>
        <View
          style={[styles.headingIcon, { backgroundColor: theme.colors.primaryMuted }]}
        >
          <FileText color={theme.colors.primary} size={27} />
        </View>
        <View style={styles.headingCopy}>
          <Text style={[styles.title, { color: theme.colors.text }]}>
            Offline summary
          </Text>
          <Text style={[styles.subtitle, { color: theme.colors.textMuted }]}>
            Create a printable copy from proofs already saved on this phone.
          </Text>
        </View>
      </View>

      <View style={[styles.warning, { backgroundColor: theme.colors.warningMuted }]}>
        <ShieldAlert color={theme.colors.warning} size={20} />
        <Text style={[styles.warningText, { color: theme.colors.text }]}>
          The exported PDF is plaintext and may remain in Files, messages, email, or a
          print service. It is unofficial and is not a live UKVI check.
        </Text>
      </View>

      <View style={styles.selection}>
        <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>Include</Text>
        {available.map((result) => {
          const profile = vault.profiles.find((item) => item.id === result.profileId);
          return (
            <ConfirmationRow
              checked={selected.has(result.id)}
              key={result.id}
              label={`${profile?.displayName ?? "Saved eVisa"} - ${purposeLabels[result.purpose]}`}
              onChange={(checked) => {
                setSelected((current) => {
                  const next = new Set(current);
                  if (checked) next.add(result.id);
                  else next.delete(result.id);
                  return next;
                });
              }}
              testID={`emergency-summary-item-${result.id}`}
            />
          );
        })}
      </View>

      <View style={styles.actions}>
        <AppButton
          icon={Share2}
          loading={busy === "share"}
          onPress={() => void runAction("share")}
          testID="emergency-summary-share"
          title="Create and share PDF"
        />
        <AppButton
          icon={Printer}
          loading={busy === "print"}
          onPress={() => void runAction("print")}
          testID="emergency-summary-print"
          title="Create and print PDF"
          variant="secondary"
        />
      </View>
    </ScrollView>
  );
}

function latestResults<
  T extends {
    id: string;
    profileId: string;
    purpose: string;
    generatedAt?: string;
    savedAt: string;
  },
>(results: T[]): T[] {
  const latest = new Map<string, T>();
  for (const result of results) {
    const key = `${result.profileId}:${result.purpose}`;
    const existing = latest.get(key);
    if (
      !existing ||
      Date.parse(result.generatedAt ?? result.savedAt) >
        Date.parse(existing.generatedAt ?? existing.savedAt)
    ) {
      latest.set(key, result);
    }
  }
  return Array.from(latest.values());
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 20, paddingTop: 24, paddingBottom: 44, gap: 24 },
  heading: { flexDirection: "row", alignItems: "center", gap: 14 },
  headingIcon: {
    width: 52,
    height: 52,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  headingCopy: { flex: 1, gap: 3 },
  title: { fontSize: 23, lineHeight: 29, fontWeight: "800" },
  subtitle: { fontSize: 13, lineHeight: 18 },
  warning: {
    borderRadius: 8,
    padding: 14,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
  },
  warningText: { flex: 1, fontSize: 12, lineHeight: 18 },
  selection: { gap: 12 },
  sectionTitle: { fontSize: 17, lineHeight: 22, fontWeight: "800" },
  actions: { gap: 10 },
});
