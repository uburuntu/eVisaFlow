#!/usr/bin/env bash
set -euo pipefail

readonly VERSION="${MAESTRO_VERSION:-2.7.0}"
readonly EXPECTED_VERSION="2.7.0"
readonly EXPECTED_SHA256="a4ccab6b604617e7aef6db4f885666056eabe5cfa32befaa3bc994041b8fcbb5"
readonly INSTALL_ROOT="${MAESTRO_INSTALL_DIR:-${HOME}/.maestro}"
readonly BINARY="${INSTALL_ROOT}/maestro/bin/maestro"

if [[ "${VERSION}" != "${EXPECTED_VERSION}" ]]; then
  printf 'No verified checksum is recorded for Maestro %s\n' "${VERSION}" >&2
  exit 1
fi
if [[ -x "${BINARY}" ]] && "${BINARY}" --version | grep -Fq "${VERSION}"; then
  printf 'Maestro %s is already installed.\n' "${VERSION}"
else
  work_directory="$(mktemp -d)"
  trap 'rm -rf "${work_directory}"' EXIT
  archive="${work_directory}/maestro.zip"

  curl --fail --location --show-error --silent \
    "https://github.com/mobile-dev-inc/Maestro/releases/download/cli-${VERSION}/maestro.zip" \
    --output "${archive}"

  actual_sha256="$(shasum -a 256 "${archive}" | awk '{print $1}')"
  if [[ "${actual_sha256}" != "${EXPECTED_SHA256}" ]]; then
    printf 'Maestro archive checksum mismatch.\n' >&2
    exit 1
  fi

  rm -rf "${INSTALL_ROOT}/maestro"
  mkdir -p "${INSTALL_ROOT}"
  unzip -q "${archive}" -d "${INSTALL_ROOT}"
  "${BINARY}" --version
fi

if [[ -n "${GITHUB_PATH:-}" ]]; then
  printf '%s\n' "${INSTALL_ROOT}/maestro/bin" >> "${GITHUB_PATH}"
else
  printf 'Add %s to PATH.\n' "${INSTALL_ROOT}/maestro/bin"
fi
