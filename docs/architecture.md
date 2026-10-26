# Architecture

**Generated:** 2026-03-28 | **Scan Level:** Exhaustive

## Overview

The Google Apps Script Productivity Suite is a collection of automation scripts that run inside Google's Apps Script environment. The architecture bridges two distinct runtimes: **Google Apps Script V8** (production execution in the user's Google account) and **Node.js** (local development, testing, CI).

## Architecture Pattern

**Dual-runtime script collection with browser-based deployment layer.**

```text
┌─────────────────────────────────────────────────────────────┐
│                    User's Browser                            │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  deploy/index.html (Static SPA)                      │    │
│  │  - Google Identity Services OAuth                    │    │
│  │  - Apps Script REST API (create/update projects)     │    │
│  │  - Gmail/Calendar/Drive APIs (config UI)             │    │
│  │  - GitHub raw content fetch (source files)           │    │
│  └───────────────────────┬─────────────────────────────┘    │
└──────────────────────────┼──────────────────────────────────┘
                           │ Creates GAS project
                           ▼
┌─────────────────────────────────────────────────────────────┐
│              User's Google Apps Script Environment            │
│  ┌──────────────────┐ ┌──────────────────┐ ┌─────────────┐ │
│  │ gmail-to-drive    │ │ calendar-to-     │ │ calendar-to-│ │
│  │ -by-labels        │ │ sheets           │ │ briefing-doc│ │
│  │                   │ │                  │ │             │ │
│  │ code.gs           │ │ code.gs          │ │ code.gs     │ │
│  │ config.gs         │ │ config.gs        │ │ config.gs   │ │
│  └────────┬──────────┘ └────────┬─────────┘ └──────┬──────┘ │
│           │                     │                    │        │
│           ▼                     ▼                    ▼        │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  Google Workspace APIs                               │    │
│  │  GmailApp · DriveApp · DocumentApp · CalendarApp     │    │
│  │  SpreadsheetApp · PropertiesService · MailApp        │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│              Local Development (Node.js)                      │
│  ┌──────────────────┐  ┌──────────────────────────────┐     │
│  │  src/*/src/       │  │  test-utils/                  │     │
│  │  index.js         │◄─│  mocks.js (GAS global mocks) │     │
│  │  (pure logic)     │  │  setup.js (Jest globals)      │     │
│  └────────┬──────────┘  └──────────────────────────────┘     │
│           │                                                   │
│           ▼                                                   │
│  ┌─────────────────────────────────────────────────────┐     │
│  │  Jest (unit) + Playwright (E2E)                      │     │
│  │  Coverage: 100% lines, 95% statements/functions,     │     │
│  │           85% branches                               │     │
│  └─────────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────┘
```

## Key Architecture Decisions

### 1. Dual-File Pattern (code.gs + src/index.js)

**Decision:** Every script has GAS-native `code.gs` and a Node-testable `src/index.js` with the same logic.

**Rationale:** GAS `.gs` files cannot be `require()`-d in Node.js. Extracting pure logic to `index.js` with dependency injection (GAS services passed as parameters) enables comprehensive Jest testing without GAS runtime.

**Trade-off:** Logic must be kept in sync between `code.gs` and `src/index.js`. The `code.gs` acts as a thin wrapper calling into the extracted functions with real GAS globals.

### 2. Browser-Based Deployment (deploy/index.html)

**Decision:** A single static HTML file handles OAuth, project creation, and configuration — no server required.

**Rationale:** Users deploy scripts directly from their browser using Google Identity Services and the Apps Script REST API. No backend server needed, no `clasp` CLI dependency, and non-technical users can deploy without a terminal.

**Trade-off:** The deployment page is a large monolithic HTML file (~2500 lines) with inline JavaScript. This is intentional — it must work as a single static file served from GitHub Pages.

### 3. Configuration as Code (config.gs)

**Decision:** Each script uses a `config.gs` file with a function or variable returning an array of configuration objects.

**Patterns:**

- `getProcessConfig()` → array of label/doc/folder mappings (gmail-to-drive)
- `SYNC_CONFIGS` → array of calendar/sheet mappings (calendar-to-sheets)
- `BRIEFING_CONFIGS` → array of briefing settings (calendar-to-briefing-doc)

**Rationale:** GAS has no `.env` files. Using code-as-config lets the deploy UI write config programmatically via the Apps Script API, while still being human-editable.

### 4. Comprehensive Mock Infrastructure

**Decision:** `test-utils/mocks.js` provides full mock implementations of GmailApp, DriveApp, DocumentApp, CalendarApp, SpreadsheetApp, and PropertiesService (475 lines).

**Rationale:** Every GAS global is mocked with realistic behavior (document body manipulation, thread/message hierarchies, attachment handling, sheet cell operations). This enables integration-level tests in Jest without any Google API access.

### 5. Multi-Config Support

**Decision:** All scripts support arrays of configurations, enabling one deployed script instance to process multiple sources.

**Example:** A single gmail-to-drive deployment can process multiple Gmail labels, each archiving to different Google Docs and Drive folders.

## Script Architecture Details

### gmail-to-drive-by-labels

**Purpose:** Archive emails from Gmail labels into Google Docs (text) and Drive folders (attachments).

**Key mechanisms:**

