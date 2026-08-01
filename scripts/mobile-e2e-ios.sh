#!/usr/bin/env bash

set -euo pipefail

action="${1:-all}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${repo_root}"

bundle_id="com.evisaflow.mobile"
simulator_access_group="FAKETEAMID.${bundle_id}"
build_directory="apps/mobile/e2e/build/ios"
entitlements_path="apps/mobile/e2e/ios-simulator.entitlements"
result_directory="${MOBILE_E2E_RESULTS_DIR:-apps/mobile/e2e/results/local-ios}"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'Missing required command: %s\n' "$1" >&2
    exit 1
  fi
}

configure_java() {
  java_is_compatible() {
    local specification_version major
    specification_version="$(
      "$1" -XshowSettings:properties -version 2>&1 |
        awk -F'= ' '/java.specification.version/ { print $2; exit }'
    )"
    major="${specification_version%%.*}"
    [[ "${major}" =~ ^[0-9]+$ ]] && ((major >= 17))
  }

  if [[ -n "${JAVA_HOME:-}" && -x "${JAVA_HOME}/bin/java" ]] && \
    java_is_compatible "${JAVA_HOME}/bin/java"; then
    return
  fi

  local java_home java_prefix
  for java_prefix in /opt/homebrew/opt/openjdk@17 /usr/local/opt/openjdk@17; do
    if [[ -x "${java_prefix}/bin/java" ]] && java_is_compatible "${java_prefix}/bin/java"; then
      export JAVA_HOME="${java_prefix}"
      export PATH="${java_prefix}/bin:${PATH}"
      return
    fi
  done

  java_home="$(/usr/libexec/java_home -v 17 2>/dev/null || true)"
  if [[ -n "${java_home}" && -x "${java_home}/bin/java" ]] && \
    java_is_compatible "${java_home}/bin/java"; then
    export JAVA_HOME="${java_home}"
    export PATH="${JAVA_HOME}/bin:${PATH}"
    return
  fi

  printf '%s\n' 'Java 17 is required. Install it with: brew install openjdk@17' >&2
  exit 1
}

configure_maestro() {
  if command -v maestro >/dev/null 2>&1; then
    return
  fi

  if [[ -x "${HOME}/.maestro/maestro/bin/maestro" ]]; then
    export PATH="${HOME}/.maestro/maestro/bin:${PATH}"
    return
  fi

  printf '%s\n' 'Maestro is required. Install the pinned version with: scripts/install-maestro.sh' >&2
  exit 1
}

select_device() {
  if [[ -n "${DEVICE_ID:-}" ]]; then
    printf '%s' "${DEVICE_ID}"
    return
  fi

  local device_id
  if [[ -n "${IOS_DEVICE:-}" ]]; then
    device_id="$(
      xcrun simctl list devices available -j |
        jq -r --arg name "${IOS_DEVICE}" \
          '[.devices[][] | select(.name == $name)] | first | .udid // empty'
    )"
  else
    device_id="$(
      xcrun simctl list devices available -j |
        jq -r '[.devices[][] | select(.state == "Booted" and (.name | startswith("iPhone")))] | first | .udid // empty'
    )"
    if [[ -z "${device_id}" ]]; then
      device_id="$(
        xcrun simctl list devices available -j |
          jq -r '[.devices[][] | select(.name | startswith("iPhone"))] | first | .udid // empty'
      )"
    fi
  fi

  if [[ -z "${device_id}" ]]; then
    printf 'No available iPhone simulator matched IOS_DEVICE=%q.\n' "${IOS_DEVICE:-}" >&2
    exit 1
  fi

  printf '%s' "${device_id}"
}

find_workspace() {
  find apps/mobile/ios -maxdepth 1 -name '*.xcworkspace' -print -quit
}

find_app() {
  find "${build_directory}/Build/Products" -maxdepth 2 -name '*.app' -print -quit
}

