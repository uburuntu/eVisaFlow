# @evisa-flow/protocol

Platform-neutral contracts shared by the library, Telegram service, future mobile
API, and Expo app.

The canonical source is `../../src/protocol/`. This workspace compiles that source to
its own `dist/` so React Native never imports Playwright or Node-only modules. Do not
create a second set of contract files inside this package.

```sh
pnpm run build:protocol
pnpm run typecheck:protocol
```

New public transport fields need a runtime Zod schema, an exported TypeScript type,
and a protocol test. Keep secrets and personal values out of errors, event metadata,
URLs, and logs.
