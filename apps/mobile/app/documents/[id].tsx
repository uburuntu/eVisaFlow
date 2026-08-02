import { formatShareCodeValidUntil } from "@evisa-flow/protocol";
import * as Clipboard from "expo-clipboard";
import { router, useLocalSearchParams } from "expo-router";
import {
  AlertTriangle,
  CalendarDays,
  Check,
  Copy,
  ExternalLink,
  FileCheck2,
  FileText,
  KeyRound,
  LockKeyhole,
  Printer,
  Share2,
  Trash2,
} from "lucide-react-native";
import { useEffect, useState } from "react";
import { Alert, Linking, ScrollView, StyleSheet, View } from "react-native";
import { AppButton } from "@/components/AppButton";
import { AppText as Text } from "@/components/AppText";
import { IconButton } from "@/components/IconButton";
import { OFFICIAL_EVISA_URL } from "@/constants/app";
import { useAppTheme } from "@/theme";
import { getExpiryState } from "@/utils/expiry";
import { purposeLabels } from "@/utils/run";
import { printSavedArtifact, shareSavedArtifact } from "@/vault/artifact-actions";
import { useVault } from "@/vault/VaultContext";

export default function SavedDocumentScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const vault = useVault();
  const theme = useAppTheme();
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const result = vault.results.find((candidate) => candidate.id === id);
  const profile = result
    ? vault.profiles.find((candidate) => candidate.id === result.profileId)
    : undefined;
  const expiryState = getExpiryState(result?.validUntil);
  const pendingAcknowledgement = vault.pendingClaimAcknowledgements.some(
    (pending) => pending.resultId === id
  );

  useEffect(() => {
    if (!copied) return;
    const timeout = setTimeout(() => setCopied(false), 8_000);
    return () => clearTimeout(timeout);
  }, [copied]);

  if (!result) {
    return (
      <View style={[styles.missing, { backgroundColor: theme.colors.background }]}>
        <FileText color={theme.colors.textMuted} size={31} />
        <Text style={[styles.title, { color: theme.colors.text }]}>
          Document not found
        </Text>
        <AppButton onPress={() => router.replace("/")} title="Back to documents" />
      </View>
    );
  }

  const expiry = result.validUntil
    ? formatShareCodeValidUntil(result.validUntil, { dateStyle: "long" })
    : "Not supplied";

  const copyCode = async () => {
    try {
      await Clipboard.setStringAsync(result.shareCode);
      setCopied(true);
    } catch {
      Alert.alert("Could not copy", "The share code could not be copied.");
    }
  };

  const runArtifactAction = async (
    action: "share" | "print",
    artifact: (typeof result.artifacts)[number]
  ) => {
    setBusyAction(`${action}:${artifact.id}`);
    try {
      if (action === "share") await shareSavedArtifact(artifact);
      else await printSavedArtifact(artifact);
    } catch (error) {
      Alert.alert(
        action === "share" ? "Could not share" : "Could not print",
        error instanceof Error ? error.message : "The file could not be opened."
      );
    } finally {
      setBusyAction(null);
    }
  };

  const confirmDelete = () => {
    Alert.alert(
      "Delete this saved proof?",
      "This removes its share code and encrypted files from this device. The person profile stays saved.",
      [
        { text: "Keep proof", style: "cancel" },
        {
          text: "Delete proof",
          style: "destructive",
          onPress: () => {
            setDeleting(true);
            void vault
              .deleteResult(result.id)
              .then(() => router.replace("/"))
              .catch(() =>
                Alert.alert(
                  "Could not delete proof",
                  "The encrypted vault was not changed."
                )
              )
              .finally(() => setDeleting(false));
          },
        },
      ]
    );
  };

  const savedOn = formatTimestamp(result.savedAt);
  const lastCheckedOnline = formatTimestamp(result.generatedAt ?? result.savedAt);

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      style={{ backgroundColor: theme.colors.background }}
      testID="saved-document-screen"
    >
      <View style={styles.heading}>
        <View
          style={[
            styles.documentIcon,
            {
              backgroundColor:
                expiryState === "expired"
                  ? theme.colors.dangerMuted
                  : expiryState === "expiring_soon"
                    ? theme.colors.warningMuted
                    : theme.colors.successMuted,
            },
          ]}
        >
          <FileCheck2
            color={
              expiryState === "expired"
                ? theme.colors.danger
                : expiryState === "expiring_soon"
                  ? theme.colors.warning
                  : theme.colors.success
            }
            size={29}
          />
        </View>
        <View style={styles.headingCopy}>
          <Text
            style={[
              styles.eyebrow,
              {
                color:
                  expiryState === "expired"
                    ? theme.colors.danger
                    : expiryState === "expiring_soon"
                      ? theme.colors.warning
                      : theme.colors.success,
              },
            ]}
          >
            {expiryState === "expired"
              ? "SHARE CODE EXPIRED"
              : expiryState === "expiring_soon"
                ? "EXPIRES SOON"
                : "AVAILABLE OFFLINE"}
          </Text>
          <Text style={[styles.title, { color: theme.colors.text }]}>
            {profile?.displayName ?? "Saved eVisa"}
          </Text>
          <Text style={[styles.subtitle, { color: theme.colors.textMuted }]}>
            {purposeLabels[result.purpose]}
          </Text>
        </View>
      </View>

      <View
        style={[
          styles.timeline,
          { backgroundColor: theme.colors.surface, borderColor: theme.colors.border },
        ]}
      >
        <TimelineRow label="Saved on this phone" value={savedOn} />
        <View
          style={[styles.timelineDivider, { backgroundColor: theme.colors.border }]}
        />
        <TimelineRow label="Last checked online" value={lastCheckedOnline} />
      </View>

      {pendingAcknowledgement ? (
        <View
          style={[styles.securityNote, { backgroundColor: theme.colors.warningMuted }]}
        >
          <LockKeyhole color={theme.colors.warning} size={19} />
          <Text style={[styles.securityText, { color: theme.colors.text }]}>
            Saved offline. Secure server cleanup will finish when this phone reconnects.
          </Text>
        </View>
      ) : null}

      <View style={[styles.codePanel, { backgroundColor: theme.colors.inverse }]}>
        <View style={styles.codeHeading}>
          <View style={styles.codeCopy}>
            <Text style={[styles.codeLabel, { color: theme.colors.inverseMuted }]}>
              SHARE CODE
            </Text>
            <Text selectable style={[styles.code, { color: theme.colors.inverseText }]}>
              {result.shareCode}
            </Text>
          </View>
          <IconButton
            accessibilityLabel="Copy share code"
            icon={copied ? Check : Copy}
            onPress={() => void copyCode()}
            testID="saved-document-copy-code"
            tone="inverse"
          />
        </View>
        <View style={styles.expiryRow}>
          <CalendarDays color={theme.colors.inverseMuted} size={16} />
          <Text style={[styles.expiry, { color: theme.colors.inverseMuted }]}>
            {copied
              ? "Copied to clipboard"
              : `${expiryState === "expired" ? "Expired" : "Valid until"} ${expiry}`}
          </Text>
        </View>
      </View>

      {expiryState === "expired" || expiryState === "expiring_soon" ? (
        <View
          style={[
            styles.expiryWarning,
            {
              backgroundColor:
                expiryState === "expired"
                  ? theme.colors.dangerMuted
                  : theme.colors.warningMuted,
            },
          ]}
        >
          <AlertTriangle
            color={expiryState === "expired" ? theme.colors.danger : theme.colors.warning}
            size={20}
          />
          <Text style={[styles.expiryWarningText, { color: theme.colors.text }]}>
            {expiryState === "expired"
              ? "This share code has expired. Use the official service to generate a newer code before you need it."
              : "This share code expires soon. Generate and save a newer copy while you have internet access."}
          </Text>
        </View>
      ) : null}

      <View style={styles.artifacts}>
        <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>Files</Text>
        {result.artifacts.map((artifact) => (
          <View
            key={artifact.id}
            style={[
              styles.artifactRow,
              { backgroundColor: theme.colors.surface, borderColor: theme.colors.border },
            ]}
          >
            <View
              style={[styles.artifactIcon, { backgroundColor: theme.colors.infoMuted }]}
            >
              <FileText color={theme.colors.info} size={20} />
            </View>
            <View style={styles.artifactCopy}>
              <Text
                numberOfLines={1}
                style={[styles.artifactName, { color: theme.colors.text }]}
              >
                {artifact.filename}
              </Text>
              <Text style={[styles.artifactMeta, { color: theme.colors.textMuted }]}>
                {formatBytes(artifact.byteLength)} · Encrypted
              </Text>
            </View>
            <View style={styles.artifactActions}>
              {artifact.contentType === "application/pdf" ? (
                <IconButton
                  accessibilityLabel={`Print ${artifact.filename}`}
                  icon={Printer}
                  loading={busyAction === `print:${artifact.id}`}
                  onPress={() => void runArtifactAction("print", artifact)}
                  testID={`saved-document-print-${artifact.kind}`}
                />
              ) : null}
              <IconButton
                accessibilityLabel={`Share ${artifact.filename}`}
                icon={Share2}
                loading={busyAction === `share:${artifact.id}`}
                onPress={() => void runArtifactAction("share", artifact)}
                testID={`saved-document-share-${artifact.kind}`}
              />
            </View>
          </View>
        ))}
      </View>

      <View style={[styles.securityNote, { backgroundColor: theme.colors.infoMuted }]}>
        <LockKeyhole color={theme.colors.info} size={19} />
        <Text style={[styles.securityText, { color: theme.colors.textMuted }]}>
          Temporary decrypted copies are removed after sharing or printing.
        </Text>
      </View>

      <View style={[styles.travelNote, { borderColor: theme.colors.border }]}>
        <AlertTriangle color={theme.colors.textMuted} size={19} />
        <Text style={[styles.securityText, { color: theme.colors.textMuted }]}>
          This saved copy has not been checked against the live UKVI record since{" "}
          {lastCheckedOnline}. It does not replace the passport or travel document linked
          to the UKVI account.
        </Text>
      </View>

      {profile ? (
        <AppButton
          icon={KeyRound}
          onPress={() =>
            router.push({ pathname: "/runs/new", params: { profileId: profile.id } })
          }
          title="Generate a newer saved copy"
          variant="secondary"
        />
      ) : null}

      <AppButton
        icon={ExternalLink}
        onPress={() => void Linking.openURL(OFFICIAL_EVISA_URL)}
        title="Open the free official GOV.UK service"
        variant="secondary"
      />

      <AppButton
        icon={Trash2}
        loading={deleting}
        onPress={confirmDelete}
        testID="saved-document-delete"
        title="Delete saved proof"
        variant="danger"
      />
    </ScrollView>
  );
}

