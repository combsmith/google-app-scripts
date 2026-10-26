# Component Inventory

**Generated:** 2026-03-28 | **Scan Level:** Exhaustive

## Script Components

### gmail-to-drive-by-labels

| Function                                           | File                   | Type           | Description                                                                              |
| -------------------------------------------------- | ---------------------- | -------------- | ---------------------------------------------------------------------------------------- |
| `storeEmailsAndAttachments()`                      | code.gs                | GAS Entry      | Main trigger function — processes all configured label groups                            |
| `processLabelGroup(config)`                        | code.gs / src/index.js | Core           | Processes threads from one label, archives text + attachments                            |
| `processMessagesToDoc(messages, doc, folder, ...)` | src/index.js           | Core           | Processes array of messages, prepends to doc, saves attachments                          |
| `processMessageToDoc(message, doc, folder, ...)`   | src/index.js           | Core           | Processes single message — cleans body, handles attachments                              |
| `removeExistingThread(doc, threadId)`              | src/index.js           | Core           | Removes prior thread content from doc (deduplication)                                    |
| `rebuildAllDocs()`                                 | code.gs / src/index.js | GAS Entry      | Rebuilds all configured documents from processed threads                                 |
| `rebuildDoc(config, ...)`                          | src/index.js           | Core           | Rebuilds single document with state tracking                                             |
| `sortThreadsByLastMessageDate(threads)`            | src/index.js           | Utility        | Sorts threads by last message date ascending (oldest-first) for prepend-based processing |
| `getCleanBody(text)`                               | gas-utils.js           | Shared Utility | Strips quoted replies, legal footers, normalizes whitespace                              |
| `getFileHash(blob)`                                | gas-utils.js           | Shared Utility | SHA-256 hash for content-based attachment deduplication                                  |
| `getProcessConfig()`                               | config.gs              | Config         | Returns array of label/doc/folder configuration objects                                  |

### calendar-to-sheets

| Function                                    | File         | Type      | Description                                                                 |
| ------------------------------------------- | ------------ | --------- | --------------------------------------------------------------------------- |
| `syncAllCalendarsToSheetsGAS()`             | code.gs      | GAS Entry | Syncs all configured calendar/sheet pairs                                   |
| `syncCalendarToSheetGAS(startIso, endIso)`  | code.gs      | GAS Entry | Syncs calendars in the given date range with chunking support               |
| `fullResyncCalendarToSheetGAS(configIndex)` | code.gs      | GAS Entry | Clears checkpoint, full historical resync                                   |
| `_syncCalendarToSheetGAS(cfg, start, end)`  | code.gs      | Core      | Core sync logic for one config over a date range with checkpoint management |
| `syncCalendarToSheet(deps)`                 | src/index.js | Core      | Testable sync — upsert/delete event rows                                    |
| `eventToRow(event)`                         | src/index.js | Utility   | Converts calendar event to spreadsheet row array                            |
| `rowsToMap(rows)`                           | src/index.js | Utility   | Creates event ID → row index mapping                                        |
| `rowsEqual(a, b)`                           | src/index.js | Utility   | Compares rows with type flexibility                                         |
| `ensureHeader(sheet)`                       | src/index.js | Utility   | Ensures sheet has proper column headers                                     |
| `sanitizeValue(value)`                      | src/index.js | Security  | Prevents formula injection in cell values                                   |
| `getConfigs()` / `getConfig(index)`         | code.gs      | Config    | Configuration management with legacy support                                |
| `SYNC_CONFIGS`                              | config.gs    | Config    | Array of calendar/sheet mapping objects                                     |

### calendar-to-briefing-doc

| Function                                     | File         | Type      | Description                                        |
| -------------------------------------------- | ------------ | --------- | -------------------------------------------------- |
| `generateWeeklyBriefing()`                   | code.gs      | GAS Entry | Hourly trigger — checks schedule, generates if due |
| `generateBriefingForConfig(config, deps)`    | src/index.js | Core      | Main generator for single briefing configuration   |
| `fetchEvents(calendar, start, end)`          | src/index.js | Core      | Fetch events from single calendar                  |
| `fetchAllCalendarEvents(config, deps)`       | src/index.js | Core      | Fetch from all/selected calendars with tagging     |
| `detectConflicts(events)`                    | src/index.js | Core      | Identify overlapping calendar events               |
| `formatConflictWarning(conflicts)`           | src/index.js | Formatter | Format conflict warning text                       |
| `groupEventsByDay(events, tz)`               | src/index.js | Utility   | Group events by date                               |
| `formatDayLabel(dateStr)`                    | src/index.js | Formatter | Human-readable date label                          |
| `formatEventEntry(event)`                    | src/index.js | Formatter | Format single event with emoji indicators          |
| `formatBriefing(grouped, conflicts, config)` | src/index.js | Formatter | Assemble complete briefing text                    |
| `emailBriefing(config, body, deps)`          | src/index.js | Core      | Send briefing email via MailApp                    |
| `shouldRunNow(config, now)`                  | src/index.js | Utility   | Check if briefing should run (day/hour match)      |
| `getBriefingConfigs_()`                      | code.gs      | Config    | Get briefing configuration array                   |
| `BRIEFING_CONFIGS`                           | config.gs    | Config    | Array of briefing configuration objects            |

