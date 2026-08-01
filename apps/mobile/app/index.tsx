import { router } from "expo-router";
import {
  AlertTriangle,
  ArrowRight,
  Clock3,
  ExternalLink,
  LockKeyhole,
  Plus,
  Settings,
  ShieldCheck,
  UsersRound,
} from "lucide-react-native";
import { useState } from "react";
import {
  Alert,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useMobileService } from "@/api/ServiceContext";
import { AppButton } from "@/components/AppButton";
import { ConfirmationRow } from "@/components/FormControls";
import { IconButton } from "@/components/IconButton";
import { ProfileCard } from "@/components/ProfileCard";
import { SavedDocumentCard } from "@/components/SavedDocumentCard";
import {
  FREE_PROFILE_LIMIT,
  FREE_RESULT_LIMIT,
  OFFICIAL_EVISA_URL,
} from "@/constants/app";
import { useAppTheme } from "@/theme";
import { useVault } from "@/vault/VaultContext";

export default function DocumentsScreen() {
  const vault = useVault();
  const service = useMobileService();
  const theme = useAppTheme();
  const insets = useSafeAreaInsets();

  if (vault.status === "loading") {
    return (
      <View
        style={[
          styles.centered,
          { backgroundColor: theme.colors.background, paddingTop: insets.top },
        ]}
      >
        <View
          style={[styles.loadingIcon, { backgroundColor: theme.colors.primaryMuted }]}
        >
          <LockKeyhole color={theme.colors.primary} size={25} />
        </View>
        <Text style={[styles.loadingText, { color: theme.colors.textMuted }]}>
          Opening encrypted vault
        </Text>
      </View>
    );
  }

  if (vault.status === "error") {
    return <VaultErrorScreen />;
  }

  if (!vault.hasAcceptedDisclosure) {
    return <DisclosureScreen />;
  }

  const addPerson = () => {
    const profileLimit = service.me?.profileLimit ?? FREE_PROFILE_LIMIT;
    if (vault.profiles.length >= profileLimit) {
      Alert.alert(
        "eVisaFlow Pro required",
        "The free plan stores one person. eVisaFlow Pro supports up to six."
      );
      return;
    }

    router.push("/profiles/new");
  };

  const openProfile = (profileId: string) => {
    router.push({ pathname: "/profiles/[id]", params: { id: profileId } });
  };

  const startRun = (profileId: string) => {
    router.push({ pathname: "/runs/new", params: { profileId } });
  };

  const openDocument = (resultId: string) => {
    router.push({ pathname: "/documents/[id]", params: { id: resultId } });
  };

  const activeRun = vault.activeRuns[0];
  const activeProfile = activeRun
    ? vault.profiles.find((profile) => profile.id === activeRun.profileId)
    : undefined;
  const profileLimit = Math.max(
    vault.profiles.length,
    service.me?.profileLimit ?? FREE_PROFILE_LIMIT
  );
  const localRemainingResults = Math.max(0, FREE_RESULT_LIMIT - vault.results.length);
  const remainingResults =
    service.me?.entitlement === "evisaflow_pro"
      ? null
      : Math.min(
          service.me?.remainingFreeRuns ?? FREE_RESULT_LIMIT,
          localRemainingResults
        );
  const firstProfile = vault.profiles[0];

  return (
    <View
      style={[styles.page, { backgroundColor: theme.colors.background }]}
      testID="family-screen"
    >
      <View
        style={[
          styles.header,
          {
            backgroundColor: theme.colors.surface,
            borderBottomColor: theme.colors.border,
            paddingTop: Math.max(insets.top, 12),
          },
        ]}
      >
        <View style={styles.headerTitle}>
          <View style={styles.brandRow}>
            <ShieldCheck color={theme.colors.primary} size={20} strokeWidth={2.2} />
            <Text style={[styles.brand, { color: theme.colors.text }]}>eVisaFlow</Text>
          </View>
          <Text style={[styles.sectionTitle, { color: theme.colors.textMuted }]}>
            eVisa documents
          </Text>
        </View>
        <View style={styles.headerActions}>
          <IconButton
            accessibilityLabel="Settings"
            icon={Settings}
            onPress={() => router.push("/settings")}
            testID="dashboard-settings"
          />
          <IconButton
            accessibilityLabel="Add person"
            icon={Plus}
            onPress={addPerson}
            testID="family-add-person-header"
            tone="primary"
          />
        </View>
      </View>

      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={[styles.offlinePanel, { backgroundColor: theme.colors.inverse }]}>
          <View style={styles.offlinePanelIcon}>
            <LockKeyhole color={theme.colors.inverseText} size={22} />
          </View>
          <View style={styles.offlinePanelCopy}>
            <Text style={[styles.usageEyebrow, { color: theme.colors.inverseMuted }]}>
              OFFLINE VAULT
            </Text>
            <Text style={[styles.offlineValue, { color: theme.colors.inverseText }]}>
              {vault.results.length === 0
                ? "No documents saved"
                : `${vault.results.length} document${vault.results.length === 1 ? "" : "s"} saved`}
            </Text>
            <Text style={[styles.usageCaption, { color: theme.colors.inverseMuted }]}>
              eVisa PDFs and proofs will stay ready on this device.
            </Text>
          </View>
        </View>

        {activeRun ? (
          <View
            style={[styles.currentRun, { backgroundColor: theme.colors.warningMuted }]}
          >
            <Clock3 color={theme.colors.warning} size={21} />
            <View style={styles.currentRunCopy}>
              <Text style={[styles.currentRunLabel, { color: theme.colors.warning }]}>
                RUN IN PROGRESS
              </Text>
              <Text style={[styles.currentRunTitle, { color: theme.colors.text }]}>
                {activeProfile?.displayName ?? "Current eVisa proof"}
              </Text>
            </View>
            <IconButton
              accessibilityLabel="Resume current run"
              icon={ArrowRight}
              onPress={() =>
                router.push({ pathname: "/runs/[id]", params: { id: activeRun.id } })
              }
              testID="active-run-resume"
            />
          </View>
        ) : null}

        <View style={styles.activitySection}>
          <View style={styles.sectionHeadingRow}>
            <View>
              <Text style={[styles.sectionHeading, { color: theme.colors.text }]}>
                Saved documents
              </Text>
              <Text style={[styles.sectionMeta, { color: theme.colors.textMuted }]}>
                Ready to open, print, or share offline
              </Text>
            </View>
            <Text style={[styles.sectionCount, { color: theme.colors.textMuted }]}>
              {vault.results.length}
            </Text>
          </View>
          {vault.results.length === 0 ? (
            <View style={[styles.emptyActivity, { borderColor: theme.colors.border }]}>
              <View style={styles.emptyActivityTop}>
                <Clock3 color={theme.colors.textMuted} size={19} />
                <View style={styles.emptyActivityText}>
                  <Text style={[styles.emptyActivityTitle, { color: theme.colors.text }]}>
                    Nothing saved yet
                  </Text>
                  <Text
                    style={[styles.emptyActivityBody, { color: theme.colors.textMuted }]}
                  >
                    Generate a current proof to keep it available offline.
                  </Text>
                </View>
              </View>
              {firstProfile ? (
                <AppButton
                  icon={ShieldCheck}
                  onPress={() => startRun(firstProfile.id)}
                  testID="empty-get-proof"
                  title="Get current proof"
                />
              ) : null}
            </View>
          ) : (
            <View style={styles.documentList}>
              {vault.results.map((result, index) => (
                <SavedDocumentCard
                  index={index}
                  key={result.id}
                  onOpen={() => openDocument(result.id)}
                  profile={vault.profiles.find(
                    (profile) => profile.id === result.profileId
                  )}
                  result={result}
                />
              ))}
            </View>
          )}
        </View>

        <View style={styles.sectionHeadingRow}>
          <View>
            <Text style={[styles.sectionHeading, { color: theme.colors.text }]}>
              People
            </Text>
            <Text style={[styles.sectionMeta, { color: theme.colors.textMuted }]}>
              Encrypted profiles on this device
            </Text>
          </View>
          <Text style={[styles.sectionCount, { color: theme.colors.textMuted }]}>
            {vault.profiles.length}
          </Text>
        </View>

        {vault.profiles.length === 0 ? (
          <View style={styles.emptyState}>
            <View style={[styles.emptyIcon, { backgroundColor: theme.colors.infoMuted }]}>
              <UsersRound color={theme.colors.info} size={29} strokeWidth={1.9} />
            </View>
            <Text style={[styles.emptyTitle, { color: theme.colors.text }]}>
              No one added
            </Text>
            <Text style={[styles.emptyBody, { color: theme.colors.textMuted }]}>
              Add a person you are authorised to manage.
            </Text>
            <AppButton
              icon={Plus}
              onPress={addPerson}
              testID="family-add-person-empty"
              title="Add person"
            />
          </View>
        ) : (
          <View style={styles.profileList}>
            {vault.profiles.map((profile, index) => (
              <ProfileCard
                index={index}
                key={profile.id}
                latestResult={vault.results.find(
                  (result) => result.profileId === profile.id
                )}
                onGenerate={() => startRun(profile.id)}
                onOpen={() => openProfile(profile.id)}
                profile={profile}
              />
            ))}
          </View>
        )}

        <View style={[styles.securityBand, { backgroundColor: theme.colors.infoMuted }]}>
          <LockKeyhole color={theme.colors.info} size={20} />
          <View style={styles.securityCopy}>
            <Text style={[styles.securityTitle, { color: theme.colors.text }]}>
              Your offline vault is encrypted
            </Text>
            <Text style={[styles.securityText, { color: theme.colors.textMuted }]}>
              Profiles and saved documents stay on this device.
            </Text>
          </View>
        </View>

        <Pressable
          accessibilityRole="link"
          onPress={() => void Linking.openURL(OFFICIAL_EVISA_URL)}
          style={styles.dashboardOfficialLink}
        >
          <Text style={[styles.dashboardOfficialText, { color: theme.colors.primary }]}>
            Official GOV.UK service
          </Text>
          <ExternalLink color={theme.colors.primary} size={15} />
        </Pressable>

        <Text style={[styles.planFooter, { color: theme.colors.textMuted }]}>
          {service.me?.entitlement === "evisaflow_pro" ? "eVisaFlow Pro" : "Free plan"} ·{" "}
          {vault.profiles.length}/{profileLimit}{" "}
          {profileLimit === 1 ? "person" : "people"} ·{" "}
          {remainingResults === null
            ? "unlimited results"
            : `${remainingResults} results remaining`}
        </Text>
      </ScrollView>
    </View>
  );
}

