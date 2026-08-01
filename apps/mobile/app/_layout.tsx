import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { ShieldCheck } from "lucide-react-native";
import { useEffect, useState } from "react";
import { AppState, StyleSheet, Text, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ServiceProvider, useMobileService } from "@/api/ServiceContext";
import { useAppTheme } from "@/theme";
import { useVault, VaultProvider } from "@/vault/VaultContext";

function ServiceBootstrap() {
  const vault = useVault();
  const service = useMobileService();
  const {
    clearProfileSlotTombstone,
    hasAcceptedDisclosure,
    profileSlotTombstones,
    status: vaultStatus,
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
      })
      .catch(() => {
        // Offline startup is expected; a user action will retry the connection.
      });
    return () => {
      active = false;
    };
  }, [
    clearProfileSlotTombstone,
    connect,
    getClient,
    hasAcceptedDisclosure,
    mode,
    profileSlotTombstones,
    vaultStatus,
  ]);

  return null;
}

function Navigation() {
  const theme = useAppTheme();

  return (
    <>
      <StatusBar style={theme.isDark ? "light" : "dark"} />
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
        <Stack.Screen name="runs/new" options={{ title: "Get current proof" }} />
        <Stack.Screen name="runs/[id]" options={{ title: "Getting proof" }} />
        <Stack.Screen name="settings" options={{ title: "Settings" }} />
      </Stack>
      <PrivacyShield />
    </>
  );
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
          <Navigation />
        </ServiceProvider>
      </VaultProvider>
    </SafeAreaProvider>
  );
}