build_app() {
  require_command codesign
  require_command xcodebuild

  local workspace scheme app_path app_bundle_id executable signature_entitlements
  workspace="$(find_workspace)"
  if [[ -z "${workspace}" ]]; then
    printf '%s\n' 'Missing iOS workspace. Run: make mobile-ios-prebuild' >&2
    exit 1
  fi

  scheme="$(basename "${workspace}" .xcworkspace)"
  printf 'Building %s for simulator %s...\n' "${scheme}" "${device_id}"
  xcodebuild \
    -workspace "${workspace}" \
    -scheme "${scheme}" \
    -configuration Release \
    -sdk iphonesimulator \
    -destination "platform=iOS Simulator,id=${device_id}" \
    -derivedDataPath "${build_directory}" \
    ONLY_ACTIVE_ARCH=YES \
    -quiet \
    build

  app_path="$(find_app)"
  if [[ -z "${app_path}" ]]; then
    printf '%s\n' "No simulator app was produced under ${build_directory}." >&2
    exit 1
  fi

  app_bundle_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "${app_path}/Info.plist")"
  if [[ "${app_bundle_id}" != "${bundle_id}" ]]; then
    printf 'Expected bundle ID %s, got %s.\n' "${bundle_id}" "${app_bundle_id}" >&2
    exit 1
  fi

  # Ad-hoc simulator builds do not receive Apple's default Keychain group. The
  # first signature embeds a simulator-only group; the second leaves the launch
  # signature unrestricted while retaining the Mach-O entitlement section.
  codesign --force --sign - \
    --entitlements "${entitlements_path}" \
    --timestamp=none \
    --generate-entitlement-der \
    "${app_path}"
  codesign --force --sign - --timestamp=none "${app_path}"
  codesign --verify --deep --strict --verbose=2 "${app_path}"

  executable="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "${app_path}/Info.plist")"
  if ! rg -Fq "${simulator_access_group}" < <(strings "${app_path}/${executable}"); then
    printf '%s\n' 'The simulator Keychain access group was not embedded.' >&2
    exit 1
  fi

  signature_entitlements="$(codesign -d --entitlements - "${app_path}" 2>&1)"
  if rg -q 'application-identifier|keychain-access-groups' <<< "${signature_entitlements}"; then
    printf '%s\n' 'Simulator entitlements must not remain in the launch signature.' >&2
    exit 1
  fi
}

run_tests() {
  configure_java
  configure_maestro

  local app_path test_status
  app_path="$(find_app)"
  if [[ -z "${app_path}" ]]; then
    printf '%s\n' 'Missing simulator app. Run this script with build or all first.' >&2
    exit 1
  fi

  export MAESTRO_CLI_NO_ANALYTICS=1
  case "${result_directory}" in
    apps/mobile/e2e/results/*) ;;
    *)
      printf 'Refusing to clean unsafe result directory: %s\n' "${result_directory}" >&2
      exit 1
      ;;
  esac
  rm -rf "${result_directory}"
  mkdir -p "${result_directory}"
  xcrun simctl boot "${device_id}" >/dev/null 2>&1 || true
  xcrun simctl bootstatus "${device_id}" -b
  xcrun simctl uninstall "${device_id}" "${bundle_id}" >/dev/null 2>&1 || true
  xcrun simctl install "${device_id}" "${app_path}"

  set +e
  maestro --device "${device_id}" test \
    --format JUNIT \
    --output "${result_directory}/junit.xml" \
    --test-output-dir "${result_directory}/artifacts" \
    --debug-output "${result_directory}/debug" \
    apps/mobile/e2e/maestro/flows
  test_status=$?
  set -e

  xcrun simctl spawn "${device_id}" log show \
    --last 15m \
    --style compact \
    --predicate 'process == "eVisaFlow"' \
    > "${result_directory}/simulator.log" || true
  return "${test_status}"
}

require_command jq
require_command rg
require_command xcrun
device_id="$(select_device)"

case "${action}" in
  build)
    build_app
    ;;
  test)
    run_tests
    ;;
  all)
    build_app
    run_tests
    ;;
  *)
    printf 'Usage: %s [build|test|all]\n' "$0" >&2
    exit 2
    ;;
esac
