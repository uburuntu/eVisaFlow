/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />

interface ImportMetaEnv {
  /**
   * Public Telegram bot username (no `@`) for the Login Widget on `/login`.
   * Exposed to the browser (the widget needs it client-side); NOT the bot token.
   * When unset the widget area renders a configuration hint instead of the
   * (broken) widget, so a self-host without Telegram still builds and serves.
   */
  readonly PUBLIC_TELEGRAM_BOT_USERNAME?: string;
  /**
   * Absolute origin the site is deployed at (e.g. `https://evisaflow.uk`), used
   * for canonical and Open Graph URLs. Optional; falls back to the configured
   * `site` in `astro.config.mjs`.
   */
  readonly PUBLIC_SITE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
