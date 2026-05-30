import { createServer, type Server } from "node:http";
import type { Logger } from "./utils/logger.js";

export interface HealthSnapshot {
  ready: boolean;
  shuttingDown: boolean;
  startedAt: string;
  telegram?: {
    ready: boolean;
    username?: string;
    runnerRunning?: boolean;
  };
  db?: {
    ready: boolean;
  };
  supabase?: {
    ready: boolean;
  };
  queue: {
    active: number;
    waiting: number;
  };
}

export interface HealthServer {
  port: () => number | undefined;
  close: () => Promise<void>;
}

export function startHealthServer(
  port: number,
  log: Logger,
  snapshot: () => HealthSnapshot
): HealthServer {
  const server = createServer((req, res) => {
    const path = req.url?.split("?", 1)[0] ?? "/";
    const body = snapshot();
    const isLive = path === "/live" || path === "/healthz";
    const isReady = path === "/ready" || path === "/readyz";

    if (!isLive && !isReady) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
      return;
    }

    const ok = isLive ? !body.shuttingDown : body.ready && !body.shuttingDown;
    res.writeHead(ok ? 200 : 503, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });

  server.listen(port, "0.0.0.0", () => {
    log.info({ port }, "Health server listening");
  });

  return {
    port: () => {
      const address = server.address();
      return typeof address === "object" && address !== null ? address.port : undefined;
    },
    close: () => closeServer(server),
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}
