.DEFAULT_GOAL := help

IOS_WORKSPACE := apps/mobile/ios/eVisaFlow.xcworkspace
IOS_DEVICE ?=
ANDROID_DEVICE ?=
ANDROID_ARCH ?= arm64-v8a

help:
	@printf '%s\n' \
		'Targets:' \
		'  install      Install workspace dependencies with pnpm' \
		'  build        Build library and Telegram bot service' \
		'  dev          Watch-build the library' \
		'  mobile       Start the Expo mobile app' \
		'  mobile-ios   Build and launch the booted iOS simulator' \
		'  mobile-ios-device  Select iOS target (optional IOS_DEVICE="name")' \
		'  mobile-ios-prebuild  Generate the native iOS project' \
		'  mobile-ios-xcode  Generate and open the Xcode workspace' \
		'  mobile-e2e   Run Maestro mobile journeys on a booted device' \
		'  mobile-e2e-android  Build, install, and test a booted Android emulator' \
		'  mobile-e2e-ios  Build, install, and test iOS (optional IOS_DEVICE="name")' \
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

mobile-ios:
	pnpm --filter evisa-flow-mobile run ios

mobile-ios-device:
	pnpm --filter evisa-flow-mobile run ios --device $(if $(IOS_DEVICE),"$(IOS_DEVICE)")

mobile-ios-prebuild:
	pnpm run build:protocol
	pnpm --dir apps/mobile exec expo prebuild --platform ios

mobile-ios-xcode: mobile-ios-prebuild
	@test -d "$(IOS_WORKSPACE)" || { \
		printf '%s\n' 'Missing $(IOS_WORKSPACE); the Expo iOS prebuild did not complete.'; \
		exit 1; \
	}
	open "$(IOS_WORKSPACE)"

mobile-e2e:
	pnpm run e2e:mobile

mobile-e2e-android:
	ANDROID_DEVICE="$(ANDROID_DEVICE)" ANDROID_ARCH="$(ANDROID_ARCH)" scripts/mobile-e2e-android.sh

mobile-e2e-ios:
	pnpm run build:protocol
	pnpm --dir apps/mobile exec expo prebuild --platform ios --no-install
	cd apps/mobile/ios && pod install
	IOS_DEVICE="$(IOS_DEVICE)" scripts/mobile-e2e-ios.sh

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

.PHONY: help install build dev mobile mobile-ios mobile-ios-device mobile-ios-prebuild mobile-ios-xcode mobile-e2e mobile-e2e-android mobile-e2e-ios format lint typecheck run snapshots smoke debug-flow fixtures test validate
