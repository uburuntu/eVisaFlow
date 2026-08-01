#!/usr/bin/env bash

set -euo pipefail

if (($# != 3)); then
  printf 'Usage: %s <ios|android> <results-directory> <output-directory>\n' "$0" >&2
  exit 2
fi

platform="$1"
results_directory="$2"
output_directory="$3/$platform"

case "$platform" in
  ios | android) ;;
  *)
    printf 'Unsupported platform: %s\n' "$platform" >&2
    exit 2
    ;;
esac

if [[ ! -d "$results_directory" ]]; then
  printf 'Results directory not found: %s\n' "$results_directory" >&2
  exit 1
fi

latest_match() {
  local pattern="$1"
  local latest=""
  local candidate
  while IFS= read -r -d '' candidate; do
    if [[ -z "$latest" || "$candidate" -nt "$latest" ]]; then
      latest="$candidate"
    fi
  done < <(find "$results_directory" -type f -path "$pattern" -print0)

  if [[ -z "$latest" ]]; then
    printf 'Required visual artifact not found: %s\n' "$pattern" >&2
    exit 1
  fi
  printf '%s' "$latest"
}

rm -rf "$output_directory"
mkdir -p "$output_directory"

for screenshot in \
  dashboard-before-proof \
  choose-purpose \
  security-code \
  saved-offline-proof \
  dashboard-with-offline-proof \
  privacy-settings; do
  cp "$(latest_match "*/takeScreenshot/${screenshot}.png")" \
    "$output_directory/${screenshot}.png"
done

cp "$(latest_match '*/startRecording/offline-proof-journey.mp4')" \
  "$output_directory/offline-proof-journey.mp4"

printf 'Collected %s visual review assets in %s\n' "$platform" "$output_directory"
