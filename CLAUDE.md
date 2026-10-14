@https://github.com/combsmith/.github/blob/main/AGENTS.md
@AGENTS.md

> **Org-wide standards:** This project inherits shared development standards from [combsmith/.github/AGENTS.md](https://github.com/combsmith/.github/blob/main/AGENTS.md).

# Google Apps Script — Claude Code Project Context

This file provides Claude Code-specific instructions. For comprehensive agent guidelines (repo layout, setup, testing, code style, PR reviews), see [AGENTS.md](./AGENTS.md).

## Quick Reference

- **Install:** `npm install`
- **Test (includes coverage):** `npm test`
- **Lint + format check:** `npm run check`
- **Format:** `npx prettier --write .`

## Key Rules

1. **TDD is mandatory** — write tests before implementation, include tests in the same PR
2. **Coverage thresholds** — 99% lines, 95% statements/functions, 85% branches
3. **Avoid coverage-ignore comments and `.skip()`** — only use in rare, unavoidable cases (per AGENTS.md) with clear justification
4. **GAS testing pattern** — extract logic to `src/index.js` with `module.exports`, inject GAS services as parameters
5. **Always run** `npx prettier --write .` before committing — pre-commit hooks don't run in agent sessions
6. **Always run** `npm run check` (lint + format) and `npm test` (tests + coverage) before committing

## Architecture

- `src/<script-name>/code.gs` — Apps Script entry point
- `src/<script-name>/config.gs` — configuration
- `src/<script-name>/src/index.js` — testable extracted logic
- `src/<script-name>/tests/` — Jest unit tests
- `src/gas-utils.js` — shared utilities
- `test-utils/` — shared Jest helpers/mocks

See [AGENTS.md](./AGENTS.md) for full details.
