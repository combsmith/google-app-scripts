# Gemini AI-Powered Semantic Email Classifier & Auto-Filter Engine

A production-ready Google Apps Script (GAS V8) engine that automatically classifies Gmail inbox messages into 7 canonical household domain folders using Google AI Studio (Gemini 3.5 & Gemma 4 31B), creates permanent native Gmail filters for high-confidence senders, and syncs executive summaries to GitHub note repositories.

---

## 🌟 Multi-Account Household Setup Guide

To run this classifier across multiple household Gmail accounts (`user1@example.com` and `user2@example.com`):

### Step 1: Share Canonical Drive Note Folders

Share the 7 Canonical Domain folders in Google Drive (`01_Household` through `07_Community_NonProfit`) with full Editor access to `user2@example.com`.

### Step 2: Deploy Script Instance to Account #2

1. Log into Google Apps Script under `user2@example.com`.
2. Push or copy `code.gs`, `config.gs`, `gitHubSync.gs`, and `appsscript.json`.
3. Open **Project Settings (gear icon)** $\rightarrow$ **Script Properties**.
4. Add the following keys:
   - `GEMINI_API_KEY`: Your Google AI Studio API key.
   - `GITHUB_PAT`: Fine-grained GitHub Personal Access Token with write access to your target repository.
   - `GITHUB_REPO_OWNER`: Target GitHub repository owner / organization name.
   - `GITHUB_REPO_NAME`: Target GitHub repository name.
   - `DRIVE_ROOT_FOLDER_NAME`: _(Optional)_ Parent folder name in Google Drive under which the 7 canonical domain folders live (defaults to Drive root when omitted).
   - `USER_ACCOUNT_EMAIL`: `user2@example.com`
   - `CUSTOM_PROMPT_RULES`: _(Optional)_ User-specific domain and student attribution rules appended dynamically to the AI prompt without code modifications.

### Step 3: Enable Automated Triggers

Run `setupFiveMinuteTrigger()` in Apps Script under Account #2.

---

## 🔑 Features

- **Multi-Account Attribution**: Automatically tags entries with `- **Account**: user2@example.com` or `user1@example.com`.
- **Dynamic User Discovery**: `Session.getEffectiveUser().getEmail()` automatically populates the account email dynamically at runtime.
- **7 Canonical Domain Folders**:
  - `01_Household`: Remodeling, property maintenance, contractor bids, utility bills.
  - `02_Finance_Legal`: Credit card statements, tax documents, mortgage notes, purchase receipts.
  - `03_Vehicles`: Vehicle registrations, parts orders, maintenance records.
  - `04_Family_Health`: Personal medical notes, school portals, doctor visits, student planning.
  - `05_Tech_Infrastructure`: Google Cloud spend alerts, security warnings, backup status.
  - `06_Work_Career`: Professional notes, work expenses, architecture docs.
  - `07_Community_NonProfit`: Sensor telemetry, non-profit BOD notes, charity updates.
- **Automated Google Drive Taxonomy Attachment Persistence**: Automatically extracts and persists attached documents (`.pdf`, `.docx`, `.xlsx`, `.csv`, etc.) along the label's 2-level Google Drive taxonomy path (`[Domain]/[Subfolder]`, or `[DRIVE_ROOT_FOLDER_NAME]/[Domain]/[Subfolder]` when `DRIVE_ROOT_FOLDER_NAME` is configured), with MD5 content fingerprint deduplication and automatic signature/tracking pixel filtering (`< 35KB` for images). Strictly ignores attachments for non-canonical emails (promotions, newsletters, spam) to prevent storage bloat. Formatted Google Drive links are automatically appended to GitHub markdown notes under `- **Attachments**:`.
- **2-Year Category Retention Engine**: Automatically purges promotional, social, and forum emails older than 2 years every Sunday at 1:00 AM, while keeping core threads **indefinitely**. The retention guard exempts any thread carrying a canonical-domain label **or one of its classifier sub-labels** (e.g. `Finance/Banking`), plus starred and user-sent/replied threads — so a core message tagged only with its sub-label is never trashed.

---

## 🛠️ Tuning & Customization Architectural Guidance

To keep this codebase a **clean, generic, reusable open-source harness** suitable for any household or organization:

### 1. Decouple Core Engine from Personal Specializations

- **Generic Engine**: `code.gs` and `gitHubSync.gs` handle the orchestration: batch fetching, AI prompt assembly, JSON extraction, Gmail category tab assignment (`setGmailCategoryTab`), label lifecycle (`ensureUserLabel`), and GitHub API note ingestion.
- **No Hardcoded Personal Entities in Core**: Engine source files should remain agnostic of specific student names, local schools, private businesses, or personal contacts.
- **Extensible Prompt Injection**: When personalizing the Gemini classification rules, inject customized domain rules via `config.gs` or `ScriptProperties` rather than baking private household specifics into the open-source repository.

### 2. Policy on One-Time Cleanups & Realignment Routines

- **Never Embed in the Recurring Trigger**: Maintenance routines designed to fix historical label anomalies (e.g., swapping a student label across past threads) must **never** be committed into the continuous 5-minute automation loop (`processEmailsWithAiClassifier`).
- **Standalone Execution Pattern**:
  1. Implement one-off cleanups as standalone migration scripts (e.g. in a private workspace `scripts/` directory or an isolated manual function in GAS).
  2. Execute and verify completion once.
  3. Remove the migration code immediately.

### 3. Classification Tuning Lifecycle

- **Observation**: Periodically audit classification results using automated scanner scripts or by inspecting ingestion commit logs.
- **Generic Rule Refinement**: When common patterns emerge (e.g., delivered vs. in-transit shipments, auto-paid vs. manual bills), update the generic open-source rules so all users benefit.
- **Entity Attribution Tuning**: When student, school, or organization attribution shifts, update the user configuration mapping.
- **Verification**: Run unit tests (`npm test -- src/gmail-ai-classifier`) to verify that prompt and classification changes maintain zero regressions.

### 4. Continuous Audit & Anomaly Detection

To catch classification drift, orphan threads, and label collisions autonomously:

- **`setupDailyAuditTrigger()`**: Sets up a daily 6:00 AM time-driven trigger that runs `auditEmailClassifications()`. (Automatically enabled when invoking `setupFiveMinuteTrigger()`).
- **`auditEmailClassifications()`**: Inspects threads processed in the last 2 days for missing domain labels, conflicting multiple domains, or suspicious category mismatches (e.g. unfiled receipts or misrouted promotional emails).
- **Audit Email Digest**: Optionally configure the `AUDIT_DIGEST_EMAIL` ScriptProperty to receive an automated notification whenever anomalies are detected, prompting targeted tuning via `CUSTOM_PROMPT_RULES`.
