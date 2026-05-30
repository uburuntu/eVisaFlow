import assert from "node:assert/strict";
import test from "node:test";

const ENV_KEYS = [
  "DEPLOYMENT_MODE",
  "ENABLE_BOT",
  "TELEGRAM_BOT_TOKEN",
  "DATABASE_URL",
  "ENCRYPTION_KEY",
  "QUEUE_CONCURRENCY",
  "EVISA_HEADLESS",
  "EVISA_DIAGNOSTICS_MODE",
  "HEALTH_PORT",
  "SCHEDULER_CRON",
  "SCHEDULE_INTERVAL_DAYS",
  "SESSION_SECRET",
];

// Web-first defaults: only DATABASE_URL is required for a pure-web (bot-off)
// deployment. The bot token and encryption key are required ONLY when
// ENABLE_BOT is true, so they are NOT part of the minimal base env.
const baseEnv = {
  DATABASE_URL: "postgres://postgres:postgres@localhost:5432/evisaflow",
};

// Adds the credentials the Telegram bot needs on top of the web-only base.
const botEnv = {
  ...baseEnv,
  ENABLE_BOT: "true",
  TELEGRAM_BOT_TOKEN: "telegram-token",
  ENCRYPTION_KEY: "a".repeat(64),
};

const withEnv = async (values, fn) => {
  const previous = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
  Object.assign(process.env, values);

  try {
    return await fn();
  } finally {
    for (const key of ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
};

const importFreshEnv = () => import(`../dist/env.js?test=${Date.now()}-${Math.random()}`);

test("loadEnv parses required values and applies defaults", async () => {
  await withEnv(baseEnv, async () => {
    const { loadEnv } = await importFreshEnv();
    const env = loadEnv();

    assert.equal(env.QUEUE_CONCURRENCY, 2);
    assert.equal(env.EVISA_HEADLESS, true);
    assert.equal(env.EVISA_DIAGNOSTICS_MODE, "sanitized_on_failure");
    assert.equal(env.HEALTH_PORT, 8080);
    assert.equal(env.SCHEDULE_INTERVAL_DAYS, 30);
    // Web-first deployment defaults.
    assert.equal(env.DEPLOYMENT_MODE, "selfhost");
    assert.equal(env.ENABLE_BOT, false);
  });
});

test("loadEnv defaults to a bot-less self-host with only DATABASE_URL", async () => {
  // The minimal pure-web deployment: no Telegram token, no encryption key.
  await withEnv(baseEnv, async () => {
    const { loadEnv } = await importFreshEnv();
    const env = loadEnv();

    assert.equal(env.ENABLE_BOT, false);
    assert.equal(env.DEPLOYMENT_MODE, "selfhost");
    assert.equal(env.TELEGRAM_BOT_TOKEN, undefined);
    assert.equal(env.ENCRYPTION_KEY, undefined);
  });
});

test("DEPLOYMENT_MODE accepts cloud and rejects unknown values", async () => {
  await withEnv({ ...baseEnv, DEPLOYMENT_MODE: "cloud" }, async () => {
    const { loadEnv } = await importFreshEnv();
    assert.equal(loadEnv().DEPLOYMENT_MODE, "cloud");
  });

  await withEnv({ ...baseEnv, DEPLOYMENT_MODE: "staging" }, async () => {
    const { loadEnv } = await importFreshEnv();
    assert.throws(() => loadEnv(), /DEPLOYMENT_MODE/);
  });
});

test("ENABLE_BOT requires TELEGRAM_BOT_TOKEN and ENCRYPTION_KEY", async () => {
  // Bot on but no token/key → both surface as required.
  await withEnv({ ...baseEnv, ENABLE_BOT: "true" }, async () => {
    const { loadEnv } = await importFreshEnv();
    assert.throws(() => loadEnv(), /TELEGRAM_BOT_TOKEN/);
    assert.throws(() => loadEnv(), /ENCRYPTION_KEY/);
  });

  // Bot on with a token but still no key → only the key is missing.
  await withEnv(
    { ...baseEnv, ENABLE_BOT: "true", TELEGRAM_BOT_TOKEN: "telegram-token" },
    async () => {
      const { loadEnv } = await importFreshEnv();
      assert.throws(() => loadEnv(), /ENCRYPTION_KEY/);
    }
  );

  // Bot on with both → parses, and the values are surfaced.
  await withEnv(botEnv, async () => {
    const { loadEnv } = await importFreshEnv();
    const env = loadEnv();
    assert.equal(env.ENABLE_BOT, true);
    assert.equal(env.TELEGRAM_BOT_TOKEN, "telegram-token");
    assert.equal(env.ENCRYPTION_KEY, "a".repeat(64));
  });
});

test("bot token and encryption key are NOT required when ENABLE_BOT is false", async () => {
  // Explicitly off, omitting both credentials, still parses.
  await withEnv({ ...baseEnv, ENABLE_BOT: "false" }, async () => {
    const { loadEnv } = await importFreshEnv();
    const env = loadEnv();
    assert.equal(env.ENABLE_BOT, false);
    assert.equal(env.TELEGRAM_BOT_TOKEN, undefined);
    assert.equal(env.ENCRYPTION_KEY, undefined);
  });
});

test("blank bot/SMTP/session placeholders are treated as unset (bot off)", async () => {
  // A real .env (and docker-compose env_file) routinely ships blank placeholder
  // lines like `TELEGRAM_BOT_TOKEN=`. With the bot OFF these must be read as unset
  // — NOT as invalid empty strings — so a pure-web self-host carrying the
  // placeholders still boots. (Regression: empty strings used to fail .min().)
  await withEnv(
    {
      ...baseEnv,
      ENABLE_BOT: "false",
      TELEGRAM_BOT_TOKEN: "",
      ENCRYPTION_KEY: "",
      SESSION_SECRET: "",
    },
    async () => {
      const { loadEnv } = await importFreshEnv();
      const env = loadEnv();
      assert.equal(env.ENABLE_BOT, false);
      assert.equal(env.TELEGRAM_BOT_TOKEN, undefined);
      assert.equal(env.ENCRYPTION_KEY, undefined);
      assert.equal(env.SESSION_SECRET, undefined);
    }
  );
});

test("blank bot credentials with the bot ON give the conditional required error", async () => {
  // Blank (not omitted) token/key + ENABLE_BOT=true must surface the friendly
  // "required when ENABLE_BOT is true" message, not a raw length error.
  await withEnv(
    { ...baseEnv, ENABLE_BOT: "true", TELEGRAM_BOT_TOKEN: "", ENCRYPTION_KEY: "" },
    async () => {
      const { loadEnv } = await importFreshEnv();
      assert.throws(
        () => loadEnv(),
        /TELEGRAM_BOT_TOKEN is required when ENABLE_BOT is true/
      );
      assert.throws(
        () => loadEnv(),
        /ENCRYPTION_KEY is required when ENABLE_BOT is true/
      );
    }
  );
});

test("loadEnv parses explicit false booleans", async () => {
  await withEnv({ ...baseEnv, EVISA_HEADLESS: "false" }, async () => {
    const { loadEnv } = await importFreshEnv();
    assert.equal(loadEnv().EVISA_HEADLESS, false);
  });

  await withEnv({ ...baseEnv, EVISA_HEADLESS: "0" }, async () => {
    const { loadEnv } = await importFreshEnv();
    assert.equal(loadEnv().EVISA_HEADLESS, false);
  });
});

test("loadEnv rejects invalid encryption keys", async () => {
  await withEnv(
    {
      ...baseEnv,
      ENCRYPTION_KEY: "not-hex",
    },
    async () => {
      const { loadEnv } = await importFreshEnv();
      assert.throws(() => loadEnv(), /ENCRYPTION_KEY/);
    }
  );
});

test("loadEnv rejects invalid URLs and cron expressions", async () => {
  await withEnv({ ...baseEnv, DATABASE_URL: "not-a-url" }, async () => {
    const { loadEnv } = await importFreshEnv();
    assert.throws(() => loadEnv(), /DATABASE_URL/);
  });

  await withEnv({ ...baseEnv, SCHEDULER_CRON: "not cron" }, async () => {
    const { loadEnv } = await importFreshEnv();
    assert.throws(() => loadEnv(), /SCHEDULER_CRON/);
  });
});

test("redactedEnvSummary omits secrets and reports deployment shape", async () => {
  await withEnv(baseEnv, async () => {
    const { loadEnv, redactedEnvSummary } = await importFreshEnv();
    const summary = redactedEnvSummary(loadEnv());

    // The host:port/database is surfaced for diagnostics; credentials are dropped.
    assert.equal(summary.databaseHost, "localhost:5432/evisaflow");
    assert.equal("DATABASE_URL" in summary, false);
    assert.equal("TELEGRAM_BOT_TOKEN" in summary, false);
    assert.equal("ENCRYPTION_KEY" in summary, false);
    // Deployment shape is surfaced (not the credentials) so the boot log shows
    // whether this is a bot-less web deployment.
    assert.equal(summary.deploymentMode, "selfhost");
    assert.equal(summary.botEnabled, false);
  });

  // With the bot enabled, botEnabled flips but the token is still never surfaced.
  await withEnv(botEnv, async () => {
    const { loadEnv, redactedEnvSummary } = await importFreshEnv();
    const summary = redactedEnvSummary(loadEnv());
    assert.equal(summary.botEnabled, true);
    assert.equal("TELEGRAM_BOT_TOKEN" in summary, false);
    assert.equal("ENCRYPTION_KEY" in summary, false);
  });
});

test("SESSION_SECRET is optional, validated for length, and never surfaced", async () => {
  // Optional: the minimal web deployment parses without it.
  await withEnv(baseEnv, async () => {
    const { loadEnv, redactedEnvSummary } = await importFreshEnv();
    const env = loadEnv();
    assert.equal(env.SESSION_SECRET, undefined);
    // Reported as an un-configured (false) flag — never the value.
    assert.equal(redactedEnvSummary(env).sessionSecretConfigured, false);
  });

  // Too short → rejected (>=32 chars enforced).
  await withEnv({ ...baseEnv, SESSION_SECRET: "short" }, async () => {
    const { loadEnv } = await importFreshEnv();
    assert.throws(() => loadEnv(), /SESSION_SECRET/);
  });

  // A long-enough secret parses; the summary reports configured=true but the
  // value itself is never present in the summary.
  const secret = "x".repeat(32);
  await withEnv({ ...baseEnv, SESSION_SECRET: secret }, async () => {
    const { loadEnv, redactedEnvSummary } = await importFreshEnv();
    const env = loadEnv();
    assert.equal(env.SESSION_SECRET, secret);
    const summary = redactedEnvSummary(env);
    assert.equal(summary.sessionSecretConfigured, true);
    assert.equal("SESSION_SECRET" in summary, false);
    assert.equal(JSON.stringify(summary).includes(secret), false);
  });
});
