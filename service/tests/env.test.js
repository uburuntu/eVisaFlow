import assert from "node:assert/strict";
import test from "node:test";

const ENV_KEYS = [
  "TELEGRAM_BOT_TOKEN",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "ENCRYPTION_KEY",
  "QUEUE_CONCURRENCY",
  "EVISA_OUTPUT_DIR",
  "EVISA_HEADLESS",
  "SCHEDULER_CRON",
  "SCHEDULE_INTERVAL_DAYS",
];

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
  await withEnv(
    {
      TELEGRAM_BOT_TOKEN: "telegram-token",
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service-role",
      ENCRYPTION_KEY: "a".repeat(64),
    },
    async () => {
      const { loadEnv } = await importFreshEnv();
      const env = loadEnv();

      assert.equal(env.QUEUE_CONCURRENCY, 2);
      assert.equal(env.EVISA_OUTPUT_DIR, "./downloads");
      assert.equal(env.EVISA_HEADLESS, true);
      assert.equal(env.SCHEDULE_INTERVAL_DAYS, 30);
    }
  );
});

test("loadEnv rejects invalid encryption keys", async () => {
  await withEnv(
    {
      TELEGRAM_BOT_TOKEN: "telegram-token",
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service-role",
      ENCRYPTION_KEY: "not-hex",
    },
    async () => {
      const { loadEnv } = await importFreshEnv();
      assert.throws(() => loadEnv());
    }
  );
});
