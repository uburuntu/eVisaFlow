import { router } from "expo-router";
import { StyleSheet, Text, View } from "react-native";
import { AppButton } from "@/components/AppButton";
import { useAppTheme } from "@/theme";

export default function NotFoundScreen() {
  const theme = useAppTheme();

  return (
    <View style={[styles.page, { backgroundColor: theme.colors.background }]}>
      <Text style={[styles.title, { color: theme.colors.text }]}>Page not found</Text>
      <AppButton onPress={() => router.replace("/")} title="Back to documents" />
    </View>
  );
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    gap: 18,
  },
  title: {
    fontSize: 22,
    fontWeight: "800",
  },
});
