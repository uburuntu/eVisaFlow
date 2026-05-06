.DEFAULT_GOAL := help

help:
	@printf '%s\n' \
		'Targets:' \
		'  install      Install workspace dependencies with pnpm' \
		'  build        Build library and Telegram bot service' \
		'  dev          Watch-build the library' \
		'  format       Format and apply safe Biome fixes' \
		'  lint         Run Biome CI checks' \
		'  typecheck    Typecheck library and service' \
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
	node scripts/debug-flow.js

fixtures:
	pnpm run fixtures

test:
	pnpm test

validate:
	pnpm run validate

.PHONY: help install build dev format lint typecheck run snapshots smoke debug-flow fixtures test validate
