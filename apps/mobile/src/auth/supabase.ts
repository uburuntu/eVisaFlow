import "react-native-url-polyfill/auto";

import { createClient, processLock } from "@supabase/supabase-js";
import { AppState, Platform } from "react-native";
import { encryptedSessionStorage } from "./secure-session-storage";

export interface MobileAuthSession {
  getAccessToken: () => Promise<string>;
  dispose: () => void;
}

export function createMobileAuthSession(
  supabaseUrl: string,
  publishableKey: string
): MobileAuthSession {
  const native = Platform.OS !== "web";
  const supabase = createClient(supabaseUrl, publishableKey, {
    auth: {
      ...(native ? { storage: encryptedSessionStorage } : {}),
      autoRefreshToken: native,
      persistSession: native,
      detectSessionInUrl: false,
      lock: processLock,
    },
  });
  let signIn: Promise<string> | null = null;

  const getAccessToken = async (): Promise<string> => {
    const { data, error } = await supabase.auth.getSession();
    if (error) throw error;
    if (data.session?.access_token) return data.session.access_token;

    signIn ??= supabase.auth
      .signInAnonymously()
      .then(({ data: anonymous, error: anonymousError }) => {
        if (anonymousError) throw anonymousError;
        if (!anonymous.session?.access_token) {
          throw new Error("The anonymous session did not return an access token.");
        }
        return anonymous.session.access_token;
      })
      .finally(() => {
        signIn = null;
      });
    return signIn;
  };

  if (native && AppState.currentState === "active") {
    supabase.auth.startAutoRefresh();
  }
  const subscription = native
    ? AppState.addEventListener("change", (state) => {
        if (state === "active") supabase.auth.startAutoRefresh();
        else supabase.auth.stopAutoRefresh();
      })
    : null;

  return {
    getAccessToken,
    dispose: () => {
      subscription?.remove();
      supabase.auth.stopAutoRefresh();
    },
  };
}
