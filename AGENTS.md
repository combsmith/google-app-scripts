# AGENTS.md — Agent Guidelines for this Repository

This file follows the AGENTS.md conventions (see https://agents.md/) and provides short, agent-friendly instructions for working with this repository. It is intended to be machine- and human-readable so coding agents and contributors can discover how to build, test, and interact with this project.

> **Organization standards:** This repo inherits shared standards from [combsmith/.github/AGENTS.md](https://github.com/combsmith/.github/blob/main/AGENTS.md). The sections below are project-specific.

> **GitHub Copilot users:** `.github/copilot-instructions.md` points here as the entry point for this repository's instructions; organization-wide guidance lives in the shared AGENTS.md linked above.

---

## Repository layout

- `src/<script-name>/code.gs` — runnable Apps Script code
- `src/<script-name>/config.gs` — configuration values for the script
- `src/<script-name>/src/index.js` — Node.js-testable logic extracted from `code.gs`
- `src/<script-name>/tests/` — Jest unit tests
- `src/gas-utils.js` — shared utility functions (e.g. `getCleanBody`)
- `test-utils/` — shared Jest helpers and mocks
- `scripts/` — CI helper scripts (e.g. coverage threshold checks)

---

## Quick setup

- Install dependencies (root):
  - `npm install`
- Run the test suite locally:
  - `npm test`
- Run a specific package/tests (replace `<agent-folder>` with the folder path):
  - npx jest "<agent-folder>/tests"

---

## Tests & CI (repo conventions)

- **Coverage thresholds:** 99% lines, 95% statements/functions, 85% branches. Verify locally with `npm test -- --coverage` (or `npx jest --coverage`) and ensure CI coverage meets these requirements. PRs that reduce coverage below these thresholds will be rejected.
- Before requesting review or marking a PR as ready:
  - Run `npm test` and ensure all tests pass locally
  - Run `npm test -- --coverage` and ensure coverage meets thresholds
  - Run `node scripts/check-coverage.js` to verify coverage requirements
- Use Jest for unit tests. Unit tests MUST be fast, deterministic, and not access external networks.
- Mock external services (Google Apps Script, HTTP calls) using `test-utils/` helpers where appropriate.
- Extract testable logic to `src/index.js` with `module.exports`, accepting GAS services as parameters. Tests inject global mocks via wrapper functions.
- Integration tests are allowed but MUST be clearly marked (e.g., `@integration`) and skippable in CI.
- The repository's `Node.js Tests` job runs package tests; ensure your package-level tests pass locally before opening a PR.

### Testing GAS functions

Google Apps Script `.gs` files cannot be `require()`-d in Jest. To test GAS logic:

1. Extract the function to `src/index.js` and export it with `module.exports`.
2. Accept GAS services (`GmailApp`, `DocumentApp`, etc.) as parameters rather than accessing globals.
3. In the test file, create a wrapper function that injects `global.GmailApp`, `global.DocumentApp`, etc.

GAS `code.gs` files may optionally include a guard for Jest imports:

```js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ... };
}
```

---

## Pull request reviews

- When addressing PR review comments, **always mark each resolved comment thread as Resolved** on GitHub after the fix is pushed. Use the GitHub GraphQL API via `gh api graphql` with the `resolveReviewThread` mutation:
  ```bash
  gh api graphql -f query='mutation { resolveReviewThread(input: {threadId: "PRRT_..."}) { thread { id isResolved } } }'
  ```
  Retrieve thread IDs first with a `reviewThreads` query on the pull request.
- Resolve all addressed threads in one pass after pushing the fix commit, not one at a time during implementation.

---

## Code style & commits

- ALWAYS run `npx prettier --write .` before committing — pre-commit hooks do not run in agent sessions, so formatting must be applied manually.
- ALWAYS ensure `npm run check` (prettier check + lint) passes before committing.
- ALWAYS ensure `npm run lint` and `npm test` passes before committing.
- ALWAYS ensure `npm test -- --coverage` passes before committing.

---

## Repository conventions

- Each script's runnable code lives in `code.gs`; configuration lives in `config.gs`.
- Thread separators use 30 `=` signs (`==============================`).
- Thread deduplication embeds the Gmail thread ID in the separator: `------------------------------[THREAD:threadId]`.
- When prepending content into a Google Doc with `insertParagraph(0, ...)`, process items oldest-first so the newest content ends up at the top.
- `getCleanBody()` (in `src/gas-utils.js`) normalizes line breaks: 3+ consecutive newlines → 2, and handles quoted-reply stripping.
- Always sort Gmail threads by last-message date before processing; the Gmail API does not guarantee order.

---

## How to use this file

- Agents will read the nearest AGENTS.md (this one is at the repo root).
- If a subproject needs different guidance, it may include its own `AGENTS.md` or a clear `README.md` explaining the differences.

---

## References

- AGENTS.md canonical guidance: https://agents.md/
- Example repository: https://github.com/agentsmd/agents.md/blob/main/AGENTS.md
