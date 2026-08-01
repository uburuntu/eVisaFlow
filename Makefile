.DEFAULT_GOAL := help

help:
	@printf '%s\n' \
		'Targets:' \
		'  install      Install workspace dependencies with pnpm' \
		'  build        Build library and Telegram bot service' \
		'  dev          Watch-build the library' \
		'  mobile       Start the Expo mobile app' \
		'  mobile-e2e   Run Maestro mobile journeys on a booted device' \
		'  format       Format and apply safe Biome fixes' \
		'  lint         Run Biome CI checks' \
		'  typecheck    Typecheck all TypeScript workspaces' \
		'  test         Run library and service tests' \
		'  validate     Run full local validation' \
		'  snapshots    Capture GOV.UK page snapshots' \
		'  smoke        Run live GOV.UK smoke checks' \
		'  fixtures     Refresh sanitized fixtures from debug HTML' \
		'  debug-flow   Run local headed debug flow'

install:
	pnpm install

build:
	pnpm run build

dev:
	pnpm run dev

mobile:
	pnpm run dev:mobile

mobile-e2e:
	pnpm run e2e:mobile

format:
	pnpm run format

lint:
	pnpm run lint

typecheck:
	pnpm run typecheck

run:
	pnpm start

snapshots:
	pnpm run snapshots

smoke:
	pnpm run smoke:live

debug-flow: build
	@test -f scripts/debug-flow.js || { \
		printf '%s\n' 'Missing scripts/debug-flow.js. Start from scripts/debug-flow.example.js and add local test details.'; \
		exit 1; \
	}
	node scripts/debug-flow.js

fixtures:
	pnpm run fixtures

test:
	pnpm test

validate:
	pnpm run validate

.PHONY: help install build dev mobile mobile-e2e format lint typecheck run snapshots smoke debug-flow fixtures test validate
