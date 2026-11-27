# Google Apps Script Productivity Suite

[![Contributing](https://img.shields.io/badge/contributions-welcome-brightgreen.svg)](https://github.com/combsmith/.github/blob/main/CONTRIBUTING.md)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

![googleappscripts](docs/assets/header.jpg)

A collection of personal productivity scripts built on Google Apps Script. These tools are designed to automate repetitive tasks across Gmail, Google Drive, and Google Docs, helping you reclaim your time and keep your digital workspace organized.

Open sourced under the MIT License to help others build their own automation workflows.

> **Runs entirely in your own Google account.** Each script is two files you paste into a new Apps Script project — no add-on, no subscription, and no server of ours in between. [Install in 5 minutes ↓](#-getting-started)

## 📂 Script Catalog

| Script Name                  | Description                                                                                                                                                                                                                                       | Documentation                                           |
| :--------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :------------------------------------------------------ |
| **Gmail to Drive By Labels** | Automatically archives emails from specific Gmail labels into a Google Doc (text) and Google Drive Folder (attachments). Features robust text cleaning (removing quoted replies/legal footers) and smart content-based attachment de-duplication. | [View Readme](./src/gmail-to-drive-by-labels/README.md) |
| **Calendar to Sheets**       | Syncs Google Calendar events into a Google Sheet, keeping rows up to date on changes and deletions.                                                                                                                                               | [View Readme](./src/calendar-to-sheets/README.md)       |

## 🚀 Getting Started

### Option A — Copy-paste install (recommended)

Takes about five minutes and needs nothing but a browser. The script runs under your own account, so the only permission prompt you see is Google's own one for your project.

1. **Pick a script** from the catalog above and open its folder (e.g. [`src/gmail-to-drive-by-labels`](./src/gmail-to-drive-by-labels)).
2. **Create a project:** go to [script.google.com](https://script.google.com/) → **New project**.
3. **Paste the code:** replace the default `Code.gs` with the contents of the script's `code.gs`. Add a second file named `config` (**+ → Script**) and paste in `config.gs`.
4. **Configure:** edit the values in `config` (label names, Doc ID, folder ID, etc.) as described in that script's `README.md`.
5. **Run once and authorise:** select the main function (e.g. `storeEmailsAndAttachments` or `syncAllCalendarsToSheetsGAS`) and click **Run**. Google asks you to approve access for your own project.
6. **Schedule it:** open **Triggers** (clock icon) → **Add Trigger** → choose the main function and a time-driven interval, so it keeps running on its own.

   > **Calendar to Sheets:** do not schedule `syncAllCalendarsToSheetsGAS` directly. Time-driven triggers pass an event object as the first argument, which that function would read as a start date, so the sync would silently do nothing. Add this wrapper to your project and schedule `scheduledCalendarSync` instead:
   >
   > ```js
   > function scheduledCalendarSync() {
   >   syncAllCalendarsToSheetsGAS()
   > }
   > ```

Only the `code.gs` and `config.gs` files in the script's root folder are needed — any nested `src/` or `tests/` folders within that script's directory are only for development.

### Option B — Browser-based deployment (beta)

The [deployment page](https://combsmith.github.io/google-app-scripts/deploy/) creates the project, uploads the code and writes `config.gs` for you, with dropdowns and Drive pickers for your labels, calendars, Docs and folders.

It signs in through a shared OAuth client. If Google shows an "unverified app" screen or refuses the sign-in, use Option A instead.

The page is published as **CombSmith Script Deployer**. It runs only in your browser and never sends your Google data or sign-in token to CombSmith. [Homepage](https://combsmith.com/google-app-scripts/) · [Privacy policy](https://combsmith.com/google-app-scripts/privacy)

1. **Open the deployment page** — use the hosted version at [combsmith.github.io/google-app-scripts/deploy/](https://combsmith.github.io/google-app-scripts/deploy/), or open `deploy/index.html` locally.
2. **Sign in with Google** — authorise the page to create Apps Script projects and read your Gmail labels, calendars, and the Drive files you pick. Fork maintainers who want their own client ID: see the GCP setup section below.
3. **Select a script and click Deploy** — the page fetches the latest source files from this repository and creates a new Apps Script project in your account. A direct link to the new project is shown on success.
4. **Configure** — a **Configure** panel appears for each deployed script. Pick your resources, then click **Save Configuration** to write them to the project's `config.gs`.
5. **Activate the schedule** — the deployer uploads a `setup` function but does not run it. Open the new project, select `setup` in the function dropdown, click **Run**, and approve the authorization prompt. This creates the hourly time-driven trigger; until you do, nothing runs automatically.

   > **Calendar to Sheets:** do not run `setup` as generated. It schedules `syncAllCalendarsToSheetsGAS` directly, which silently does nothing. First add the `scheduledCalendarSync` wrapper from Option A, change `HOURLY_TRIGGER_FN` in `setup.gs` to `'scheduledCalendarSync'`, then run `setup`.

## ⚙️ One-Time GCP Setup (For Fork Maintainers)

If you fork this repository and want to use the browser-based deployment page or the GAS Installer Web App, you must manually configure your Google Cloud Platform project once before anything will work.

### Step 1: Enable Required APIs

1. Go to your [Google Cloud Console](https://console.cloud.google.com/).
2. Navigate to **APIs & Services → Library** and enable the following APIs:

   | API                        | Used for                                                                         |
   | :------------------------- | :------------------------------------------------------------------------------- |
   | **Google Apps Script API** | Creating and updating Apps Script projects (deploy steps 1–3)                    |
   | **Gmail API**              | Populating Gmail label dropdowns in Step 4 (configure)                           |
   | **Google Calendar API**    | Populating calendar dropdowns in Step 4 (configure)                              |
   | **Google Drive API**       | Drive Picker for selecting Docs, folders, and spreadsheets in Step 4 (configure) |

### Step 2: Configure the OAuth Consent Screen

1. Navigate to **APIs & Services → OAuth consent screen**. Set it to **External** (so anyone can use it).
2. Add the following OAuth scopes so the page can deploy and configure scripts:

   | Scope                                               | Purpose                                               |
   | :-------------------------------------------------- | :---------------------------------------------------- |
   | `https://www.googleapis.com/auth/script.projects`   | Create and update Apps Script projects                |
   | `https://www.googleapis.com/auth/drive.file`        | Drive Picker selections and projects this app created |
   | `https://www.googleapis.com/auth/gmail.labels`      | Read Gmail label names for the config dropdowns       |
   | `https://www.googleapis.com/auth/calendar.readonly` | Read calendar list for the config dropdowns           |

3. Add any test users while your app is in **Testing** mode (you can publish it later if needed).

### Step 3: Create an OAuth Client ID

1. Navigate to **APIs & Services → Credentials**.
2. Click **Create Credentials → OAuth client ID**.
3. Choose **Web application**.
4. Under **Authorised JavaScript origins**, add the origin(s) from which you will serve `deploy/index.html` (e.g. `https://<your-username>.github.io` for GitHub Pages, or `http://localhost:<port>` for local testing).
5. Copy the generated **Client ID** and replace the `OAUTH_CLIENT_ID` constant in `deploy/index.html`.

### Step 4: (Optional) Link Your GCP Project to the Apps Script Project

Note your **Project Number** from the GCP dashboard. You will enter this into the **Settings → "Google Cloud Platform (GCP) Project"** section of your Installer GAS project if you are using the GAS Installer web app.

## 💼 Commercial Support & Custom Automation

Need enterprise Google Workspace automation, custom Apps Script connectors, or tailored workflow integrations?

Commercial services are offered through **[CombSmith LLC](https://combsmith.com)**:

- **Standard SLA & Priority Support:** $199/month per organization for managed automations, bug triage, and maintenance.
- **Custom Apps Script & Workspace Engineering:** $250/hour for bespoke connectors, Drive/Docs/Gmail automation, and security compliance.
- **Consulting & Implementation:** Architectural guidance, migration to GCP cloud functions, and enterprise deployment.

For commercial inquiries, email [support@combsmith.com](mailto:support@combsmith.com) or visit [combsmith.com](https://combsmith.com).

---

## 🤝 Contributing

Contributions are welcome! Please review the org-wide [Contributing Guide](https://github.com/combsmith/.github/blob/main/CONTRIBUTING.md) and [Security Policy](https://github.com/combsmith/.github/blob/main/SECURITY.md).

1.  Fork the repository.
2.  Create a feature branch (`git checkout -b feature/AmazingScript`).
3.  Commit your changes.
4.  Open a Pull Request.

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

---

_Note: These scripts are provided "as is". Always test on a small batch of data before running on important files._
