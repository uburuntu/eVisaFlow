import { router } from "expo-router";
import {
  AlertTriangle,
  ChevronRight,
  ExternalLink,
  LockKeyhole,
  Plus,
  ShieldCheck,
  UserRound,
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
import { AppButton } from "@/components/AppButton";
import { ConfirmationRow } from "@/components/FormControls";
import { FREE_PROFILE_LIMIT, OFFICIAL_EVISA_URL } from "@/constants/app";
import { useAppTheme } from "@/theme";
import { documentTypeLabels, maskDocumentNumber } from "@/utils/profile";
import { useVault } from "@/vault/VaultContext";

export default function FamilyScreen() {
  const vault = useVault();
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
        <LockKeyhole color={theme.colors.primary} size={30} />
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
    if (vault.profiles.length >= FREE_PROFILE_LIMIT) {
      Alert.alert(
        "Family Pro required",
        "The free plan stores one person. Subscriptions are not connected in this build yet."
      );
      return;
    }

    router.push("/profiles/new");
  };

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
        <View>
          <Text style={[styles.brand, { color: theme.colors.text }]}>eVisaFlow</Text>
          <Text style={[styles.sectionTitle, { color: theme.colors.textMuted }]}>
            Family
          </Text>
        </View>
        <Pressable
          accessibilityLabel="Add person"
          accessibilityRole="button"
          hitSlop={8}
          onPress={addPerson}
          style={({ pressed }) => [
            styles.iconButton,
            { backgroundColor: theme.colors.primary },
            pressed && { opacity: 0.72 },
          ]}
          testID="family-add-person-header"
        >
          <Plus color={theme.colors.primaryText} size={23} strokeWidth={2.4} />
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.planRow}>
          <Text style={[styles.planLabel, { color: theme.colors.textMuted }]}>
            Free plan
          </Text>
          <Text style={[styles.planCount, { color: theme.colors.text }]}>
            {vault.profiles.length}/{FREE_PROFILE_LIMIT} person
          </Text>
        </View>

        {vault.profiles.length === 0 ? (
          <View style={styles.emptyState}>
            <View
              style={[styles.emptyIcon, { backgroundColor: theme.colors.surfaceMuted }]}
            >
              <UsersRound color={theme.colors.primary} size={31} strokeWidth={1.8} />
            </View>
            <Text style={[styles.emptyTitle, { color: theme.colors.text }]}>
              No one added
            </Text>
            <Text style={[styles.emptyBody, { color: theme.colors.textMuted }]}>
              Add the first person whose eVisa details you are authorised to manage.
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
              <Pressable
                accessibilityRole="button"
                key={profile.id}
                onPress={() =>
                  router.push({
                    pathname: "/profiles/[id]",
                    params: { id: profile.id },
                  })
                }
                style={({ pressed }) => [
                  styles.profileCard,
                  {
                    backgroundColor: theme.colors.surface,
                    borderColor: theme.colors.border,
                  },
                  pressed && { opacity: 0.74 },
                ]}
                testID={`family-profile-${index}`}
              >
                <View
                  style={[
                    styles.profileAvatar,
                    { backgroundColor: theme.colors.surfaceMuted },
                  ]}
                >
                  <UserRound color={theme.colors.primary} size={22} />
                </View>
                <View style={styles.profileText}>
                  <Text
                    numberOfLines={1}
                    style={[styles.profileName, { color: theme.colors.text }]}
                  >
                    {profile.displayName}
                  </Text>
                  <Text
                    numberOfLines={1}
                    style={[styles.profileMeta, { color: theme.colors.textMuted }]}
                  >
                    {documentTypeLabels[profile.applicant.identityDocument.type]} -{" "}
                    {maskDocumentNumber(profile.applicant.identityDocument.number)}
                  </Text>
                </View>
                <ChevronRight color={theme.colors.textMuted} size={21} />
              </Pressable>
            ))}
          </View>
        )}

        <View
          style={[
            styles.securityNote,
            {
              backgroundColor: theme.colors.surface,
              borderColor: theme.colors.border,
            },
          ]}
        >
          <LockKeyhole color={theme.colors.success} size={19} />
          <Text style={[styles.securityText, { color: theme.colors.textMuted }]}>
            Profiles are encrypted on this device.
          </Text>
        </View>
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
        <ShieldCheck color={theme.colors.primary} size={32} strokeWidth={1.9} />
        <View>
          <Text style={[styles.brand, { color: theme.colors.text }]}>eVisaFlow</Text>
          <Text style={[styles.sectionTitle, { color: theme.colors.textMuted }]}>
            Family share code helper
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
          details will be processed temporarily by eVisaFlow servers and removed after the
          run.
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
      <AlertTriangle color={theme.colors.danger} size={34} />
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
  page: {
    flex: 1,
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
  },
  loadingText: {
    fontSize: 14,
    fontWeight: "600",
  },
  header: {
    minHeight: 82,
    paddingHorizontal: 20,
    paddingBottom: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
  },
  brand: {
    fontSize: 23,
    lineHeight: 28,
    fontWeight: "800",
  },
  sectionTitle: {
    fontSize: 14,
    lineHeight: 19,
    fontWeight: "600",
  },
  iconButton: {
    width: 44,
    height: 44,
    borderRadius: 7,
    alignItems: "center",
    justifyContent: "center",
  },
  scrollContent: {
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 38,
    gap: 20,
  },
  planRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  planLabel: {
    fontSize: 13,
    fontWeight: "700",
    textTransform: "uppercase",
  },
  planCount: {
    fontSize: 14,
    fontWeight: "700",
  },
  emptyState: {
    minHeight: 330,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
    gap: 12,
  },
  emptyIcon: {
    width: 58,
    height: 58,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
  emptyTitle: {
    fontSize: 20,
    lineHeight: 26,
    fontWeight: "800",
    textAlign: "center",
  },
  emptyBody: {
    maxWidth: 330,
    fontSize: 15,
    lineHeight: 22,
    textAlign: "center",
    marginBottom: 8,
  },
  profileList: {
    gap: 10,
  },
  profileCard: {
    minHeight: 76,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  profileAvatar: {
    width: 44,
    height: 44,
    borderRadius: 7,
    alignItems: "center",
    justifyContent: "center",
  },
  profileText: {
    flex: 1,
    gap: 3,
  },
  profileName: {
    fontSize: 16,
    lineHeight: 21,
    fontWeight: "700",
  },
  profileMeta: {
    fontSize: 13,
    lineHeight: 18,
  },
  securityNote: {
    minHeight: 48,
    borderWidth: 1,
    borderRadius: 7,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  securityText: {
    flex: 1,
    fontSize: 13,
    lineHeight: 18,
  },
  disclosure: {
    flexGrow: 1,
    paddingHorizontal: 24,
    justifyContent: "center",
    gap: 28,
  },
  disclosureBrand: {
    flexDirection: "row",
    alignItems: "center",
    gap: 13,
  },
  disclosureCopy: {
    gap: 13,
  },
  disclosureTitle: {
    fontSize: 27,
    lineHeight: 33,
    fontWeight: "800",
  },
  disclosureBody: {
    fontSize: 15,
    lineHeight: 23,
  },
  disclosureActions: {
    gap: 17,
  },
  officialLink: {
    minHeight: 38,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
  },
  officialLinkText: {
    fontSize: 14,
    fontWeight: "700",
    textAlign: "center",
  },
  errorPage: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 28,
    gap: 15,
  },
});
