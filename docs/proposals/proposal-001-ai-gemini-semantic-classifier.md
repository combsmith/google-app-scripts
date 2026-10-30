# Feature Proposal 001: Native Gemini AI Semantic Email Classifier & 7-Domain Taxonomy Engine

## Executive Summary

This proposal introduces a native **Gemini AI Semantic Email Classifier & Standard Taxonomy Engine** into the `google-app-scripts` suite.

By calling the Gemini REST API (`gemini-1.5-flash`) natively via Google Apps Script's `UrlFetchApp.fetch()`, incoming unclassified emails are semantically categorized into **7 Standard Canonical Domains**, and high-confidence classifications automatically generate permanent Gmail filter rules via the Advanced Gmail Service.

---

## Implementation Prerequisites

### 1. User Opt-In Configuration

The classifier requires explicit user opt-in before processing email content with an external AI API:

- A `GEMINI_CLASSIFIER_ENABLED` Script Property must be set to `true` to activate processing.
- Users must acknowledge that email metadata (sender, subject, body snippet) is transmitted to the Gemini API.

> **Not yet implemented:** The `GEMINI_CLASSIFIER_ENABLED` guard and user acknowledgment step are not present in the current version; `processEmailsWithAiClassifier()` runs unconditionally.

### 2. Data Minimization & Redaction Boundary

Before sending email content to the Gemini API, the implementation applies:

- **Sender**: Full sender address (required for filter generation accuracy).
- **Subject**: Full subject line.
- **Body snippet**: Maximum 1,200 characters of plain text; HTML tags and quoted-reply blocks are stripped via `getCleanBody()` before transmission. _(Not yet implemented: the current version uses `getPlainBody().substring(0, 1200)` without quoted-reply stripping.)_
- Sensitive patterns (e.g., SSN-like strings, credit card numbers) should be redacted from the body snippet before it is sent. _(Not yet implemented.)_

### 3. Gemini Provider Data-Retention

This implementation targets the Google Gemini API under a Google Workspace account. Administrators must verify the Gemini API data retention and logging settings for their organization before enabling this classifier on accounts containing sensitive or regulated data.

### 4. API Key Storage (User-Only Script Properties)

The Gemini API key **must** be stored in Google Apps Script **Script Properties** (per-script, not Document or User Properties):

```javascript
PropertiesService.getScriptProperties().setProperty(
  'GEMINI_API_KEY',
  '<your-key>'
)
```

Never hard-code the API key in `config.gs` or any committed file.

### 5. Required OAuth Scopes

Declare the following scopes in `appsscript.json`:

```json
{
  "oauthScopes": [
    "https://www.googleapis.com/auth/gmail.labels",
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/gmail.settings.basic",
    "https://www.googleapis.com/auth/script.external_request"
  ]
}
```

The `Gmail.Users.Settings.Filters.create` call additionally requires the **Advanced Gmail Service** to be enabled in the Apps Script project under **Services**.

---

## Handling Unclassified & Edge-Case Mail

- **Transactional & 2FA Passcodes**: Verification codes, password resets, and 2FA emails are skipped by Drive ingestion to prevent clogging Drive with 1-line passcodes.
- **Inbox Safety Net**: Unclassified emails are **NEVER deleted or hidden**. They remain safely in the user's INBOX for standard reading and review.
- **Optional `Unclassified` Badge**: Ambiguous emails can be tagged with an optional `Unclassified` label for easy visual filtering.

---

## Idempotency & Reprocessing Workflows

- **Query Guard**: Ingestion routines process threads matching `label:Category -label:Processed`.
- **Deduplication Safety Nets**: MD5 native checksums (`file.getMd5Checksum()`) prevent duplicate attachment saves; thread markers (`[THREAD:id]`) prevent duplicate text logs.
- **Single-Click Reprocessing**: Removing the `Processed` label from an email thread in Gmail causes the script to re-evaluate, re-clean, and re-process the thread on its next run.

---

## Clean Ingestion Marker: Single Global `Processed` Label

- **Eliminating Duplicate Labels**: Rather than creating parallel `-Processed` labels (which doubles sidebar labels from 20 to 40+), the script applies a **single global `Processed` label** (or Green Star badge) to indicate Drive ingestion completion.
- **Category Preservation**: The thread retains its canonical category label.
- **Inbox Preservation**: Processing an email into Google Drive **MUST NOT remove the message from the user's INBOX**. The email thread remains visible in the Inbox for human review until explicitly archived or deleted by the user.

---

## Standard 7-Domain Taxonomy Matrix (PARA / ISO 15489 / MECE Aligned)

The classifier operates against a standardized, mutually exclusive, collectively exhaustive (MECE) 7-domain taxonomy:

