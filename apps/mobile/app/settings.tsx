import Constants from "expo-constants";
import { router } from "expo-router";
import type { LucideIcon } from "lucide-react-native";
import {
  ExternalLink,
  FileLock2,
  LockKeyhole,
  Server,
  ShieldCheck,
  Trash2,
} from "lucide-react-native";
import { useState } from "react";
import { Alert, Linking, ScrollView, StyleSheet, Text, View } from "react-native";
import { useMobileService } from "@/api/ServiceContext";
import { AppButton } from "@/components/AppButton";
import { OFFICIAL_EVISA_URL } from "@/constants/app";
import { useAppTheme } from "@/theme";
import { useVault } from "@/vault/VaultContext";

export default function SettingsScreen() {
  const theme = useAppTheme();
  const vault = useVault();
  const service = useMobileService();
  const [deleting, setDeleting] = useState(false);
  const fileCount = vault.results.reduce(
    (total, result) => total + result.artifacts.length,
    0
  );

  const deleteAllData = async () => {
    setDeleting(true);
    try {
      await service.deleteAccount();
      await vault.resetVault();
      router.replace("/");
    } catch {
      Alert.alert(
        "Could not delete all data",
        "Your local vault has not been changed. Check your connection and try again."
      );
    } finally {
      setDeleting(false);
    }
  };

  const confirmDeletion = () => {
    Alert.alert(
      "Delete all app data?",
      "This permanently deletes every saved person, proof, file, active run, and the anonymous service account. This cannot be undone.",
      [
        { text: "Keep my data", style: "cancel" },
        {
          text: "Delete all",
          style: "destructive",
          onPress: () => void deleteAllData(),
        },
      ]
    );
  };

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      style={{ backgroundColor: theme.colors.background }}
      testID="settings-screen"
    >
      <View style={styles.heading}>
        <View
          style={[styles.headingIcon, { backgroundColor: theme.colors.primaryMuted }]}
        >
          <ShieldCheck color={theme.colors.primary} size={27} />
        </View>
        <View style={styles.headingCopy}>
          <Text style={[styles.title, { color: theme.colors.text }]}>
            Privacy and data
          </Text>
          <Text style={[styles.subtitle, { color: theme.colors.textMuted }]}>
            Control what is stored by eVisaFlow.
          </Text>
        </View>
      </View>

      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>
          On this device
        </Text>
        <SettingRow
          body="Profiles, share codes, and files are protected by a device-only encryption key."
          icon={LockKeyhole}
          title="Encrypted offline vault"
        />
        <SettingRow
          body={`${vault.profiles.length} ${vault.profiles.length === 1 ? "person" : "people"}, ${vault.results.length} ${vault.results.length === 1 ? "proof" : "proofs"}, ${fileCount} ${fileCount === 1 ? "file" : "files"}`}
          icon={FileLock2}
          title="Saved locally"
        />
        <SettingRow
          body="Identity details are sent only during a live run. Security codes are never stored."
          icon={Server}
          title="Temporary processing"
        />
      </View>

      <View style={[styles.deleteSection, { borderTopColor: theme.colors.border }]}>
        <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>
          Delete data
        </Text>
        <Text style={[styles.deleteBody, { color: theme.colors.textMuted }]}>
          Removes the encrypted vault from this device and deletes the anonymous service
          account and usage history when connected.
        </Text>
        <AppButton
          icon={Trash2}
          loading={deleting}
          onPress={confirmDeletion}
          testID="settings-delete-all"
          title="Delete all app data"
          variant="danger"
        />
      </View>

      <AppButton
        icon={ExternalLink}
        onPress={() => void Linking.openURL(OFFICIAL_EVISA_URL)}
        title="Open official GOV.UK service"
        variant="secondary"
      />

      <Text style={[styles.version, { color: theme.colors.textMuted }]}>
        eVisaFlow {Constants.expoConfig?.version ?? "0.1.0"} · Independent and unofficial
      </Text>
    </ScrollView>
  );
}

function SettingRow({
  body,
  icon: Icon,
  title,
}: {
  body: string;
  icon: LucideIcon;
  title: string;
}) {
  const theme = useAppTheme();
  return (
    <View style={styles.row}>
      <View style={[styles.rowIcon, { backgroundColor: theme.colors.infoMuted }]}>
        <Icon color={theme.colors.info} size={20} />
      </View>
      <View style={styles.rowCopy}>
        <Text style={[styles.rowTitle, { color: theme.colors.text }]}>{title}</Text>
        <Text style={[styles.rowBody, { color: theme.colors.textMuted }]}>{body}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 20, paddingTop: 24, paddingBottom: 44, gap: 26 },
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
  section: { gap: 18 },
  sectionTitle: { fontSize: 17, lineHeight: 22, fontWeight: "800" },
  row: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  rowIcon: {
    width: 40,
    height: 40,
    borderRadius: 7,
    alignItems: "center",
    justifyContent: "center",
  },
  rowCopy: { flex: 1, gap: 3 },
  rowTitle: { fontSize: 14, lineHeight: 19, fontWeight: "700" },
  rowBody: { fontSize: 13, lineHeight: 19 },
  deleteSection: { borderTopWidth: 1, paddingTop: 22, gap: 12 },
  deleteBody: { fontSize: 13, lineHeight: 19 },
  version: { textAlign: "center", fontSize: 11, lineHeight: 16 },
});
