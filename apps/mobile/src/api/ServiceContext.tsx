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
import {
  clearPendingAccountDeletion,
  hasPendingAccountDeletion,
  markPendingAccountDeletion,
} from "@/auth/secure-session-storage";
import { createMobileAuthSession, type MobileAuthSession } from "@/auth/supabase";
import { type MobileApi, MobileApiClient, MobileApiRequestError } from "./client";
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
  accountDeletionPending: boolean;
  getClient: () => MobileApi;
  connect: () => Promise<MobileMe>;
  deleteAccount: () => Promise<void>;
  deferAccountDeletion: () => Promise<void>;
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
  const [accountDeletionPending, setAccountDeletionPending] = useState(false);
  const connectionRef = useRef<Promise<MobileMe> | null>(null);
  const pendingDeletionRef = useRef<Promise<void> | null>(null);

  useEffect(() => () => runtime.auth?.dispose(), [runtime]);
  useEffect(() => {
    let active = true;
    void hasPendingAccountDeletion()
      .then((pending) => {
        if (active) setAccountDeletionPending(pending);
      })
      .catch(() => {
        // A corrupt session is handled when authentication is next required.
      });
    return () => {
      active = false;
    };
  }, []);

  const getClient = useCallback(() => {
    if (!runtime.client) throw new MobileServiceUnavailableError();
    return runtime.client;
  }, [runtime]);

  const completePendingAccountDeletion = useCallback(() => {
    if (pendingDeletionRef.current) return pendingDeletionRef.current;
    const operation = Promise.resolve()
      .then(async () => {
        if (!(await hasPendingAccountDeletion())) return;
        try {
          await getClient().deleteAccount();
        } catch (deletionError) {
          if (
            !(deletionError instanceof MobileApiRequestError) ||
            deletionError.code !== "AUTH_INVALID"
          ) {
            throw deletionError;
          }
        }
        if (runtime.auth) await runtime.auth.signOut();
        else await clearPendingAccountDeletion();
        setAccountDeletionPending(false);
      })
      .finally(() => {
        pendingDeletionRef.current = null;
      });
    pendingDeletionRef.current = operation;
    return operation;
  }, [getClient, runtime.auth]);

  useEffect(() => {
    if (runtime.mode === "unconfigured") return;
    let active = true;
    void completePendingAccountDeletion().catch(() => {
      if (active) setAccountDeletionPending(true);
    });
    return () => {
      active = false;
    };
  }, [completePendingAccountDeletion, runtime.mode]);

  const connect = useCallback(() => {
    if (connectionRef.current) return connectionRef.current;
    setStatus("connecting");
    setError(null);
    const operation = Promise.resolve()
      .then(() => completePendingAccountDeletion())
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
  }, [completePendingAccountDeletion, getClient]);

  const deleteAccount = useCallback(async () => {
    await connectionRef.current?.catch(() => undefined);
    if (runtime.client) await runtime.client.deleteAccount();
    await runtime.auth?.signOut();
    runtime.auth?.dispose();
    connectionRef.current = null;
    setAccountDeletionPending(false);
    setMe(null);
    setError(null);
    setStatus("idle");
    setRuntime(createRuntime());
  }, [runtime]);

  const deferAccountDeletion = useCallback(async () => {
    await connectionRef.current?.catch(() => undefined);
    await markPendingAccountDeletion();
    setAccountDeletionPending(true);
    setMe(null);
    setError(null);
    setStatus("idle");
  }, []);

  const value = useMemo<ServiceContextValue>(
    () => ({
      mode: runtime.mode,
      status,
      me,
      error,
      accountDeletionPending,
      getClient,
      connect,
      deleteAccount,
      deferAccountDeletion,
    }),
    [
      accountDeletionPending,
      connect,
      deferAccountDeletion,
      deleteAccount,
      error,
      getClient,
      me,
      runtime.mode,
      status,
    ]
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
