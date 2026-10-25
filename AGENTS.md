# Repository guide

## Layout and tools

- `ts-redalert2/`: React/TypeScript game, Vite frontend, Bun gateway and tests.
- `pvpgn-server/`: C++ PvPGN server. Keep its existing conventions and license notices.
- `deploy/`, `Dockerfile`, `compose.yaml`: combined deployment and resource preparation.
- Use Bun with the committed `ts-redalert2/bun.lock`; install with `bun install --frozen-lockfile`. Docker currently uses Bun 1.3.14. Do not rewrite lockfiles as part of unrelated changes.
- Run frontend commands from `ts-redalert2/`. Use `bun run dev:bun` for the HTTPS development server on port 4000. Repository-wide Compose commands run from the root.

## Implementation

- Inspect the working tree and relevant code before editing. Preserve unrelated user changes.
- Follow existing TypeScript conventions and `@/` imports; keep changes focused on the requested behavior.
- Game simulation and built-in AI must remain deterministic: use simulation ticks and the game random API, with stable tie-breaking. Do not use wall-clock timing or `Math.random()` for gameplay decisions.
- Issue AI commands through the existing actions/production APIs. Preserve visibility rules, resource costs, prerequisites and unit ownership. Avoid repeatedly interrupting attack animations or pathfinding with redundant orders.
- Preserve numeric enums, packet formats and shared simulation behavior used by online games and replays. Consider effects on saved lobby options when changing difficulty choices.
- Keep normal and highest-difficulty behavior explicit. Stronger AI needs scenario-based evidence; do not claim unbeatable behavior based on unit tests alone.
- Evaluate AI upgrades against a frozen historical bot and previous candidates in the real simulation. Use fixed seeds, swap starting positions, keep resources and game handicaps identical, and retain per-game metrics. Report time limits as draws, runtime failures as errors, and compare more than one map before generalizing win rates.
- Do not commit game resource archives, dependencies, build outputs, credentials or local runtime data. Preserve existing license and attribution notices.

## Verification

- Add focused regression tests for gameplay, strategy, production and networking changes, including failure cases. Documentation-only changes need a diff/link review rather than a full suite.
- Run `bun run typecheck:entry`, `bun run typecheck:server` and `bun run build` for affected TypeScript changes.
- Run focused tests during development and `bun test` before finishing gameplay changes. Existing resource tests use `/tmp/opencode`; create it with `mkdir -p /tmp/opencode` first.
- Real PvPGN tests require `PVPGN_TEST_PREFIX`. Resource tests require their documented `RA2_*` inputs. Report skipped tests and missing prerequisites accurately.
- Browser multiplayer verification uses `bun run test:online` with an existing Chrome and a running game service; see `ts-redalert2/README.md` for modes and configuration.
- Review `git diff --check` and the final diff. Report what changed, validation results and any unverified behavior. Push when the user has authorized repository updates; never force-push as a routine step.