| 7 Canonical Domains          | Standard PARA Area            | Scope & Contents                                                                       |
| :--------------------------- | :---------------------------- | :------------------------------------------------------------------------------------- |
| **`01_Household`**           | Real Estate & Living Space    | Primary residence, secondary properties, rental properties, property archives          |
| **`02_Finance_Legal`**       | Financial & Legal Protections | Taxes, banking, insurance policies, court records, custody, estate planning            |
| **`03_Vehicles`**            | Transportation & Assets       | Vehicle searches, vehicle titles, maintenance logs                                     |
| **`04_Family_Health`**       | Family Welfare & Health       | Children, school records, medical appointments, therapy sessions, educational programs |
| **`05_Tech_Infrastructure`** | IT & Home Automation          | Home automation, NAS backups, scripting tools, network gear, software licenses         |
| **`06_Work_Career`**         | Professional Life & Income    | Employment records, resumes, interview materials, expense reports, admin notes         |
| **`07_Community_NonProfit`** | Civic Duty & Service          | Charity organizations, community board roles, faith outreach                           |

---

## Classifier Response Contract

The Gemini classifier prompt requests a response conforming to the following JSON schema:

```json
{
  "canonical_label": "<one of the configured canonicalDomains strings>",
  "confidence": 0.98,
  "reasoning": "<one-sentence explanation>"
}
```

**Field definitions:**

- `canonical_label` (string, required): Must be one of the exact strings from `config.canonicalDomains`. The implementation validates this value and rejects responses that do not match a configured label.
- `confidence` (number, required): A float in the range `[0.0, 1.0]` representing the classifier's certainty. Values outside this range are treated as invalid.
- `reasoning` (string, required): A brief one-sentence explanation of the classification decision.

**Validation and fallback behavior:**

- If the Gemini API returns an HTTP error, malformed JSON, or a refused response, `classifyEmailWithGemini` returns `null` and the thread is skipped without modification (no label applied, no filter created).
- If the parsed response is missing required fields, or `canonical_label` does not exactly match one of the configured domains, the response is rejected and treated as `null`.
- An abstain/unknown outcome is implicit: any non-conforming response leaves the thread unlabeled and unprocessed, making it eligible for the next run.

---

## Self-Learning Gmail Filter Generation

When Gemini classifies a new sender with high confidence (>= 95%), the script automatically calls `Gmail.Users.Settings.Filters.create` to create a permanent static Gmail filter rule. Future emails from that sender are processed instantly by Gmail's fast native filter engine at 0 cost.

**Confidence calibration and staged approval:**

- Only classifications with `confidence >= autoFilterConfidenceThreshold` (default: `0.95`) trigger filter creation.
- Senders categorized under sensitive domains (e.g., `02_Finance_Legal`, `04_Family_Health`) should be reviewed manually before trusting auto-generated filters in production.

**Duplicate filter detection:**

- Before creating a new filter, the implementation should call `Gmail.Users.Settings.Filters.list` to check for an existing filter matching the same sender address and skip creation if one already exists.

**Label existence and resolution:**

- The `ensureGmailLabel()` helper creates the target label if it does not exist before the filter is created.
- If label creation fails, filter creation is skipped for that sender.

**Correction and rollback semantics:**

- If a manual label correction is detected (user re-labels a thread after auto-classification), the script should update or delete the corresponding filter rule on the next run.
- A `rollbackGmailFilter()` operation can retrieve and delete previously created filters via `Gmail.Users.Settings.Filters.list` + `Gmail.Users.Settings.Filters.delete`.

---

## Key Capabilities

1. **Zero-Configuration Semantic Classification**:
   - Classifies incoming emails from unknown senders based on semantic intent, sender, subject, and body snippet into target canonical labels.
2. **Self-Learning Gmail Filter Generation**:
   - When Gemini classifies a new sender with high confidence (>= 95%), the script automatically creates a permanent static Gmail filter rule.
3. **Single-Click Reprocessing**:
   - Simply remove the `Processed` label from any thread to re-run and re-ingest.
4. **100% Cloud-Native & Serverless**:
   - Executes natively inside Google Apps Script via `UrlFetchApp.fetch()`. Requires zero external servers, Docker containers, or Python infrastructure.

---

## Code Module Design

Target file structure in `google-app-scripts`:

```text
src/gmail-ai-classifier/
├── README.md
├── code.gs
├── config.gs
├── src/
│   └── index.js
└── tests/
    ├── code.test.js
    └── integration.test.js
```

---

## Discussion & Tracking

- Issue Tracked: [#491](https://github.com/petry-projects/google-app-scripts/issues/491)
- Pull Request Tracked: [#492](https://github.com/petry-projects/google-app-scripts/pull/492)
- Repository: `petry-projects/google-app-scripts`
