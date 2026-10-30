# Generic Taxonomy & Multi-Channel Intelligence Blueprint (Open-Source Version)

## 1. Overview

This document defines the generic taxonomy alignment, tag taxonomy, and hybrid compound tag decomposition architecture for the **Gemini AI-Powered Semantic Email Classifier & Google Drive Ingestion Engine**.

---

## 2. Generic 7-Canonical Domain Architecture

All email classifications, Google Drive folders, and Markdown note indices follow a standard 7-Canonical Domain schema:

| Domain Key                   | Generic Folder / Index Path       | Scope & Description                                                              |
| :--------------------------- | :-------------------------------- | :------------------------------------------------------------------------------- |
| **`01_Household`**           | `01_Household/index.md`           | Primary residence, property maintenance, home automation, utility receipts.      |
| **`02_Finance_Legal`**       | `02_Finance_Legal/index.md`       | Bank statements, credit cards, mortgage notes, tax documents, purchase receipts. |
| **`03_Vehicles`**            | `03_Vehicles/index.md`            | Vehicle registrations, auto insurance, parts orders, service records.            |
| **`04_Family_Health`**       | `04_Family_Health/index.md`       | Personal medical records, doctor visits, school portals, student planning.       |
| **`05_Tech_Infrastructure`** | `05_Tech_Infrastructure/index.md` | Cloud spend alerts, security warnings, home server health, digital backups.      |
| **`06_Work_Career`**         | `06_Work_Career/index.md`         | Work notes, architecture blueprints, professional expenses.                      |
| **`07_Community_NonProfit`** | `07_Community_NonProfit/index.md` | Non-profit board records, telemetry projects, charity updates.                   |

---

## 3. Generic Tag Taxonomy & Sub-Label Matrix

To optimize cross-channel searchability across Google Drive, Gmail, and Markdown note repositories, the AI Engine applies standardized tags and sub-labels:

| Canonical Domain             | Generic Sub-Label Taxonomy                                                                                           | Generic Tag Taxonomy (`tags`)                                                                        | Generic Search Keywords                                                                     |
| :--------------------------- | :------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------ |
| **`01_Household`**           | `Household/Primary-Property`<br>`Household/Home-Maintenance`<br>`Household/Home-Automation`<br>`Household/Utilities` | `household`, `property`, `construction`, `remodeling`, `maintenance`, `utilities`, `smart-home`      | Home remodeling, contractor bids, electric/gas receipts, smart home security alerts.        |
| **`02_Finance_Legal`**       | `Finance/Banking`<br>`Finance/Taxes`<br>`Finance/Purchases`<br>`Finance/Legal`<br>`Finance/Insurance`                | `finance`, `banking`, `taxes`, `credit-card`, `mortgage`, `statement`, `receipt`, `invoice`, `legal` | Credit card statements, tax W2/1099s, mortgage statements, store receipts, legal contracts. |
| **`03_Vehicles`**            | `Vehicles/Maintenance`<br>`Vehicles/Parts-Orders`<br>`Vehicles/Insurance`<br>`Vehicles/Registration`                 | `vehicles`, `auto`, `maintenance`, `parts`, `order`, `registration`, `insurance`, `car-care`         | Vehicle service records, auto parts orders, tire receipts, license/tag renewals.            |
| **`04_Family_Health`**       | `Family/School-Student`<br>`Family/Medical-Student`<br>`Family/Health-General`                                       | `family`, `health`, `medical`, `school`, `student`, `doctor`                                         | Medical records, doctor visits, school portal notifications, student planning.              |
| **`05_Tech_Infrastructure`** | `Tech/Alerts-Monitoring`<br>`Tech/Backups`<br>`Tech/Hardware`<br>`Tech/Cloud-GCP`                                    | `tech`, `infrastructure`, `cloud`, `gcp`, `security`, `alerts`, `server`, `backups`                  | Cloud spend/security alerts, Home Assistant API logs, server health, digital backups.       |
| **`06_Work_Career`**         | `Work/Notes`<br>`Work/Expenses`<br>`Work/Architecture`                                                               | `work`, `career`, `notes`, `expenses`, `architecture`, `projects`                                    | Professional work notes, architecture blueprints, work expenses.                            |
| **`07_Community_NonProfit`** | `Projects/Telemetry`<br>`Community/NonProfit-BOD`<br>`Community/Charity`                                             | `community`, `nonprofit`, `projects`, `telemetry`, `charity`                                         | Non-profit board records, telemetry sensors, charity updates.                               |

---

## 4. Mandatory Rule: Hybrid Compound Tag Decomposition

To guarantee both **high search precision** (zero false positives) and **high search recall** (never missing a search), the AI Engine enforces the **Hybrid Compound Tag Decomposition Rule**:

> **Rule**: Whenever any compound (hyphenated) tag is generated (e.g. `john-doe`, `main-street`, `credit-card`, `cloud-server`), the AI Engine automatically decomposes the compound and includes each individual component word (`john`, `doe`, `main`, `street`, `credit`, `card`, `cloud`, `server`) in the document's tag array.

### Examples of Generic Hybrid Tag Decomposition:

| Document Context                  | Generated Compound Tags          | Component Word Tokens              | Final Hybrid Tag Array                                                      |
| :-------------------------------- | :------------------------------- | :--------------------------------- | :-------------------------------------------------------------------------- |
| **Student School / Medical Form** | `john-doe`, `sample-school`      | `john`, `doe`, `sample`, `school`  | `[john-doe, sample-school, john, doe, sample, school, medical]`             |
| **Property Remodeling Bid**       | `123-main-street`, `main-street` | `123`, `main`, `street`            | `[123-main-street, main-street, 123, main, street, remodeling, contractor]` |
| **Credit Card Statement**         | `credit-card`, `sample-bank`     | `credit`, `card`, `sample`, `bank` | `[credit-card, credit, card, sample-bank, sample, bank, statement]`         |
| **Cloud Server Security Alert**   | `cloud-server`, `sample-cloud`   | `cloud`, `server`, `sample`        | `[cloud-server, cloud, server, security, alerts, tech]`                     |

---

## 5. Dual-Layer Metadata & Hybrid Tagging Mechanism

Google Drive files (Google Docs, PDFs, Word Docs, images) are tagged using **Dual-Layer Metadata Tagging** containing generic hybrid decomposed tags:

### 1. Drive Native API Properties (Key-Value Metadata)

```json
{
  "properties": {
    "people": "John Doe, Jane Doe",
    "organization": "Sample Academy, Sample Clinic",
    "tags": "john-doe, sample-academy, john, doe, sample, academy, school, medical",
    "domain": "04_Family_Health",
    "sublabel": "Family/School-Student",
    "indexed": "true"
  }
}
```

### 2. Embedded Document Front-Matter Header

```yaml
---
domain: 04_Family_Health
sublabel: Family/School-Student
people: [John Doe, Jane Doe]
organization: [Sample Academy, Sample Clinic]
location: [Sample City, State]
tags: [john-doe, sample-academy, john, doe, sample, academy, school, medical]
created: 2026-07-31
---
```