function TimelineRow({ label, value }: { label: string; value: string }) {
  const theme = useAppTheme();
  return (
    <View style={styles.timelineRow}>
      <Text style={[styles.timelineLabel, { color: theme.colors.textMuted }]}>
        {label}
      </Text>
      <Text style={[styles.timelineValue, { color: theme.colors.text }]}>{value}</Text>
    </View>
  );
}

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 20, paddingTop: 24, paddingBottom: 44, gap: 22 },
  heading: { flexDirection: "row", alignItems: "center", gap: 14 },
  documentIcon: {
    width: 56,
    height: 56,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  headingCopy: { flex: 1, gap: 2 },
  eyebrow: { fontSize: 10, lineHeight: 13, fontWeight: "800" },
  title: { fontSize: 23, lineHeight: 29, fontWeight: "800" },
  subtitle: { fontSize: 13, lineHeight: 18 },
  codePanel: { borderRadius: 8, padding: 18, gap: 8 },
  codeHeading: { flexDirection: "row", alignItems: "center", gap: 12 },
  codeCopy: { flex: 1, gap: 4 },
  codeLabel: { fontSize: 10, lineHeight: 13, fontWeight: "800" },
  code: { fontSize: 25, lineHeight: 31, fontWeight: "800", letterSpacing: 0 },
  expiryRow: { flexDirection: "row", alignItems: "center", gap: 7 },
  expiry: { fontSize: 12, lineHeight: 17, fontWeight: "600" },
  expiryWarning: {
    minHeight: 58,
    borderRadius: 8,
    padding: 13,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  expiryWarningText: { flex: 1, fontSize: 12, lineHeight: 17, fontWeight: "600" },
  timeline: { borderWidth: 1, borderRadius: 8, overflow: "hidden" },
  timelineRow: {
    minHeight: 56,
    paddingHorizontal: 14,
    paddingVertical: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  timelineLabel: { flex: 1, fontSize: 12, lineHeight: 17 },
  timelineValue: { fontSize: 12, lineHeight: 17, fontWeight: "700", textAlign: "right" },
  timelineDivider: { height: StyleSheet.hairlineWidth },
  artifacts: { gap: 10 },
  sectionTitle: { fontSize: 17, lineHeight: 22, fontWeight: "800" },
  artifactRow: {
    minHeight: 68,
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 11,
  },
  artifactIcon: {
    width: 40,
    height: 40,
    borderRadius: 7,
    alignItems: "center",
    justifyContent: "center",
  },
  artifactCopy: { flex: 1, gap: 2 },
  artifactActions: { flexDirection: "row", alignItems: "center", gap: 7 },
  artifactName: { fontSize: 13, lineHeight: 18, fontWeight: "700" },
  artifactMeta: { fontSize: 11, lineHeight: 16 },
  securityNote: {
    minHeight: 58,
    borderRadius: 8,
    padding: 13,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  securityText: { flex: 1, fontSize: 12, lineHeight: 17 },
  travelNote: {
    borderTopWidth: 1,
    borderBottomWidth: 1,
    paddingVertical: 14,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
  },
  missing: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 28,
    gap: 16,
  },
});
