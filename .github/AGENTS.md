# GitHub automation agent notes

## Required checks
- `.github/workflows/ci.yml` runs Expo alignment, Biome, all workspace typechecks and
  builds, core/protocol tests, service tests, mobile unit tests, package dry-run,
  production audit, and both Docker image smoke checks.
- `.github/workflows/mobile-e2e.yml` builds native release apps and runs fixture-backed
  Maestro on hosted Android and iOS for mobile-facing changes and scheduled checks.
- Keep workflow concurrency cancellation so superseded PR commits do not waste native
  runner time.

## Visual review contract
- Every mobile-facing PR must end with one successful `Publish visual review` job.
- The job downloads both platform artifacts, calls
  `scripts/collect-mobile-visuals.sh`, and requires every named screenshot and video.
- Publish review media to the isolated `mobile-visuals/pr-<number>` branch, never to
  the product branch. Force-updating that isolated branch is intentional.
- Update the existing bot comment marked `<!-- evisaflow-mobile-visuals -->`; do not
  create a new comment on each run.
- The comment must state that all displayed identity data and artifacts are fictional,
  link the exact immutable asset commit, show both 200% text positions, link both
  videos, and link the originating CI run.
- `.github/workflows/mobile-visual-review-cleanup.yml` removes the isolated asset
  branch when its PR closes.

## Security and reproducibility
- Mobile CI builds with `EXPO_PUBLIC_EVISAFLOW_DEMO_MODE=true` and must not receive
  production identity credentials, Supabase service-role keys, or GOV.UK accounts.
- Pin toolchain versions/checksums where the repository already does so, including the
  verified Maestro installer. Do not pipe unverified remote installers into a shell.
- Preserve JUnit, debug output, native logs, and failure binaries with explicit
  retention periods.
- Keep Android KVM setup deterministic and iOS simulator selection explicit.
- Visual assets are review evidence, not a source of truth; schemas, tests, and native
  build gates must still pass.

## Workflow changes
- Validate locally before pushing: `make validate`, `actionlint`, and `shellcheck` for
  modified shell runners.
- Use current maintained major versions of GitHub/Docker actions. Resolve deprecation
  annotations rather than normalizing them.
- Avoid spending hosted iOS/Android minutes on syntax or type errors discoverable
  locally.
- Do not reduce timeouts below demonstrated cold-cache release-build times without
  measured evidence.
