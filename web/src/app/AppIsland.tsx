/**
 * The eVisaFlow app island — the single `client:only` React root mounted at
 * `/app`. Everything interactive (and all libsodium/WASM) lives behind this
 * boundary, so the marketing/login pages stay zero-JS.
 *
 * Boot sequence:
 *   1. Initialise libsodium (WASM) and fetch `GET /api/auth/me` in parallel.
 *   2. Not signed in → redirect to `/login` (the session cookie is HttpOnly, so
 *      the island can't read it; it must ask the server).
 *   3. Signed in → render the vault gate until a key pair is held in memory
 *      (setup-with-recovery-kit for a new vault, unlock for a returning one).
 *   4. Unlocked → render the app shell (nav + routed screen + a Lock button).
 *
 * The vault key material lives only in {@link VaultProvider} state for the tab's
 * lifetime and is wiped on lock/close; nothing here persists it.
 */
import { type ReactElement, useEffect, useState } from "react";
import { getMe, logout, type Me } from "./lib/api-client.js";
import { navigate, type Route, useRoute } from "./runtime/router.js";
import { ensureSodium } from "./runtime/sodium.js";
import { useVault, VaultProvider } from "./runtime/vault-context.js";
import { AddMember } from "./screens/AddMember.js";
import { Dashboard } from "./screens/Dashboard.js";
import { History } from "./screens/History.js";
import { RunScreen } from "./screens/RunScreen.js";
import { VaultGate } from "./screens/VaultGate.js";
import { Banner, Button, LoadingState } from "./ui/primitives.js";

/** Where to send an unauthenticated visitor. */
const LOGIN_PATH = "/login";

export default function AppIsland(): ReactElement {
  return (
    <VaultProvider>
      <Boot />
    </VaultProvider>
  );
}

type BootState =
  | { phase: "loading" }
  | { phase: "unauthenticated" }
  | { phase: "error" }
  | { phase: "ready"; me: Me };

/** Handles auth + libsodium init, then hands off to the gate or the shell. */
function Boot(): ReactElement {
  const [state, setState] = useState<BootState>({ phase: "loading" });

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        // libsodium and the session check are independent; do them together.
        const [, me] = await Promise.all([ensureSodium(), getMe()]);
        if (!active) return;
        if (!me) {
          setState({ phase: "unauthenticated" });
          return;
        }
        setState({ phase: "ready", me });
      } catch {
        if (active) setState({ phase: "error" });
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (state.phase === "unauthenticated") {
      window.location.assign(LOGIN_PATH);
    }
  }, [state.phase]);

  if (state.phase === "loading") {
    return (
      <div className="app-frame app-frame--center">
        <LoadingState label="Loading your secure session…" />
      </div>
    );
  }
  if (state.phase === "unauthenticated") {
    return (
      <div className="app-frame app-frame--center">
        <LoadingState label="Redirecting to sign in…" />
      </div>
    );
  }
  if (state.phase === "error") {
    return (
      <div className="app-frame app-frame--center">
        <div className="stack" style={{ maxWidth: "32rem" }}>
          <Banner tone="error">
            We couldn't start the app. Check your connection and refresh.
          </Banner>
          <Button onClick={() => window.location.reload()}>Refresh</Button>
        </div>
      </div>
    );
  }

  return <Authenticated me={state.me} />;
}

/** Signed-in: gate on the vault, then render the shell. */
function Authenticated({ me }: { me: Me }): ReactElement {
  const { isUnlocked } = useVault();

  if (!isUnlocked) {
    return (
      <div className="app-frame app-frame--center">
        <VaultGate hasVault={me.hasVault} />
      </div>
    );
  }

  return <AppShell me={me} />;
}

/** The unlocked app: header with nav + lock/sign-out, and the routed screen. */
function AppShell({ me }: { me: Me }): ReactElement {
  const route = useRoute();
  const { lock } = useVault();

  async function onSignOut(): Promise<void> {
    // Drop the in-memory key first, then end the server session.
    lock();
    try {
      await logout();
    } finally {
      window.location.assign(LOGIN_PATH);
    }
  }

  return (
    <div className="app-frame">
      <AppHeader route={route} onLock={lock} onSignOut={onSignOut} me={me} />
      <main className="app-main container container--narrow" id="app-main">
        <Screen route={route} />
      </main>
    </div>
  );
}

/** Renders the screen for the current route. */
function Screen({ route }: { route: Route }): ReactElement {
  switch (route.name) {
    case "dashboard":
      return <Dashboard />;
    case "add-member":
      return <AddMember />;
    case "run":
      return <RunScreen runId={route.runId} memberId={route.memberId} />;
    case "history":
      return <History />;
  }
}

/** In-app header: brand, primary nav, and account controls. */
function AppHeader({
  route,
  onLock,
  onSignOut,
  me,
}: {
  route: Route;
  onLock: () => void;
  onSignOut: () => void;
  me: Me;
}): ReactElement {
  const navItems: { route: Route; label: string }[] = [
    { route: { name: "dashboard" }, label: "Dashboard" },
    { route: { name: "history" }, label: "History" },
  ];
  return (
    <header className="app-header">
      <div className="container app-header__inner">
        <a className="app-header__brand" href="/">
          <span className="seal-dot" aria-hidden="true" /> eVisaFlow
        </a>
        <nav className="app-nav" aria-label="App sections">
          {navItems.map((item) => (
            <button
              key={item.label}
              type="button"
              className="app-nav__link"
              aria-current={route.name === item.route.name ? "page" : undefined}
              onClick={() => navigate(item.route)}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <div className="app-header__account">
          <span className="app-header__user" title={me.email ?? undefined}>
            {me.email ?? (me.telegramLinked ? "Telegram account" : "Signed in")}
          </span>
          <button type="button" className="linklike" onClick={onLock}>
            Lock
          </button>
          <button type="button" className="linklike" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </div>
    </header>
  );
}
