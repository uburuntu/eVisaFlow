import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
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
      </Stack>
    </>
  );
}

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
