install:
	npm install

build:
	npm run build

dev:
	npm run dev

lint:
	npm run lint

typecheck:
	npm run typecheck

run:
	npm start

snapshots:
	npm run snapshots

debug-flow: build
	node scripts/debug-flow.js

fixtures:
	npm run fixtures

test:
	npm test

.PHONY: install build dev lint typecheck run snapshots debug-flow fixtures test-steps
