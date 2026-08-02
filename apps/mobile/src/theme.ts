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
    primaryMuted: string;
    primaryText: string;
    success: string;
    successMuted: string;
    warning: string;
    warningMuted: string;
    danger: string;
    dangerMuted: string;
    info: string;
    infoMuted: string;
    inverse: string;
    inverseMuted: string;
    inverseText: string;
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
    primaryMuted: "#DDEFEA",
    primaryText: "#FFFFFF",
    success: "#237A54",
    successMuted: "#E1F2E9",
    warning: "#A45A12",
    warningMuted: "#FFF0D8",
    danger: "#B42318",
    dangerMuted: "#FDECEA",
    info: "#255F85",
    infoMuted: "#E3EFF7",
    inverse: "#183B36",
    inverseMuted: "#A7C6BD",
    inverseText: "#FFFFFF",
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
    primaryMuted: "#203D36",
    primaryText: "#0E201C",
    success: "#5DC994",
    successMuted: "#203A2E",
    warning: "#E6A85B",
    warningMuted: "#3C3020",
    danger: "#FF8B82",
    dangerMuted: "#3B201E",
    info: "#84BFE4",
    infoMuted: "#203442",
    inverse: "#DDE9E5",
    inverseMuted: "#56726A",
    inverseText: "#10201C",
    input: "#1A201F",
    overlay: "rgba(0, 0, 0, 0.62)",
  },
};

export function useAppTheme(): AppTheme {
  return useColorScheme() === "dark" ? darkTheme : lightTheme;
}
