# Deployment Guide

**Generated:** 2026-03-28 | **Scan Level:** Exhaustive

## Deployment Model

Scripts deploy into the **user's own Google Apps Script environment**. There is no centralized server — each user gets their own copy of the script running under their Google account permissions.

## Deployment Methods

### Method 1: Browser-Based Deployment (Recommended)

**Tool:** `deploy/index.html` — static SPA served from GitHub Pages or locally.

**Flow:**

1. Open `deploy/index.html` in browser
2. Sign in with Google (OAuth via Google Identity Services)
3. Select script(s) to deploy
4. Click Deploy — creates GAS project with source files from GitHub
5. Configure — interactive UI to select Gmail labels, calendars, Drive resources
6. Configuration is written directly to `config.gs` in the user's GAS project
7. User sets up time-based triggers in GAS editor

**OAuth Scopes Required:**

| Scope               | Purpose                                               |
| ------------------- | ----------------------------------------------------- |
| `script.projects`   | Create and update Apps Script projects                |
| `drive.file`        | Drive Picker selections and projects this app created |
| `gmail.labels`      | Read existing Gmail labels and create new ones        |
| `calendar.readonly` | Read calendar list for dropdowns                      |
| `email`             | Identify the signed-in user                           |

**Features:**

- Inline Gmail label creation directly from the configuration UI
- Multi-configuration support (multiple label/doc/folder sets per script)
- Config persistence (loads existing config when re-opening)
- Version detection and in-place updates
- localStorage for idempotency tracking

### Method 2: Manual Copy-Paste

1. Navigate to script folder (e.g., `src/gmail-to-drive-by-labels/`)
2. Copy `code.gs` and `config.gs` into a new [Google Apps Script project](https://script.google.com/)
3. Edit `config.gs` with your resource IDs
4. Follow script-specific README for setup

### Method 3: Legacy GAS Installer (gas-installer/)

A Google Apps Script web app that fetches source from GitHub and creates projects via the Apps Script API. Simpler UI, fewer features than the browser deployment page.

## Post-Deployment Setup

### Setting Up Triggers

After deployment, users must configure time-based triggers in the GAS editor:

| Script                   | Trigger Function              | Recommended Schedule                    |
| ------------------------ | ----------------------------- | --------------------------------------- |
| gmail-to-drive-by-labels | `storeEmailsAndAttachments`   | Every 5-15 minutes                      |
| calendar-to-sheets       | `syncAllCalendarsToSheetsGAS` | Every 15-60 minutes                     |
| calendar-to-briefing-doc | `generateWeeklyBriefing`      | Every hour (schedule logic is internal) |

### GCP Setup (Fork Maintainers Only)

If you fork this repository and want the browser deployment to work:

1. **Enable APIs** in Google Cloud Console:
   - Google Apps Script API
   - Gmail API
   - Google Calendar API
   - Google Drive API

2. **Configure OAuth Consent Screen:**
   - Set to External
   - Add required scopes (`script.projects`, `drive.file` — remove `drive.readonly` if present, `gmail.labels`, `calendar.readonly`)
   - Add test users while in Testing mode

3. **Create OAuth Client ID:**
   - Type: Web application
   - Add authorized JavaScript origins (GitHub Pages URL or localhost)
   - Copy Client ID into `deploy/index.html` (`OAUTH_CLIENT_ID` constant)
   - Ensure scopes match: `script.projects`, `drive.file`, `gmail.labels`, `calendar.readonly`, `email`

## CI/CD Pipeline

CI runs automatically on push to `main` and on pull requests:

```text
PR opened/updated
    │
    ├── ci.yml ──────── Lint, format, typecheck
    │                   Auto-fix + push on same-repo PRs
    │
    ├── nodejs-tests.yml ── Jest unit tests (all packages)
    │
    ├── playwright-tests.yml ── Playwright E2E tests
    │
    ├── coverage.yml ──── Coverage enforcement (100% lines)
    │
    └── codeql-analysis.yml ── Security scanning
```

**Dependabot:** Weekly checks for npm and GitHub Actions updates. Minor/patch updates auto-merge via `dependabot-automerge.yml` using a GitHub App token.

## No Server Infrastructure

This project has **no server-side deployment**. All code runs either:

- In the user's Google Apps Script environment (production)
- In the user's browser (deployment UI)
- In GitHub Actions (CI/CD)
- On the developer's machine (local testing)
