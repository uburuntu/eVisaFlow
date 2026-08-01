import { useColorScheme } from "react-native";

export interface AppTheme {
  isDark: boolean;
  colors: {
    background: string;
    surface: string;
    surfaceMuted: string;
    text: string;
    textMuted: string;
    border: string;
    primary: string;
    primaryPressed: string;
    primaryText: string;
    success: string;
    warning: string;
    danger: string;
    dangerMuted: string;
    input: string;
    overlay: string;
  };
}

const lightTheme: AppTheme = {
  isDark: false,
  colors: {
    background: "#F5F7F8",
    surface: "#FFFFFF",
    surfaceMuted: "#EDF1F2",
    text: "#18201F",
    textMuted: "#5D6866",
    border: "#D5DDDB",
    primary: "#126B5B",
    primaryPressed: "#0C5548",
    primaryText: "#FFFFFF",
    success: "#237A54",
    warning: "#A45A12",
    danger: "#B42318",
    dangerMuted: "#FDECEA",
    input: "#FFFFFF",
    overlay: "rgba(24, 32, 31, 0.44)",
  },
};

const darkTheme: AppTheme = {
  isDark: true,
  colors: {
    background: "#111514",
    surface: "#1A201F",
    surfaceMuted: "#242B29",
    text: "#F3F6F5",
    textMuted: "#AAB5B2",
    border: "#36413E",
    primary: "#55C2A7",
    primaryPressed: "#78D0BB",
    primaryText: "#0E201C",
    success: "#5DC994",
    warning: "#E6A85B",
    danger: "#FF8B82",
    dangerMuted: "#3B201E",
    input: "#1A201F",
    overlay: "rgba(0, 0, 0, 0.62)",
  },
};

export function useAppTheme(): AppTheme {
  return useColorScheme() === "dark" ? darkTheme : lightTheme;
}