- **Thread deduplication:** Embeds the thread ID in the message separator line `------------------------------[THREAD:<id>]` and uses a separate thread separator line `==============================`. Before processing, checks for existing thread content identified by these markers and removes it (idempotent reprocessing).
- **Attachment deduplication:** SHA-256 hash-based content dedup. If a file with the same hash exists in the target folder, skips upload. If same name but different content, renames with numeric suffix.
- **Prepend ordering:** Processes threads oldest-first with `insertParagraph(0, ...)` so newest content appears at the top of the document.
- **Batch processing:** Configurable `batchSize` (default 250 threads) to handle GAS execution time limits.
- **Label management:** Removes trigger label, adds processed label after archiving.
- **Rebuild capability:** `rebuildDoc()` and `rebuildAllDocs()` can reconstruct documents from all processed threads.

**Google APIs used:** GmailApp, DriveApp, DocumentApp, Utilities (SHA-256)

### calendar-to-sheets

**Purpose:** Sync Google Calendar events into Google Sheets with upsert/delete semantics.

**Key mechanisms:**

- **Checkpoint system:** Uses PropertiesService to store sync tokens for incremental updates. Only fetches changed events since last sync.
- **Upsert logic:** Maps event IDs to sheet rows. Updates existing rows on change, inserts new rows, deletes rows for cancelled events.
- **Formula injection prevention:** `sanitizeValue()` prefixes cell values starting with `=`, `+`, `-`, `@` with a single quote to prevent spreadsheet formula injection.
- **Chunked sync:** `syncCalendarToSheetGAS()` supports batching for large calendars.
- **Full resync:** `fullResyncCalendarToSheetGAS()` clears checkpoint and re-syncs entire history.
- **Event deletion scoping:** Only deletes rows for events within the sync time window, preserving historical data.

**Google APIs used:** CalendarApp, SpreadsheetApp, PropertiesService

### calendar-to-briefing-doc

**Purpose:** Generate weekly calendar briefing emails with conflict detection.

**Key mechanisms:**

- **Schedule-aware:** `shouldRunNow()` checks current day/hour against configuration to determine if briefing should be generated. Designed for hourly trigger.
- **Multi-calendar support:** Can aggregate events from all calendars or specific ones, with exclusion list.
- **Conflict detection:** `detectConflicts()` identifies overlapping events and generates warnings.
- **Calendar source labeling:** Tags events with their source calendar name.
- **Rich formatting:** Groups events by day, formats with emoji indicators, includes location, description, and conflict warnings.
- **Email delivery:** Sends formatted briefing via MailApp to configured recipients.

**Google APIs used:** CalendarApp, MailApp, Session

## Authentication & Security

- **Deploy UI OAuth:** Uses Google Identity Services with scopes for `script.projects`, `drive.readonly`, `gmail.labels`, `calendar.readonly`, `email`
- **GAS runtime:** Scripts run with the deploying user's permissions — no separate auth
- **No secrets in code:** Configuration values are written to `config.gs` in the user's GAS project, not stored in the repository
- **Formula injection prevention:** Calendar-to-sheets sanitizes cell values
- **HTML escaping:** Gas-installer UI escapes output to prevent XSS
- **CodeQL scanning:** Automated security analysis on every push/PR

## Testing Strategy

| Layer             | Tool                  | Scope                                                                                         | Coverage Target                                       |
| ----------------- | --------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Unit tests        | Jest (ts-jest)        | `src/*/src/index.js`, `src/gas-utils.js`, `gas-installer/src/index.js`, `src/deploy/index.js` | 100% lines, 95% statements/functions, 85% branches    |
| Integration tests | Jest                  | Full pipeline simulation with mocks                                                           | Included in unit coverage                             |
| E2E tests         | Playwright (Chromium) | `deploy/index.html`, `gas-installer/Index.html`                                               | Functional coverage of OAuth, deploy, configure flows |
| Static analysis   | TypeScript (`noEmit`) | All `.js` and `.ts` files                                                                     | Type safety without transpilation                     |
| Security          | CodeQL                | JavaScript codebase                                                                           | Automated vulnerability detection                     |

**Testing pattern for GAS code:**

1. Extract logic from `code.gs` to `src/index.js`
2. Accept GAS services as parameters (dependency injection)
3. In tests, inject mocks from `test-utils/mocks.js`
4. Some GAS `code.gs` files may use guard: `if (typeof module !== 'undefined' && module.exports) { ... }` (not all scripts include this)

## Deployment Architecture

**Primary:** Browser-based deployment via `deploy/index.html`

1. User authenticates with Google Identity Services
2. Page fetches script source files from GitHub (raw content URLs)
3. Creates GAS project via Apps Script REST API
4. Uploads source files to the project
5. User configures script via interactive UI (Gmail labels, calendars, Drive resources)
6. Configuration written to `config.gs` via Apps Script API
7. User sets up time-based triggers in the GAS editor

**Legacy:** GAS-based installer web app (`gas-installer/`)

- Deployed as a GAS web app
- Fetches source from GitHub API, creates projects via Apps Script API
- Simpler UI, fewer configuration options

**CI/CD:** GitHub Actions

- 6 workflows covering lint, test, coverage, E2E, security, and dependency management
- Auto-fix formatting on same-repo PRs
- Auto-merge minor/patch dependabot PRs
