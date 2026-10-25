# Google Apps Script Productivity Suite

[![Contributing](https://img.shields.io/badge/contributions-welcome-brightgreen.svg)](https://github.com/combsmith/.github/blob/main/CONTRIBUTING.md)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

![googleappscripts](header.jpg)

A collection of personal productivity scripts built on Google Apps Script. These tools are designed to automate repetitive tasks across Gmail, Google Drive, and Google Docs, helping you reclaim your time and keep your digital workspace organized.

Open sourced under the MIT License to help others build their own automation workflows.

## 📂 Script Catalog

| Script Name                  | Description                                                                                                                                                                                                                                       | Documentation                                           |
| :--------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :------------------------------------------------------ |
| **Gmail to Drive By Labels** | Automatically archives emails from specific Gmail labels into a Google Doc (text) and Google Drive Folder (attachments). Features robust text cleaning (removing quoted replies/legal footers) and smart content-based attachment de-duplication. | [View Readme](./src/gmail-to-drive-by-labels/README.md) |
| **Calendar to Sheets**       | Syncs Google Calendar events into a Google Sheet, keeping rows up to date on changes and deletions.                                                                                                                                               | [View Readme](./src/calendar-to-sheets/README.md)       |

## 🚀 Getting Started

### Option A — Browser-based deployment (recommended)

Deploy and configure any script directly from your browser — no command line or manual ID-hunting required.

1. **Open the deployment page** — `deploy/index.html` (or the hosted GitHub Pages version if available).
2. **Review authentication details** — the deployment page uses a preconfigured OAuth Client ID defined in `deploy/index.html`. If you are using this repository as-is, you do not need to create or enter your own client ID. If you fork this repo and want to use your own, see the GCP setup section below and [deploy/index.html](./deploy/index.html) for details.
3. **Sign in with Google** — authorise the page to create Apps Script projects and read your Gmail labels, calendars, and Drive resources on your behalf.
4. **Select a script and click Deploy** — the page fetches the latest source files from this repository, uploads them to your account, and creates a new Apps Script project with an auto-generated name. A direct link to the new project is shown on success.
5. **Configure your script (Step 4)** — after deployment a **Configure** panel appears automatically for each deployed script. Use the dropdowns and Drive Pickers to select your resources (Gmail labels, calendars, Google Docs, Drive folders/spreadsheets), then click **Save Configuration**. This writes the settings directly to your Apps Script project's `config.gs` — no manual editing required.

### Option B — Manual copy-paste

1.  **Browse the Catalog:** Check the table above to find a script that fits your needs.
2.  **Open the Folder:** Navigate to the specific script folder (e.g., `/src/gmail-to-drive-by-labels`).
3.  **Code & Config Convention:** Each script places the runnable code in `code.gs` and configuration values in `config.gs`.
4.  **Copy the Code:** Open `code.gs` (and `config.gs`) in the folder and copy them into a new [Google Apps Script project](https://script.google.com/).
5.  **Configure:** Update `config.gs` values (spreadsheet id, sheet name, etc.) and follow the specific setup instructions in that script's `README.md`.

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

   | Scope                                               | Purpose                                                    |
   | :-------------------------------------------------- | :--------------------------------------------------------- |
   | `https://www.googleapis.com/auth/script.projects`   | Create and update Apps Script projects                     |
   | `https://www.googleapis.com/auth/drive.readonly`    | Drive Picker — browse and select Docs, folders, and sheets |
   | `https://www.googleapis.com/auth/gmail.labels`      | Read Gmail label names for the config dropdowns            |
   | `https://www.googleapis.com/auth/calendar.readonly` | Read calendar list for the config dropdowns                |

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
