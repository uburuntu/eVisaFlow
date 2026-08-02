import assert from "node:assert/strict";
import test from "node:test";

const ENV_KEYS = [
  "TELEGRAM_BOT_TOKEN",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "ENCRYPTION_KEY",
  "QUEUE_CONCURRENCY",
  "EVISA_HEADLESS",
  "EVISA_DIAGNOSTICS_MODE",
  "HEALTH_PORT",
  "MOBILE_API_PORT",
  "MOBILE_API_HOST",
  "MOBILE_BETA_DAILY_RUN_LIMIT",
  "SCHEDULER_CRON",
  "SCHEDULE_INTERVAL_DAYS",
];

const baseEnv = {
  TELEGRAM_BOT_TOKEN: "telegram-token",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role",
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
    assert.equal(env.MOBILE_API_PORT, 8090);
    assert.equal(env.MOBILE_API_HOST, "0.0.0.0");
    assert.equal(env.MOBILE_BETA_DAILY_RUN_LIMIT, 25);
    assert.equal(env.SCHEDULE_INTERVAL_DAYS, 30);
  });
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
  await withEnv({ ...baseEnv, SUPABASE_URL: "not-a-url" }, async () => {
    const { loadEnv } = await importFreshEnv();
    assert.throws(() => loadEnv(), /SUPABASE_URL/);
  });

  await withEnv({ ...baseEnv, SCHEDULER_CRON: "not cron" }, async () => {
    const { loadEnv } = await importFreshEnv();
    assert.throws(() => loadEnv(), /SCHEDULER_CRON/);
  });
});

test("redactedEnvSummary omits secrets", async () => {
  await withEnv(baseEnv, async () => {
    const { loadEnv, redactedEnvSummary } = await importFreshEnv();
    const summary = redactedEnvSummary(loadEnv());

    assert.equal(summary.supabaseUrl, baseEnv.SUPABASE_URL);
    assert.equal("TELEGRAM_BOT_TOKEN" in summary, false);
    assert.equal("SUPABASE_SERVICE_ROLE_KEY" in summary, false);
    assert.equal("ENCRYPTION_KEY" in summary, false);
  });
});
