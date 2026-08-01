#!/usr/bin/env bash

set -euo pipefail

action="${1:-all}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${repo_root}"

apk_path="${MOBILE_E2E_ANDROID_APK:-apps/mobile/android/app/build/outputs/apk/release/app-release.apk}"
result_directory="${MOBILE_E2E_RESULTS_DIR:-apps/mobile/e2e/results/local-android}"
android_arch="${ANDROID_ARCH:-arm64-v8a}"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'Missing required command: %s\n' "$1" >&2
    exit 1
  fi
}

configure_android_tools() {
  local sdk_root
  sdk_root="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
  if [[ -z "${sdk_root}" ]]; then
    for sdk_root in "${HOME}/Library/Android/sdk" "${HOME}/Android/Sdk"; do
      if [[ -d "${sdk_root}" ]]; then
        break
      fi
    done
  fi

  if [[ ! -d "${sdk_root}" ]]; then
    printf '%s\n' 'Android SDK not found. Set ANDROID_HOME to its installation directory.' >&2
    exit 1
  fi

  export ANDROID_HOME="${sdk_root}"
  export ANDROID_SDK_ROOT="${sdk_root}"
  export PATH="${sdk_root}/platform-tools:${PATH}"
  require_command adb
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

  if command -v java >/dev/null 2>&1 && java_is_compatible "$(command -v java)"; then
    return
  fi

  if [[ "$(uname -s)" == "Darwin" ]]; then
    java_home="$(/usr/libexec/java_home -v 17 2>/dev/null || true)"
    if [[ -n "${java_home}" && -x "${java_home}/bin/java" ]] && \
      java_is_compatible "${java_home}/bin/java"; then
      export JAVA_HOME="${java_home}"
      export PATH="${JAVA_HOME}/bin:${PATH}"
      return
    fi
  fi

  printf '%s\n' 'Java 17 or newer is required.' >&2
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
  if [[ -n "${ANDROID_DEVICE:-}" ]]; then
    if ! adb devices | awk 'NR > 1 && $2 == "device" { print $1 }' | grep -Fxq "${ANDROID_DEVICE}"; then
      printf 'Android device %s is not connected and ready.\n' "${ANDROID_DEVICE}" >&2
      exit 1
    fi
    printf '%s' "${ANDROID_DEVICE}"
    return
  fi

  local selected_device
  selected_device="$(adb devices | awk 'NR > 1 && $2 == "device" { print $1; exit }')"
  if [[ -z "${selected_device}" ]]; then
    printf '%s\n' 'No ready Android device found. Boot an emulator in Android Studio first.' >&2
    exit 1
  fi
  printf '%s' "${selected_device}"
}

build_app() {
  configure_android_tools
  configure_java
  require_command pnpm

  pnpm run build:protocol
  pnpm --dir apps/mobile exec expo prebuild --platform android --no-install

  if [[ ! -x apps/mobile/android/gradlew ]]; then
    printf '%s\n' 'Expo did not generate the Android Gradle wrapper.' >&2
    exit 1
  fi

  (
    cd apps/mobile/android
    NODE_ENV=production ./gradlew :app:assembleRelease \
      -PreactNativeArchitectures="${android_arch}" \
      --no-daemon \
      --stacktrace
  )

  if [[ ! -f "${apk_path}" ]]; then
    printf 'No release APK was produced at %s.\n' "${apk_path}" >&2
    exit 1
  fi
}

run_tests() {
  configure_android_tools
  configure_java
  configure_maestro

  if [[ ! -f "${apk_path}" ]]; then
    printf 'Missing release APK at %s. Run this script with build or all first.\n' "${apk_path}" >&2
    exit 1
  fi

  case "${result_directory}" in
    apps/mobile/e2e/results/*) ;;
    *)
      printf 'Refusing to clean unsafe result directory: %s\n' "${result_directory}" >&2
      exit 1
      ;;
  esac

  local device_id flow_path flow_name flow_status test_status
  device_id="$(select_device)"
  rm -rf "${result_directory}"
  mkdir -p "${result_directory}/junit"
  adb -s "${device_id}" install -r "${apk_path}"

  export MAESTRO_CLI_NO_ANALYTICS=1
  test_status=0
  for flow_path in apps/mobile/e2e/maestro/flows/*.yaml; do
    flow_name="$(basename "${flow_path}" .yaml)"
    set +e
    maestro --device "${device_id}" test \
      --format JUNIT \
      --output "${result_directory}/junit/${flow_name}.xml" \
      --test-output-dir "${result_directory}/artifacts/${flow_name}" \
      --debug-output "${result_directory}/debug/${flow_name}" \
      "${flow_path}"
    flow_status=$?
    set -e
    if ((flow_status != 0)); then
      test_status="${flow_status}"
    fi
  done

  adb -s "${device_id}" logcat -d > "${result_directory}/logcat.txt" || true
  return "${test_status}"
}

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
