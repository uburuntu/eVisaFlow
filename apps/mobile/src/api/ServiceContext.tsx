import type { MobileMe } from "@evisa-flow/protocol";
import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createMobileAuthSession, type MobileAuthSession } from "@/auth/supabase";
import { type MobileApi, MobileApiClient } from "./client";
import { loadMobileServiceConfig } from "./config";
import { DemoMobileApiClient } from "./demo";

type ServiceStatus = "idle" | "connecting" | "ready" | "error";

export class MobileServiceUnavailableError extends Error {
  constructor() {
    super("The mobile service is not configured in this build.");
    this.name = "MobileServiceUnavailableError";
  }
}

interface ServiceContextValue {
  mode: "demo" | "live" | "unconfigured";
  status: ServiceStatus;
  me: MobileMe | null;
  error: Error | null;
  getClient: () => MobileApi;
  connect: () => Promise<MobileMe>;
  deleteAccount: () => Promise<void>;
}

const ServiceContext = createContext<ServiceContextValue | null>(null);

interface Runtime {
  mode: ServiceContextValue["mode"];
  client: MobileApi | null;
  auth: MobileAuthSession | null;
}

export function ServiceProvider({ children }: PropsWithChildren) {
  const [runtime, setRuntime] = useState<Runtime>(createRuntime);
  const [status, setStatus] = useState<ServiceStatus>("idle");
  const [me, setMe] = useState<MobileMe | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const connectionRef = useRef<Promise<MobileMe> | null>(null);

  useEffect(() => () => runtime.auth?.dispose(), [runtime]);

  const getClient = useCallback(() => {
    if (!runtime.client) throw new MobileServiceUnavailableError();
    return runtime.client;
  }, [runtime]);

  const connect = useCallback(() => {
    if (connectionRef.current) return connectionRef.current;
    setStatus("connecting");
    setError(null);
    const operation = Promise.resolve()
      .then(() => getClient().getMe())
      .then((nextMe) => {
        setMe(nextMe);
        setStatus("ready");
        return nextMe;
      })
      .catch((connectionError: unknown) => {
        const normalized =
          connectionError instanceof Error
            ? connectionError
            : new Error("The mobile service could not be reached.");
        setError(normalized);
        setStatus("error");
        throw normalized;
      })
      .finally(() => {
        connectionRef.current = null;
      });
    connectionRef.current = operation;
    return operation;
  }, [getClient]);

  const deleteAccount = useCallback(async () => {
    await connectionRef.current?.catch(() => undefined);
    if (runtime.client) await runtime.client.deleteAccount();
    await runtime.auth?.signOut();
    runtime.auth?.dispose();
    connectionRef.current = null;
    setMe(null);
    setError(null);
    setStatus("idle");
    setRuntime(createRuntime());
  }, [runtime]);

  const value = useMemo<ServiceContextValue>(
    () => ({
      mode: runtime.mode,
      status,
      me,
      error,
      getClient,
      connect,
      deleteAccount,
    }),
    [connect, deleteAccount, error, getClient, me, runtime.mode, status]
  );
  return <ServiceContext.Provider value={value}>{children}</ServiceContext.Provider>;
}

function createRuntime(): Runtime {
  const config = loadMobileServiceConfig();
  if (config.mode === "demo") {
    return { mode: "demo", client: new DemoMobileApiClient(), auth: null };
  }
  if (
    config.mode === "live" &&
    config.apiUrl &&
    config.supabaseUrl &&
    config.supabasePublishableKey
  ) {
    const auth = createMobileAuthSession(
      config.supabaseUrl,
      config.supabasePublishableKey
    );
    return {
      mode: "live",
      client: new MobileApiClient({
        baseUrl: config.apiUrl,
        getAccessToken: auth.getAccessToken,
      }),
      auth,
    };
  }
  return { mode: "unconfigured", client: null, auth: null };
}

export function useMobileService(): ServiceContextValue {
  const context = useContext(ServiceContext);
  if (!context) throw new Error("useMobileService must be used inside ServiceProvider.");
  return context;
}