### Deploy Utility (src/deploy)

| Function                                             | File     | Type         | Description                                        |
| ---------------------------------------------------- | -------- | ------------ | -------------------------------------------------- |
| `getScriptCatalog()`                                 | index.js | Catalog      | Returns metadata for all 3 deployable scripts      |
| `getScriptById(id)`                                  | index.js | Catalog      | Look up script by ID                               |
| `buildProjectContent(scriptId)`                      | index.js | Builder      | Build API-compatible file structure for deployment |
| `createProject(name, accessToken)`                   | index.js | API          | Create new GAS project via REST API                |
| `updateProjectContent(scriptId, files, accessToken)` | index.js | API          | Upload files to GAS project                        |
| `deployScript(scriptId, name, accessToken)`          | index.js | Orchestrator | High-level deploy: create project + upload files   |
| `createGmailLabel(name, accessToken)`                | index.js | API          | Create Gmail label via REST API                    |

### Gas Installer (Legacy)

| Function                                | File         | Type        | Description                                              |
| --------------------------------------- | ------------ | ----------- | -------------------------------------------------------- |
| `getFileType(filename)`                 | src/index.js | Utility     | Map file extension to GAS API type enum                  |
| `filterGithubItems(items)`              | src/index.js | Utility     | Filter GitHub Contents API response for deployable files |
| `buildManifestFile()`                   | src/index.js | Builder     | Build appsscript.json manifest descriptor                |
| `buildDeploymentPayload(sourceFiles)`   | src/index.js | Builder     | Assemble complete files array for GAS API                |
| `deployScript(scriptName, accessToken)` | Code.gs      | GAS         | Fetch from GitHub + create GAS project                   |
| `getFilesFromGithub(scriptName)`        | Code.gs      | GAS         | Fetch script source files from GitHub API                |
| `doGet()`                               | Code.gs      | GAS Web App | Serve installer HTML UI                                  |

## UI Components (Deploy Page)

The `deploy/index.html` is a monolithic static SPA. Key logical sections:

| Section                       | Description                                                          |
| ----------------------------- | -------------------------------------------------------------------- |
| **Step 1: Authentication**    | Google Identity Services sign-in button, token management            |
| **Step 2: Script Selection**  | Checkboxes for each script, version badges, deploy/update buttons    |
| **Step 3: Configuration**     | Dynamic forms per script type with resource pickers                  |
| **Gmail Config Form**         | Label selector, Doc picker, Folder picker, batch size, multi-config  |
| **Calendar-to-Sheets Config** | Calendar selector, Spreadsheet picker, sheet name                    |
| **Briefing Config**           | Calendar selection mode, exclusion list, email recipients, schedule  |
| **Resource Creation Modals**  | Create Gmail labels, Google Docs, Drive folders, Spreadsheets inline |
| **Google Picker Integration** | Browse and select Drive resources via Google Picker API              |
| **Version Management**        | Detect outdated deployments, offer in-place updates                  |

## Shared Test Infrastructure

| Component                | File                | Description                                     |
| ------------------------ | ------------------- | ----------------------------------------------- |
| `installGlobals(global)` | test-utils/mocks.js | Installs all GAS mock globals                   |
| `resetAll(global)`       | test-utils/mocks.js | Resets all mocks between tests                  |
| Mock GmailApp            | test-utils/mocks.js | Threads, messages, labels, attachments          |
| Mock DriveApp            | test-utils/mocks.js | Files, folders, file creation                   |
| Mock DocumentApp         | test-utils/mocks.js | Document body manipulation, paragraph insertion |
| Mock CalendarApp         | test-utils/mocks.js | Calendars, events, date ranges                  |
| Mock SpreadsheetApp      | test-utils/mocks.js | Spreadsheets, sheets, ranges, cell values       |
| Mock PropertiesService   | test-utils/mocks.js | Script properties (checkpoint storage)          |
| Global Session           | test-utils/setup.js | `getScriptTimeZone()` → 'UTC'                   |
| Global Utilities         | test-utils/setup.js | `formatDate()`, `sleep()`, `computeDigest()`    |
| Global Logger            | test-utils/setup.js | `log()` no-op                                   |
