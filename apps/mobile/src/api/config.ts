export interface MobileServiceConfig {
  mode: "demo" | "live" | "unconfigured";
  apiUrl?: string;
  supabaseUrl?: string;
  supabasePublishableKey?: string;
}

export function loadMobileServiceConfig(): MobileServiceConfig {
  if (process.env.EXPO_PUBLIC_EVISAFLOW_DEMO_MODE === "true") {
    return { mode: "demo" };
  }

  const apiUrl = process.env.EXPO_PUBLIC_EVISAFLOW_API_URL;
  const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const supabasePublishableKey = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (apiUrl && supabaseUrl && supabasePublishableKey) {
    return { mode: "live", apiUrl, supabaseUrl, supabasePublishableKey };
  }
  return { mode: "unconfigured" };
}
