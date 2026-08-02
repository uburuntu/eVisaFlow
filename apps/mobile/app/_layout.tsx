import * as Notifications from "expo-notifications";
import { router, Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { ShieldCheck } from "lucide-react-native";
import { useEffect, useState } from "react";
import { AppState, StyleSheet, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { MobileApiRequestError } from "@/api/client";
import { ServiceProvider, useMobileService } from "@/api/ServiceContext";
import { AppText as Text } from "@/components/AppText";
import {
  configureLocalNotifications,
  reconcileExpiryReminders,
  resultIdFromNotificationResponse,
} from "@/notifications/reminders";
import { useAppTheme } from "@/theme";
import { cleanupTemporaryArtifacts } from "@/vault/artifact-actions";
import { cleanupTemporaryEmergencySummaries } from "@/vault/emergency-summary";
import { useVault, VaultProvider } from "@/vault/VaultContext";

configureLocalNotifications();

function ServiceBootstrap() {
  const vault = useVault();
  const service = useMobileService();
  const {
    clearProfileSlotTombstone,
    confirmClaimAcknowledged,
    discardPendingClaim,
    hasAcceptedDisclosure,
    pendingClaimAcknowledgements,
    profileSlotTombstones,
    status: vaultStatus,
    updatePendingClaim,
  } = vault;
  const { connect, getClient, mode } = service;
  useEffect(() => {
    if (vaultStatus !== "ready" || !hasAcceptedDisclosure || mode === "unconfigured") {
      return;
    }
    let active = true;
    void connect()
      .then(async () => {
        const client = getClient();
        for (const profileId of profileSlotTombstones) {
          await client.deleteProfileSlot(profileId);
          if (active) await clearProfileSlotTombstone(profileId);
        }
        for (const pending of pendingClaimAcknowledgements) {
          try {
            await client.acknowledgeClaim(pending.runId, {
              claimToken: pending.claimToken,
              manifestHash: pending.manifestHash,
            });
            if (active) await confirmClaimAcknowledged(pending.runId);
          } catch (error) {
            if (
              !(error instanceof MobileApiRequestError) ||
              error.code !== "CLAIM_ACKNOWLEDGEMENT_REJECTED"
            ) {
              continue;
            }
            try {
              const renewed = await client.beginClaim(pending.runId);
              if (renewed.manifestHash !== pending.manifestHash) continue;
              if (active) {
                await updatePendingClaim(
                  pending.runId,
                  renewed.claimToken,
                  renewed.manifestHash
                );
              }
              await client.acknowledgeClaim(pending.runId, {
                claimToken: renewed.claimToken,
                manifestHash: renewed.manifestHash,
              });
              if (active) await confirmClaimAcknowledged(pending.runId);
            } catch (renewError) {
              if (
                active &&
                renewError instanceof MobileApiRequestError &&
                renewError.code === "RESULT_NOT_READY"
              ) {
                await discardPendingClaim(pending.runId);
              }
            }
          }
        }
      })
      .catch(() => {
        // Offline startup is expected; a user action will retry the connection.
      });
    return () => {
      active = false;
    };
  }, [
    clearProfileSlotTombstone,
    confirmClaimAcknowledged,
    connect,
    getClient,
    hasAcceptedDisclosure,
    discardPendingClaim,
    mode,
    pendingClaimAcknowledgements,
    profileSlotTombstones,
    updatePendingClaim,
    vaultStatus,
  ]);

  return null;
}

function LocalFileCleanup() {
  useEffect(() => {
    cleanupTemporaryArtifacts();
    cleanupTemporaryEmergencySummaries();
  }, []);
  return null;
}

function Navigation() {
  const theme = useAppTheme();

  return (
    <View style={[styles.navigationRoot, { backgroundColor: theme.colors.background }]}>
      <StatusBar style={theme.isDark ? "light" : "dark"} />
      <SafeAreaView edges={["bottom"]} style={styles.navigationContent}>
        <Stack
          screenOptions={{
            contentStyle: { backgroundColor: theme.colors.background },
            headerStyle: { backgroundColor: theme.colors.surface },
            headerShadowVisible: false,
            headerTintColor: theme.colors.text,
            headerBackTitle: "Documents",
            headerTitleStyle: { fontWeight: "700" },
          }}
        >
          <Stack.Screen name="index" options={{ headerShown: false }} />
          <Stack.Screen name="profiles/new" options={{ title: "Add person" }} />
          <Stack.Screen name="profiles/[id]" options={{ title: "Person details" }} />
          <Stack.Screen name="documents/[id]" options={{ title: "Saved proof" }} />
          <Stack.Screen name="emergency-summary" options={{ title: "Offline summary" }} />
          <Stack.Screen name="runs/new" options={{ title: "Generate saved copy" }} />
          <Stack.Screen name="runs/[id]" options={{ title: "Getting proof" }} />
          <Stack.Screen name="settings" options={{ title: "Settings" }} />
        </Stack>
      </SafeAreaView>
      <PrivacyShield />
    </View>
  );
}

function ReminderSync() {
  const vault = useVault();
  useEffect(() => {
    if (vault.status !== "ready") return;
    void reconcileExpiryReminders(vault.results, vault.expiryRemindersEnabled).catch(
      () => {
        // The preference remains encrypted locally and reconciliation retries on change.
      }
    );
  }, [vault.expiryRemindersEnabled, vault.results, vault.status]);
  return null;
}

function NotificationNavigation() {
  useEffect(() => {
    const openResponse = (response: Notifications.NotificationResponse) => {
      const resultId = resultIdFromNotificationResponse(response);
      if (resultId) {
        router.push({ pathname: "/documents/[id]", params: { id: resultId } });
      }
    };
    const subscription =
      Notifications.addNotificationResponseReceivedListener(openResponse);
    void Notifications.getLastNotificationResponseAsync().then((response) => {
      if (response) {
        openResponse(response);
        void Notifications.clearLastNotificationResponseAsync();
      }
    });
    return () => subscription.remove();
  }, []);
  return null;
}

function PrivacyShield() {
  const theme = useAppTheme();
  const [covered, setCovered] = useState(false);

  useEffect(() => {
    const update = (state: string) => setCovered(state !== "active");
    update(AppState.currentState);
    const subscription = AppState.addEventListener("change", update);
    return () => subscription.remove();
  }, []);

  if (!covered) return null;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.privacyShield, { backgroundColor: theme.colors.inverse }]}
    >
      <ShieldCheck color={theme.colors.inverseText} size={34} />
      <Text style={[styles.privacyBrand, { color: theme.colors.inverseText }]}>
        eVisaFlow
      </Text>
      <Text style={[styles.privacyCaption, { color: theme.colors.inverseMuted }]}>
        Private screen
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  navigationRoot: { flex: 1 },
  navigationContent: { flex: 1 },
  privacyShield: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 1000,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  privacyBrand: { fontSize: 23, lineHeight: 29, fontWeight: "800" },
  privacyCaption: { fontSize: 13, lineHeight: 18, fontWeight: "600" },
});

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <VaultProvider>
        <ServiceProvider>
          <ServiceBootstrap />
          <LocalFileCleanup />
          <ReminderSync />
          <NotificationNavigation />
          <Navigation />
        </ServiceProvider>
      </VaultProvider>
    </SafeAreaProvider>
  );
}