function DisclosureScreen() {
  const vault = useVault();
  const theme = useAppTheme();
  const insets = useSafeAreaInsets();
  const [confirmed, setConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);

  const continueToApp = async () => {
    setSaving(true);
    try {
      await vault.acceptDisclosure();
    } catch {
      Alert.alert("Could not save", "Your confirmation could not be stored securely.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <ScrollView
      contentContainerStyle={[
        styles.disclosure,
        {
          backgroundColor: theme.colors.background,
          paddingTop: Math.max(insets.top + 20, 36),
          paddingBottom: Math.max(insets.bottom + 24, 36),
        },
      ]}
      testID="onboarding-screen"
    >
      <View style={styles.disclosureBrand}>
        <View
          style={[styles.disclosureMark, { backgroundColor: theme.colors.primaryMuted }]}
        >
          <ShieldCheck color={theme.colors.primary} size={28} strokeWidth={2} />
        </View>
        <View>
          <Text style={[styles.brand, { color: theme.colors.text }]}>eVisaFlow</Text>
          <Text style={[styles.sectionTitle, { color: theme.colors.textMuted }]}>
            eVisa documents and share codes
          </Text>
        </View>
      </View>

      <View style={styles.disclosureCopy}>
        <Text style={[styles.disclosureTitle, { color: theme.colors.text }]}>
          Before you continue
        </Text>
        <Text style={[styles.disclosureBody, { color: theme.colors.textMuted }]}>
          eVisaFlow is an independent, unofficial service. It is not affiliated with or
          endorsed by the UK Government, Home Office, UKVI, or GOV.UK.
        </Text>
        <Text style={[styles.disclosureBody, { color: theme.colors.textMuted }]}>
          Profiles stay encrypted on this device. During a live run, the minimum required
          details are processed temporarily by eVisaFlow servers and then removed.
        </Text>
        <Text style={[styles.disclosureBody, { color: theme.colors.textMuted }]}>
          Only manage an account for yourself, as a parent or guardian, or with the
          account holder's express authority.
        </Text>
      </View>

      <ConfirmationRow
        checked={confirmed}
        label="I understand that eVisaFlow is unofficial and confirm that I will only add people I am authorised to manage."
        onChange={setConfirmed}
        testID="onboarding-confirmation"
      />

      <View style={styles.disclosureActions}>
        <AppButton
          disabled={!confirmed}
          loading={saving}
          onPress={() => void continueToApp()}
          testID="onboarding-continue"
          title="Continue"
        />
        <Pressable
          accessibilityRole="link"
          onPress={() => void Linking.openURL(OFFICIAL_EVISA_URL)}
          style={styles.officialLink}
          testID="onboarding-official-service"
        >
          <Text style={[styles.officialLinkText, { color: theme.colors.primary }]}>
            Use the free official GOV.UK service
          </Text>
          <ExternalLink color={theme.colors.primary} size={16} />
        </Pressable>
      </View>
    </ScrollView>
  );
}

function VaultErrorScreen() {
  const vault = useVault();
  const theme = useAppTheme();
  const insets = useSafeAreaInsets();
  const [resetting, setResetting] = useState(false);

  const confirmReset = () => {
    Alert.alert(
      "Reset encrypted vault?",
      "This permanently deletes every local profile and cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Reset vault",
          style: "destructive",
          onPress: () => {
            setResetting(true);
            void vault.resetVault().finally(() => setResetting(false));
          },
        },
      ]
    );
  };

  return (
    <View
      style={[
        styles.errorPage,
        {
          backgroundColor: theme.colors.background,
          paddingTop: Math.max(insets.top, 24),
          paddingBottom: Math.max(insets.bottom, 24),
        },
      ]}
    >
      <View style={[styles.errorIcon, { backgroundColor: theme.colors.dangerMuted }]}>
        <AlertTriangle color={theme.colors.danger} size={29} />
      </View>
      <Text style={[styles.emptyTitle, { color: theme.colors.text }]}>
        Vault unavailable
      </Text>
      <Text style={[styles.emptyBody, { color: theme.colors.textMuted }]}>
        The local encryption key is missing or the encrypted data cannot be opened.
        Resetting is the only recovery path.
      </Text>
      <AppButton
        loading={resetting}
        onPress={confirmReset}
        title="Reset vault"
        variant="danger"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 13,
  },
  loadingIcon: {
    width: 52,
    height: 52,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  loadingText: { fontSize: 14, fontWeight: "600" },
  header: {
    minHeight: 96,
    paddingHorizontal: 20,
    paddingBottom: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
    gap: 16,
  },
  headerTitle: { flex: 1, gap: 3 },
  headerActions: { flexDirection: "row", alignItems: "center", gap: 8 },
  brandRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  brand: { fontSize: 22, lineHeight: 27, fontWeight: "800" },
  sectionTitle: { fontSize: 13, lineHeight: 18, fontWeight: "600" },
  scrollContent: {
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 38,
    gap: 20,
  },
  offlinePanel: {
    minHeight: 116,
    borderRadius: 8,
    padding: 18,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 14,
  },
  offlinePanelIcon: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
  },
  offlinePanelCopy: { flex: 1, gap: 5 },
  usageEyebrow: { fontSize: 11, lineHeight: 14, fontWeight: "800" },
  offlineValue: { fontSize: 19, lineHeight: 25, fontWeight: "800" },
  usageCaption: { fontSize: 12, lineHeight: 16, fontWeight: "600" },
  currentRun: {
    minHeight: 74,
    borderRadius: 8,
    padding: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 11,
  },
  currentRunCopy: { flex: 1, gap: 2 },
  currentRunLabel: { fontSize: 10, lineHeight: 13, fontWeight: "800" },
  currentRunTitle: { fontSize: 14, lineHeight: 19, fontWeight: "700" },
  sectionHeadingRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-end",
    gap: 12,
  },
  sectionHeading: { fontSize: 18, lineHeight: 23, fontWeight: "800" },
  sectionMeta: { marginTop: 2, fontSize: 12, lineHeight: 17 },
  sectionCount: { fontSize: 13, lineHeight: 18, fontWeight: "700" },
  emptyState: {
    minHeight: 250,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
    gap: 11,
  },
  emptyIcon: {
    width: 56,
    height: 56,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 3,
  },
  emptyTitle: { fontSize: 20, lineHeight: 26, fontWeight: "800", textAlign: "center" },
  emptyBody: {
    maxWidth: 330,
    fontSize: 14,
    lineHeight: 21,
    textAlign: "center",
    marginBottom: 6,
  },
  profileList: { gap: 12 },
  documentList: { gap: 10 },
  activitySection: { gap: 12 },
  emptyActivity: {
    minHeight: 72,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingVertical: 14,
    gap: 13,
  },
  emptyActivityTop: { flexDirection: "row", alignItems: "center", gap: 12 },
  emptyActivityText: { flex: 1, gap: 2 },
  emptyActivityTitle: { fontSize: 14, lineHeight: 19, fontWeight: "700" },
  emptyActivityBody: { fontSize: 12, lineHeight: 17 },
  securityBand: {
    minHeight: 70,
    borderRadius: 8,
    padding: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  securityCopy: { flex: 1, gap: 2 },
  securityTitle: { fontSize: 13, lineHeight: 18, fontWeight: "700" },
  securityText: { fontSize: 12, lineHeight: 17 },
  dashboardOfficialLink: {
    minHeight: 36,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  dashboardOfficialText: { fontSize: 13, lineHeight: 18, fontWeight: "700" },
  planFooter: { fontSize: 12, lineHeight: 17, textAlign: "center" },
  disclosure: {
    flexGrow: 1,
    paddingHorizontal: 24,
    justifyContent: "center",
    gap: 28,
  },
  disclosureBrand: { flexDirection: "row", alignItems: "center", gap: 12 },
  disclosureMark: {
    width: 48,
    height: 48,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  disclosureCopy: { gap: 13 },
  disclosureTitle: { fontSize: 27, lineHeight: 33, fontWeight: "800" },
  disclosureBody: { fontSize: 15, lineHeight: 23 },
  disclosureActions: { gap: 17 },
  officialLink: {
    minHeight: 38,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
  },
  officialLinkText: { fontSize: 14, fontWeight: "700", textAlign: "center" },
  errorPage: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 28,
    gap: 15,
  },
  errorIcon: {
    width: 58,
    height: 58,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
});
