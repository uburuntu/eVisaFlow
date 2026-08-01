import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { useAppTheme } from "@/theme";
import { VaultProvider } from "@/vault/VaultContext";

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
          headerBackTitle: "Family",
          headerTitleStyle: { fontWeight: "700" },
        }}
      >
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="profiles/new" options={{ title: "Add person" }} />
        <Stack.Screen name="profiles/[id]" options={{ title: "Person details" }} />
      </Stack>
    </>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <VaultProvider>
        <Navigation />
      </VaultProvider>
    </SafeAreaProvider>
  );
}
