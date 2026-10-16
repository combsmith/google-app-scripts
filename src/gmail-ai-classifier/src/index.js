/**
 * Gmail AI Classifier — testable core logic.
 * All GAS services are injected as parameters so this module can be unit-tested
 * with Jest without a live Google Apps Script environment.
 */

const { getFileHash } = require('../../gas-utils')

/**
 * Validates a Gemini classification response object.
 *
 * Returns true only when the response has all required fields with values
 * within expected bounds and the label matches a configured canonical domain.
 *
 * @param {Object} classification - Parsed response from Gemini
 * @param {string[]} [canonicalDomains] - Allowed label values; omit to skip label check
 * @returns {boolean}
 */
function validateClassification(classification, canonicalDomains) {
  if (!classification || typeof classification !== 'object') return false
  if (
    !classification.canonical_label ||
    typeof classification.canonical_label !== 'string'
  )
    return false
  if (!Number.isFinite(classification.confidence)) return false
  if (classification.confidence < 0 || classification.confidence > 1)
    return false
  if (
    classification.reasoning === undefined ||
    typeof classification.reasoning !== 'string'
  )
    return false
  if (
    canonicalDomains &&
    !canonicalDomains.includes(classification.canonical_label)
  )
    return false
  return true
}

function _sleep(ms) {
  if (typeof Utilities !== 'undefined') Utilities.sleep(ms)
}

/**
 * Constructs an Ontological Knowledge Graph & Triage Matrix prompt for Gemini classification.
 * Uses positive invariant domain scopes, an orthogonal lifecycle triage matrix,
 * and user entity graph injection, eliminating negative exclusion rules.
 *
 * @param {Object} config - Classifier configuration (canonicalDomains, customPromptRules)
 * @param {string} sender - Email sender header
 * @param {string} subject - Email subject line
 * @param {string} snippet - Email body snippet
 * @returns {string} Prompt text for Gemini API
 */
function buildOntologicalPrompt(config, sender, subject, snippet) {
  const domains = (config && config.canonicalDomains) || []
  let prompt =
    'You are an executive email classifier. Perform semantic classification into ONE canonical domain key from: ' +
    JSON.stringify(domains) +
    ' (or null if non-canonical).\n\n' +
    '=== TIER 1: DOMAIN TAXONOMY ONTOLOGY (POSITIVE INVARIANTS) ===\n' +
    'Classify emails based on what each domain positively governs:\n' +
    "• '01_Household': Physical residence, real estate property, maintenance, home repairs, contractor invoices, home utilities, household inventory, and travel/lodging reservations. Valid sub-labels: 'Household/Property', 'Household/Maintenance', 'Household/Travel'.\n" +
    "• '02_Finance_Legal': Personal banking, checking/savings, credit cards, investments, mortgages, personal tax filings (W-2, 1098, 1099, returns), utility payment accounts/funding, purchase invoices/receipts, health/auto/property insurance policies and explanations of benefits (EOB), actual personal legal proceedings, court orders, attorney correspondence, dispute filings, and executed personal contracts (leases, deeds, wills, trusts, powers of attorney). (Excludes commercial terms of service updates, which are non-canonical broadcast notices). Valid sub-labels: 'Finance/Banking', 'Finance/Bills', 'Finance/Purchases', 'Finance/Insurance', 'Finance/Taxes', 'Finance/Donations', 'Finance/Charitable-Donations', 'Finance/Legal'.\n" +
    "• '03_Vehicles': Personal automobile titles, registrations, vehicle insurance, automotive maintenance, repairs, parts, and car rental reservations. Valid sub-labels: 'Vehicles/Maintenance', 'Vehicles/Purchases', 'Vehicles/Rental-Cars'.\n" +
    "• '04_Family_Health': Family correspondence, healthcare records, doctor appointments, patient portals, prescriptions, elder care, and student education/coursework/school portals. Valid sub-labels: 'Family/Kids/Tide', 'Family/Kids/Toby', 'Family/Kids/David', 'Family/School-Student', 'Family/Medical', 'Family/Legal', 'Family/Correspondence', 'Family/Parents', 'Family/Sisters'.\n" +
    "• '05_Tech_Infrastructure': Cloud hosting, server infrastructure, domains/DNS, network hardware, security alerts, system telemetry, and developer platform quota/outage alerts. Valid sub-labels: 'Tech/Cloud', 'Tech/Security', 'Tech/Alerts'.\n" +
    "• '06_Work_Career': Professional employment, career advancement, job applications, recruiter correspondence, interview schedules, employer benefits, and consulting. Valid sub-labels: 'Work/Career', 'Work/Employer'.\n" +
    "• '07_Community_NonProfit': Official 501(c)(3) charities, non-profit boards of directors, volunteer shift schedules, civic records, community/apiary telemetry, and non-profit initiatives. Valid sub-labels: 'Projects/Charity', 'Community/BOD', 'Projects/Telemetry', 'Projects/Beekeeping', 'Projects/HOG'.\n\n" +
    'NON-CANONICAL EMAILS (canonicalDomain: null):\n' +
    '• Media, platform, and enterprise daily/weekly activity digests and newsletters (Substack, Medium, LinkedIn digests, corporate/enterprise platform activity digests, daily digest emails, news recaps, blogs, trade publications) -> canonicalDomain: null, subLabel: null, category: "Updates" (or "Promotions"), action: "archive".\n' +
    '• Retail marketing, store discounts, commercial coupons, equipment supply store sales, and e-commerce promotional blasts (e.g. retail equipment/tools/bee supply discounts, store newsletters, commercial promotional sales) -> canonicalDomain: null, subLabel: null, category: "Promotions", action: "archive". (Distinguish commercial store sales from actual community/apiary telemetry or non-profit initiatives).\n' +
    '• Customer satisfaction surveys, Net Promoter Score (NPS) ratings, support feedback forms, and service questionnaires (e.g. airline/travel surveys, cloud/developer platform feedback surveys, camp/program feedback ratings, vendor review requests) -> canonicalDomain: null, subLabel: null, category: "Promotions" (or "Updates"), action: "archive".\n' +
    '• Political campaign communications, candidate fundraising appeals, PAC broadcasts, election solicitations, and news subscription pitches (e.g. campaign fundraising appeals, news subscription drives, daily news digests) -> canonicalDomain: null, subLabel: null, category: "Promotions" (or "Updates"), action: "archive".\n' +
    '• Commercial webinars, product demos, vendor marketing broadcasts.\n' +
    '• Unsolicited real estate cold calls, off-market wholesaler pitches, bulk solicitation.\n' +
    '• Commercial Terms of Service (TOS) updates, privacy policy revisions, arbitration updates, and platform terms/agreements (e.g. Waymo, Google, Uber, Apple, bank policy updates) -> non-canonical broadcast notices; route to category "Promotions" (or "Updates") with action "archive".\n\n' +
    'AUTOMATED SEARCH & MONITORING ALERTS (Google Alerts, Talkwalker, CourtListener, web mentions):\n' +
    'Route monitoring alerts strictly according to the subject entity being monitored:\n' +
    "• Person, family member, elder care, or genealogy monitoring -> '04_Family_Health' ('Family/Legal' or 'Family/Correspondence') or '02_Finance_Legal' ('Finance/Legal').\n" +
    "• Municipal, neighborhood, zoning, or real property monitoring -> '01_Household' ('Household/Property').\n" +
    "• Corporate, business, industry, or career monitoring -> '06_Work_Career' ('Work/Career').\n" +
    "• General news or unassigned media mention -> canonicalDomain: null (category: 'Updates', action: 'archive').\n" +
    '• Student or school sub-labels apply only when the monitored alert query specifically targets an academic program or school.\n\n' +
    'AUTOMATED MACHINE & SENSOR TELEMETRY (BroodMinder, weather stations, IoT sensors, server metrics, device status pings, cron logs, uptime monitors):\n' +
    '• Community/beehive telemetry (BroodMinder monitors) -> "07_Community_NonProfit", sub-label "Projects/Telemetry" or "Projects/Beekeeping".\n' +
    '• Tech infrastructure/server telemetry (device pings, server metrics, cron logs) -> "05_Tech_Infrastructure", sub-label "Tech/Alerts".\n' +
    '• MANDATORY ROUTING: Always route machine telemetry to category "Updates" with action "archive". Keep telemetry completely archived out of the Inbox.\n\n' +
    'SCHOOL & STUDENT ANNOUNCEMENTS VS DIRECT CORRESPONDENCE (MCAA, Briarwood, FACTS, PowerSchool, ParentSquare, Canvas, Google Classroom, Colleges):\n' +
    '• Routine school announcements, district/ParentSquare broadcasts, headmaster/principal letters, athletics/arts/club notices (e.g. "Noteworthy News", "Athletics Newsletter", "Lion Guard Update"), lunch menus, school calendars, college/admissions parent newsletters (e.g. "Parent and Family Newsletter"), Google Classroom summaries, FACTS bulletins, PowerSchool broadcasts, and weekly school newsletters -> "04_Family_Health", sub-label "Family/School-Student", category: "Updates", action: "archive". Ingest and log them to notes, but keep them archived out of the Inbox (Updates tab).\n' +
    '• Direct 1:1 personal emails from an individual teacher, principal, or guidance counselor addressed personally to the parent regarding an individual student\'s urgent academic/disciplinary matter or conference request -> category: "Primary", action: "keep".\n\n' +
    'NON-PROFIT & CHARITY BROADCASTS VS DIRECT CORRESPONDENCE:\n' +
    '• Routine mass newsletters, monthly impact reports, event notices, general fundraising appeals, and volunteer list blasts from non-profits or charities (e.g. Community Food Bank, The Lovelady Center, Southeastern Climbers Coalition, Grace Klein Community mass mail, Restoration Academy bulletins) -> "07_Community_NonProfit", sub-label "Projects/Charity", category: "Updates", action: "archive". Ingest and log them to notes, but keep them archived out of the Inbox.\n' +
    '• Direct 1:1 personal emails from non-profit leadership, board members, or staff addressed specifically to the individual (or personal volunteer shift confirmations needing attendance) -> "07_Community_NonProfit", category: "Primary", action: "keep".\n\n' +
    'TECH PLATFORM NOTIFICATIONS & SYSTEM ANNOUNCEMENTS:\n' +
    '• Automated developer platform notifications, deprecation alerts, quota notices, CI/CD run failure notices (e.g. Google AI Studio, Linear, GitHub, Cloud monitoring) -> "05_Tech_Infrastructure", sub-label "Tech/Alerts", category: "Updates", action: "archive". Ingest and log them to notes, but keep them archived out of the Inbox.\n' +
    '• Critical security incidents or billing payment failure notices requiring manual human intervention -> "05_Tech_Infrastructure", sub-label "Tech/Security" or "Tech/Alerts", category: "Primary", action: "keep".\n\n' +
    'PRIMARY PARTY ATTRIBUTION PRINCIPLE (CHILDREN & PRIMARY BENEFICIARY VS INCIDENTAL ADULTS):\n' +
    '• When an email, legal document, school notification, or healthcare record pertains to a specific child/individual (e.g. Tide, Toby, David, or any household child), classify the email under that primary party\'s specific label (e.g. "Family/Kids/Tide", "Family/Kids/Toby", "Family/Kids/David", or "Family/School-Student").\n' +
    '• Attribute the email strictly to the PRIMARY SUBJECT / TARGET BENEFICIARY of the matter, rather than incidental parties:\n' +
    '  - If an email concerns Tide\'s legal name change, government IDs, FSA ID, schooling, or medical care, the primary party is Tide -> "Family/Kids/Tide" (or "02_Finance_Legal" / "Family/Legal" if a formal court filing).\n' +
    '  - Route child-related legal, educational, or personal matters to the child\'s sub-label, ensuring that mentioned biological parents, guardians, or relatives do not divert the classification to "Family/Sisters".\n' +
    '  - Sub-label "Family/Sisters" applies strictly to direct personal correspondence regarding the sister\'s own independent adult personal affairs.\n\n' +
    '=== TIER 2: ORTHOGONAL TRIAGE MATRIX (LIFECYCLE STATE) ===\n' +
    'Determine category and action based on the lifecycle state of the email:\n' +
    '1. Action_Required (Manual bills due without auto-pay, direct 1:1 personal/teacher/counselor correspondence needing individual human reply, audit/response deadlines, suspicious login alerts, ready prescriptions):\n' +
    "   -> category: 'Primary', action: 'keep'\n" +
    '2. Informational_Feed (Routine school bulletins/newsletters/ParentSquare updates, non-profit newsletters/appeals, automated search/monitoring alerts, active orders in transit, routine tax forms/receipts, volunteer reminders, upcoming travel itineraries):\n' +
    "   -> category: 'Updates', action: 'archive'\n" +
    '3. Completed_Transaction (Confirmed scheduled auto-payments, delivered packages, successful SSO/sign-ins, routine lunch menu digests, bank transfers, automated machine/sensor telemetry [BroodMinder, HoneyBeeham], device/server pings):\n' +
    "   -> category: 'Updates', action: 'archive'\n" +
    '4. Broadcast_Marketing (Commercial promos, retail discounts, vendor newsletters, terms of service and privacy policy updates):\n' +
    "   -> category: 'Promotions', action: 'archive'\n" +
    '5. Spam_Solicitation (Phishing, scam attempts, cold wholesaler pitches):\n' +
    "   -> category: 'Promotions', action: 'trash'\n\n" +
    'CATEGORY-DRIVEN INBOX RETENTION INVARIANT:\n' +
    '• Primary Inbox is an Action Queue: Only emails categorized as "Primary" belong in the Primary Inbox (action: "keep").\n' +
    '• All non-Primary streams ("Updates", "Promotions", "Social", "Forums") are Informational Feeds that must be archived out of the Inbox (action: "archive") into their respective category tab and domain sub-label.\n\n' +
    '=== CONSTRAINTS ===\n' +
    '• Single Sub-Label Invariant: Return AT MOST ONE sub-label string (e.g. "Finance/Banking" or "Family/School-Student"). Do not stack or combine multiple sub-labels.\n\n'

  if (config && config.customPromptRules) {
    prompt +=
      '=== TIER 3: USER ENTITY KNOWLEDGE GRAPH & CUSTOM RULES ===\n' +
      config.customPromptRules +
      '\n\n'
  }

  prompt +=
    'Sender: ' +
    sender +
    '\n' +
    'Subject: ' +
    subject +
    '\n' +
    'Body Snippet: ' +
    snippet +
    '\n\n' +
    'Return JSON ONLY: {"canonicalDomain": "01_Household", "subLabel": "Household/Property", "category": "Updates", "action": "archive", "confidence": 0.98, "title": "Short Title", "summary": "2 sentence executive summary"}\n' +
    "Valid categories: 'Primary', 'Updates', 'Promotions', 'Social', 'Forums'.\n" +
    "Valid actions: 'keep', 'archive', 'trash', 'mark_read'."

  return prompt
}

/**
 * Calls the Gemini REST API and returns a validated classification object, or null.
 *
 * Returns null on network errors, malformed responses, refused responses, or
 * responses whose canonical_label does not match a configured domain.
 * Retries transient 429/5xx responses with exponential backoff (up to 3 attempts).
 *
 * @param {Object} config - Classifier configuration (modelEndpoint, geminiApiKey, canonicalDomains)
 * @param {string} sender - Email sender address
 * @param {string} subject - Email subject line
 * @param {string} bodyText - Plain-text body snippet (max 1,200 chars recommended)
 * @param {Object} urlFetchApp - GAS UrlFetchApp service (injected for testability)
 * @param {Function} [sleepFn] - Sleep function for retry delays (injected for testability, defaults to _sleep)
 * @returns {Object|null} Validated classification or null
 */
function classifyEmailWithGemini(
  config,
  sender,
  subject,
  bodyText,
  urlFetchApp,
  sleepFn
) {
  const url = config.modelEndpoint
  const sleep = sleepFn || _sleep

  const prompt =
    'You are an executive email classifier.\n' +
    'Classify the following email into exactly ONE of these canonical domain labels:\n' +
    config.canonicalDomains.join('\n') +
    '\n\n' +
    'Email Details:\n' +
    'Sender: ' +
    sender +
    '\n' +
    'Subject: ' +
    subject +
    '\n' +
    'Body Snippet: ' +
    bodyText +
    '\n\n' +
    'Respond ONLY in JSON format with these exact fields:\n' +
    '{"canonical_label": "<one of the labels above>", "confidence": <0.0-1.0>, "reasoning": "<one sentence>"}'

  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { response_mime_type: 'application/json' },
  }

  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-goog-api-key': config.geminiApiKey,
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  }

  const MAX_ATTEMPTS = 3
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const response = urlFetchApp.fetch(url, options)
      const statusCode = response.getResponseCode()

      if (statusCode === 429 || (statusCode >= 500 && statusCode < 600)) {
        if (attempt < MAX_ATTEMPTS - 1) {
          sleep(Math.pow(2, attempt) * 1000)
          continue
        }
        console.error(
          '[classifyEmailWithGemini] Transient error after retries, status:',
          statusCode
        )
        return null
      }

      if (statusCode < 200 || statusCode >= 300) {
        console.error(
          '[classifyEmailWithGemini] HTTP error from Gemini API, status:',
          statusCode
        )
        return null
      }

      const jsonText = response.getContentText()
      const parsed = JSON.parse(jsonText)
      const outputText = parsed.candidates[0].content.parts[0].text
      const classification = JSON.parse(outputText)
      if (!validateClassification(classification, config.canonicalDomains)) {
        console.error(
          '[classifyEmailWithGemini] Invalid classification response:',
          JSON.stringify(classification)
        )
        return null
      }
      return classification
    } catch (e) {
      console.error(
        '[classifyEmailWithGemini] Error calling Gemini REST API:',
        e.message
      )
      return null
    }
  }
}

/**
 * Ensures a Gmail user label exists, creating it if necessary.
 *
 * @param {string} labelName - Full label name (e.g. "01_Household/Primary")
 * @param {Object} gmailApp - GAS GmailApp service (injected for testability)
 * @returns {Object|null} GmailLabel or null on failure
 */
function ensureGmailLabel(labelName, gmailApp, gmailAdvanced) {
  const existing = gmailApp.getUserLabelByName(labelName)
  if (existing) return existing
  try {
    if (gmailAdvanced?.Users?.Labels?.create) {
      try {
        gmailAdvanced.Users.Labels.create(
          {
            name: labelName,
            labelListVisibility: 'labelShow',
            messageListVisibility: 'hide',
          },
          'me'
        )
        const created = gmailApp.getUserLabelByName(labelName)
        if (created) return created
      } catch {
        // Fall back to standard createLabel
      }
    }
    return gmailApp.createLabel(labelName)
  } catch (e) {
    console.error(
      '[ensureGmailLabel] Error creating label:',
      labelName,
      e.message
    )
    return null
  }
}

/**
 * Creates a permanent Gmail filter rule mapping a sender address to a label.
 *
 * Returns true if the filter was created, false if the Advanced Gmail Service
 * was unavailable or creation failed.
 *
 * @param {string} senderEmail - Sender address (raw, may include display name)
 * @param {string} labelName - Target canonical label name
 * @param {Object|null} gmailService - GAS Gmail advanced service (injected; may be null)
 * @param {Object} gmailApp - GAS GmailApp service (injected for testability)
 * @returns {boolean}
 */
function createPermanentGmailFilter(
  senderEmail,
  labelName,
  gmailService,
  gmailApp
) {
  const ltIdx = senderEmail.indexOf('<')
  const gtIdx = senderEmail.indexOf('>', ltIdx + 1)
  const cleanSender =
    ltIdx !== -1 && gtIdx !== -1
      ? senderEmail.slice(ltIdx + 1, gtIdx).trim()
      : senderEmail.trim()
  const targetLabel = ensureGmailLabel(labelName, gmailApp)
  if (!targetLabel) return false

  if (gmailService?.Users?.Settings?.Filters) {
    try {
      const existingFilters = gmailService.Users.Settings.Filters.list('me')
      if (existingFilters?.filter) {
        const duplicate = existingFilters.filter.some(function (f) {
          return f.criteria?.from === cleanSender
        })
        if (duplicate) {
          console.log(
            '[createPermanentGmailFilter] Filter already exists for label:',
            labelName
          )
          return true
        }
      }
    } catch (e) {
      console.error(
        '[createPermanentGmailFilter] Error checking existing filters:',
        e.message
      )
    }

    const filterBody = {
      criteria: { from: cleanSender },
      action: { addLabelIds: [targetLabel.getId()] },
    }

    try {
      gmailService.Users.Settings.Filters.create(filterBody, 'me')
      console.log(
        '[createPermanentGmailFilter] Permanent filter created for label:',
        labelName
      )
      return true
    } catch (e) {
      console.error(
        '[createPermanentGmailFilter] Error creating filter:',
        e.message
      )
      return false
    }
  }

  console.log(
    '[createPermanentGmailFilter] Advanced Gmail service not enabled. Skipped.'
  )
  return false
}

/**
 * Sets the Gmail system category tab (Primary, Updates, Promotions, Social, Forums)
 * via the Advanced Gmail API.
 *
 * @param {Object} thread - GmailThread object
 * @param {string} targetCategory - One of 'Primary', 'Updates', 'Promotions', 'Social', 'Forums'
 * @param {Object} [gmailService] - Optional injected Advanced Gmail service (defaults to global Gmail)
 */
function setGmailCategoryTab(thread, targetCategory, gmailService) {
  var gmail = gmailService || (typeof Gmail !== 'undefined' ? Gmail : null)
  if (
    !gmail ||
    !gmail.Users ||
    !gmail.Users.Threads ||
    !gmail.Users.Threads.modify
  ) {
    return
  }

  var catMap = {
    Primary: 'CATEGORY_PERSONAL',
    Updates: 'CATEGORY_UPDATES',
    Promotions: 'CATEGORY_PROMOTIONS',
    Social: 'CATEGORY_SOCIAL',
    Forums: 'CATEGORY_FORUMS',
  }

  var targetId = catMap[targetCategory]
  if (!targetId) return

  var allCategoryIds = [
    'CATEGORY_PERSONAL',
    'CATEGORY_UPDATES',
    'CATEGORY_PROMOTIONS',
    'CATEGORY_SOCIAL',
    'CATEGORY_FORUMS',
  ]

  var removeIds = allCategoryIds.filter(function (id) {
    return id !== targetId
  })

  try {
    gmail.Users.Threads.modify(
      {
        addLabelIds: [targetId],
        removeLabelIds: removeIds,
      },
      'me',
      thread.getId()
    )
    var threadSubject =
      typeof thread.getFirstMessageSubject === 'function'
        ? thread.getFirstMessageSubject()
        : thread.getId()
    console.log(
      '[setGmailCategoryTab] Assigned category ' +
        targetId +
        ' to thread: ' +
        threadSubject
    )
  } catch (e) {
    console.warn(
      '[setGmailCategoryTab] Could not modify thread category: ' + e.message
    )
  }
}

/**
 * Removes any pre-existing conflicting Core Domain labels, Sub-Labels, legacy flat labels,
 * and redundant 'Retention/Permanent' tags to enforce a strict, clean label budget.
 */
function cleanConflictingLabels(thread, targetDomain, targetSubLabel, config) {
  try {
    var existingLabels = thread.getLabels()
    var canonicalDomains = (config && config.canonicalDomains) || []

    var legacyFlatLabels = [
      'Finance',
      'Household',
      'Family',
      'Projects',
      'Work',
      'Community',
      'Tech',
      'Purchases',
      'Banking',
      'Bills',
      'eBills',
      'Insurance',
      'Sent',
      'Archives',
    ]

    for (var j = 0; j < existingLabels.length; j++) {
      var lObj = existingLabels[j]
      var lName =
        typeof lObj.getName === 'function' ? lObj.getName() : String(lObj)

      // 1. Strip redundant Retention/Permanent (Inverted Model: blank = permanent)
      if (lName === 'Retention/Permanent') {
        thread.removeLabel(lObj)
        console.log(
          '[cleanConflictingLabels] Stripped Retention/Permanent: ' + lName
        )
        continue
      }

      // 2. Protect valid short-lived retention expiration tags
      if (lName.indexOf('Retention/') === 0) {
        continue
      }

      // 3. Protect global status and system labels
      if (lName === ((config && config.processedLabel) || 'Processed')) {
        continue
      }

      // 4. Clean legacy flat labels
      for (var f = 0; f < legacyFlatLabels.length; f++) {
        if (lName.toLowerCase() === legacyFlatLabels[f].toLowerCase()) {
          thread.removeLabel(lObj)
          console.log(
            '[cleanConflictingLabels] Stripped legacy flat label: ' + lName
          )
          break
        }
      }

      // 5. Clean ALL Core Domain labels (threads only carry Sub-Labels, never raw domain codes)
      var isDomainCode = isRootDomainLabel(lName)
      if (!isDomainCode) {
        for (var d = 0; d < canonicalDomains.length; d++) {
          if (lName === canonicalDomains[d]) {
            isDomainCode = true
            break
          }
        }
      }
      if (isDomainCode) {
        thread.removeLabel(lObj)
        console.log(
          '[cleanConflictingLabels] Removed domain code label: ' + lName
        )
        continue
      }

      // 6. Clean conflicting sub-labels if they don't match targetSubLabel
      if (
        lName.indexOf('/') !== -1 &&
        lName !== targetSubLabel &&
        lName.indexOf('Archives') === -1 &&
        lName.indexOf('Retention/') === -1
      ) {
        thread.removeLabel(lObj)
        console.log(
          '[cleanConflictingLabels] Removed conflicting sub-label: ' + lName
        )
      }
    }
  } catch (e) {
    console.warn('[cleanConflictingLabels] Error cleaning labels: ' + e.message)
  }
}

/**
 * Fast-path deterministic rule-based classifier.
 * Categorizes unambiguous broadcast feeds, machine telemetry, routine receipts,
 * and social newsletters in 0ms without consuming Gemini API quota.
 * Strictly respects safety shields (user-sent, family, and 1:1 teacher correspondence).
 *
 * @param {string} sender - Email sender header
 * @param {string} subject - Email subject line
 * @param {string} snippet - Email body snippet
 * @param {Object} [thread] - GmailThread object (for sender/reply safety checks)
 * @param {Object} [config] - Classifier configuration
 * @returns {Object|null} Classification object or null if email requires Gemini LLM reasoning
 */
function deterministicRuleClassify_(sender, subject, snippet, thread, config) {
  var sLower = (sender || '').toLowerCase()
  var subLower = (subject || '').toLowerCase()
  var userEmail = (
    config && config.userAccountEmail ? config.userAccountEmail : ''
  ).toLowerCase()

  // 1. Safety Shields
  if (thread && typeof thread.getMessages === 'function' && userEmail) {
    try {
      var msgs = thread.getMessages() || []
      for (var m = 0; m < msgs.length; m++) {
        var fromA = (msgs[m].getFrom() || '').toLowerCase()
        if (fromA.indexOf(userEmail) !== -1) {
          return {
            canonicalDomain: null,
            canonical_label: null,
            subLabel: null,
            category: 'Primary',
            action: 'keep',
            confidence: 1.0,
            title: subject,
            summary: 'User-sent or replied thread preserved in Primary Inbox.',
            reasoning: 'User-Sent Shield',
          }
        }
      }
    } catch {
      // ignore thread check errors
    }
  }

  // Family 1:1 Shield (configurable via config.familyEmails or customPromptRules)
  var familyList =
    config && config.familyEmails
      ? config.familyEmails.toLowerCase().split(',')
      : []
  if (
    familyList.length > 0 &&
    familyList.some(function (f) {
      return f.trim() && sLower.indexOf(f.trim()) !== -1
    })
  ) {
    return {
      canonicalDomain: '04_Family_Health',
      canonical_label: '04_Family_Health',
      subLabel: 'Family/Correspondence',
      category: 'Primary',
      action: 'keep',
      confidence: 1.0,
      title: subject,
      summary: 'Direct family correspondence preserved in Primary Inbox.',
      reasoning: 'Family 1:1 Shield',
    }
  }

  // Teacher / Academic Counselor 1:1 Shield (exclude mass broadcast subjects)
  var isSchoolDomain =
    sLower.indexOf('bcsk12.org') !== -1 ||
    sLower.indexOf('mcaabhm.org') !== -1 ||
    sLower.indexOf('jeffersonstate.edu') !== -1
  var isBroadcastSubject = [
    'weekly',
    'newsletter',
    'bulletin',
    'update',
    'digest',
    'progress is ready',
    'lunch',
    'menu',
    'portraits',
    'news',
    'noteworthy',
    'announcement',
    'athletics',
  ].some(function (w) {
    return subLower.indexOf(w) !== -1
  })

  if (isSchoolDomain && !isBroadcastSubject) {
    return {
      canonicalDomain: '04_Family_Health',
      canonical_label: '04_Family_Health',
      subLabel: 'Family/School-Student',
      category: 'Primary',
      action: 'keep',
      confidence: 1.0,
      title: subject,
      summary:
        'Direct 1:1 teacher or school counselor correspondence preserved in Primary Inbox.',
      reasoning: 'Teacher 1:1 Shield',
    }
  }

  // 2. Deterministic Feeds & Broadcasts
  // Automated Daily Agenda Digests
  if (subLower.indexOf('your day ahead') !== -1) {
    return {
      canonicalDomain: '01_Household',
      canonical_label: '01_Household',
      subLabel: 'Household/Property',
      category: 'Updates',
      action: 'archive',
      confidence: 0.99,
      title: subject,
      summary: 'Automated daily agenda digest routed to Updates.',
      reasoning: 'Daily Digest',
    }
  }

  // Bee Telemetry (BroodMinder)
  if (
    sLower.indexOf('broodminder') !== -1 ||
    subLower.indexOf('hive alert') !== -1 ||
    sLower.indexOf('alerts@broodminder.com') !== -1
  ) {
    return {
      canonicalDomain: '07_Community_NonProfit',
      canonical_label: '07_Community_NonProfit',
      subLabel: 'Projects/Telemetry',
      category: 'Updates',
      action: 'archive',
      confidence: 0.99,
      title: subject,
      summary: 'Automated hive telemetry alert routed to Projects/Telemetry.',
      reasoning: 'BroodMinder Telemetry',
    }
  }

  // Developer & Infrastructure Monitoring Alerts
  if (
    sLower.indexOf('notifications@linear.app') !== -1 ||
    sLower.indexOf('linear.app') !== -1
  ) {
    return {
      canonicalDomain: '05_Tech_Infrastructure',
      canonical_label: '05_Tech_Infrastructure',
      subLabel: 'Tech/Alerts',
      category: 'Updates',
      action: 'archive',
      confidence: 0.99,
      title: subject,
      summary:
        'Linear task and project notification digest routed to Tech/Alerts.',
      reasoning: 'Linear Alert',
    }
  }
  if (
    sLower.indexOf('notifications.cubic.dev') !== -1 ||
    sLower.indexOf('cubic') !== -1
  ) {
    return {
      canonicalDomain: '05_Tech_Infrastructure',
      canonical_label: '05_Tech_Infrastructure',
      subLabel: 'Tech/Alerts',
      category: 'Updates',
      action: 'archive',
      confidence: 0.99,
      title: subject,
      summary: 'Cubic AI automated code review notice routed to Tech/Alerts.',
      reasoning: 'Cubic Code Review',
    }
  }
  if (sLower.indexOf('notifications@github.com') !== -1) {
    return {
      canonicalDomain: '05_Tech_Infrastructure',
      canonical_label: '05_Tech_Infrastructure',
      subLabel: 'Tech/Alerts',
      category: 'Updates',
      action: 'archive',
      confidence: 0.99,
      title: subject,
      summary:
        'GitHub CI/CD workflow run or notification routed to Tech/Alerts.',
      reasoning: 'GitHub Alert',
    }
  }

  // IoT, Weather & Automation Alerts (IFTTT)
  if (
    sLower.indexOf('action@ifttt.com') !== -1 ||
    sLower.indexOf('ifttt.com') !== -1
  ) {
    return {
      canonicalDomain: '01_Household',
      canonical_label: '01_Household',
      subLabel: 'Household/Property',
      category: 'Updates',
      action: 'archive',
      confidence: 0.98,
      title: subject,
      summary:
        'Automated weather or IoT trigger notification routed to Household/Property.',
      reasoning: 'IFTTT / Weather Alert',
    }
  }

  // School Broadcasts & Bulletins (including ParentSquare & College parent newsletters)
  if (
    (isSchoolDomain ||
      sLower.indexOf('parentsquare.com') !== -1 ||
      sLower.indexOf('briarwoodchristianschool.org') !== -1 ||
      sLower.indexOf('admissions@ua.edu') !== -1) &&
    (isBroadcastSubject || sLower.indexOf('parentsquare.com') !== -1)
  ) {
    return {
      canonicalDomain: '04_Family_Health',
      canonical_label: '04_Family_Health',
      subLabel: 'Family/School-Student',
      category: 'Updates',
      action: 'archive',
      confidence: 0.98,
      title: subject,
      summary:
        'Routine school bulletin, newsletter, or ParentSquare digest routed to Updates.',
      reasoning: 'School Broadcast',
    }
  }

  // Routine Healthcare / Benefits Wellness Broadcasts
  if (sLower.indexOf('hello.springhealth.com') !== -1) {
    return {
      canonicalDomain: '04_Family_Health',
      canonical_label: '04_Family_Health',
      subLabel: 'Family/Health-Medical',
      category: 'Updates',
      action: 'archive',
      confidence: 0.98,
      title: subject,
      summary:
        'Routine employer healthcare benefit announcement or wellness newsletter.',
      reasoning: 'Benefits Broadcast',
    }
  }

  // Order Deliveries & Shipping Tracking
  if (
    sLower.indexOf('ebay.com') !== -1 &&
    (subLower.indexOf('delivered') !== -1 ||
      subLower.indexOf('out for delivery') !== -1 ||
      subLower.indexOf('order confirmed') !== -1 ||
      subLower.indexOf('shipped') !== -1)
  ) {
    return {
      canonicalDomain: '02_Finance_Legal',
      canonical_label: '02_Finance_Legal',
      subLabel: 'Finance/Purchases',
      category: 'Updates',
      action: 'archive',
      confidence: 0.98,
      title: subject,
      summary: 'Online order confirmation or package delivery tracking notice.',
      reasoning: 'Order Tracking',
    }
  }
  if (
    sLower.indexOf('amazon.com') !== -1 &&
    (subLower.indexOf('ordered:') !== -1 ||
      subLower.indexOf('shipped:') !== -1 ||
      subLower.indexOf('delivered:') !== -1 ||
      subLower.indexOf('refund issued') !== -1 ||
      subLower.indexOf('auto-reloaded') !== -1)
  ) {
    return {
      canonicalDomain: '02_Finance_Legal',
      canonical_label: '02_Finance_Legal',
      subLabel: 'Finance/Purchases',
      category: 'Updates',
      action: 'archive',
      confidence: 0.98,
      title: subject,
      summary: 'Routine Amazon e-commerce order, shipping, or refund update.',
      reasoning: 'Amazon Routine',
    }
  }

  // Routine Utility & Bank Statements
  if (
    sLower.indexOf('capitalone') !== -1 ||
    sLower.indexOf('chase.com') !== -1 ||
    sLower.indexOf('bankofamerica.com') !== -1 ||
    sLower.indexOf('spireenergy.com') !== -1 ||
    sLower.indexOf('spectrum') !== -1 ||
    sLower.indexOf('message.att-mail.com') !== -1
  ) {
    if (
      subLower.indexOf('statement') !== -1 ||
      subLower.indexOf('autopay') !== -1 ||
      subLower.indexOf('payment processed') !== -1 ||
      subLower.indexOf('bill is ready') !== -1
    ) {
      return {
        canonicalDomain: '02_Finance_Legal',
        canonical_label: '02_Finance_Legal',
        subLabel: 'Finance/Bills',
        category: 'Updates',
        action: 'archive',
        confidence: 0.98,
        title: subject,
        summary: 'Routine billing statement, receipt, or AutoPay confirmation.',
        reasoning: 'Routine Billing',
      }
    }
  }

  // Newsletters, Digests, Political Blasts, Social Media
  if (
    sLower.indexOf('nytimes.com') !== -1 ||
    sLower.indexOf('nextdoor.com') !== -1 ||
    sLower.indexOf('substack.com') !== -1 ||
    sLower.indexOf('dougforalabama') !== -1 ||
    sLower.indexOf('ossoff') !== -1 ||
    sLower.indexOf('the passion translation') !== -1 ||
    sLower.indexOf('redditmail.com') !== -1 ||
    sLower.indexOf('daily.therundown.ai') !== -1 ||
    sLower.indexOf('aibreakfast') !== -1 ||
    sLower.indexOf('mail.instagram.com') !== -1 ||
    sLower.indexOf('facebookmail.com') !== -1
  ) {
    return {
      canonicalDomain: null,
      canonical_label: null,
      subLabel: null,
      category: 'Social',
      action: 'archive',
      confidence: 0.98,
      title: subject,
      summary:
        'Routine media newsletter, Substack digest, or political appeal.',
      reasoning: 'News/Newsletter/Social',
    }
  }

  // Retail & E-Commerce Marketing Blasts
  const isScarsella = sLower.indexOf('scarsella') !== -1
  const isScarsellaCurriculum =
    isScarsella &&
    /\b(curriculum|schedule|testing|belt|forms?)\b/i.test(
      (subject || '') + ' ' + (snippet || '')
    )

  if (
    sLower.indexOf('lowes') !== -1 ||
    sLower.indexOf('mannlake') !== -1 ||
    sLower.indexOf('urotuning') !== -1 ||
    sLower.indexOf('ray-ban') !== -1 ||
    sLower.indexOf('americanmeadows') !== -1 ||
    sLower.indexOf('foxhound') !== -1 ||
    sLower.indexOf('bhphotovideo') !== -1 ||
    sLower.indexOf('starbucks') !== -1 ||
    sLower.indexOf('birminghamhomebuyers') !== -1 ||
    sLower.indexOf('trailerparts') !== -1 ||
    sLower.indexOf('hillco') !== -1 ||
    (isScarsella && !isScarsellaCurriculum) ||
    sLower.indexOf('em1.cloudflare.com') !== -1
  ) {
    return {
      canonicalDomain: null,
      canonical_label: null,
      subLabel: null,
      category: 'Promotions',
      action: 'archive',
      confidence: 0.98,
      title: subject,
      summary:
        'Commercial vendor retail promo, discount, or marketing announcement.',
      reasoning: 'Retail Promo',
    }
  }

  return null
}

/**
 * Processes a batch of Gmail threads: classify, label, and optionally create filters.
 *
 * @param {Object[]} threads - Array of GmailThread objects
 * @param {Object} config - Classifier configuration
 * @param {Object} services - Injected GAS services: { GmailApp, UrlFetchApp, Gmail }
 * @returns {Object[]} Array of result objects describing outcome per thread
 */
function processThreadBatch(threads, config, services) {
  const processedLabel = ensureGmailLabel(
    config.processedLabel,
    services.GmailApp
  )
  if (!processedLabel) {
    console.error(
      '[processThreadBatch] Processed label unavailable; aborting batch to avoid reprocessing.'
    )
    return []
  }
  const results = []

  threads.forEach(function (thread) {
    const messages = thread.getMessages()
    if (!messages || messages.length === 0) {
      results.push({ threadId: thread.getId(), status: 'empty' })
      return
    }

    const latestMsg = messages[0]
    const sender = latestMsg.getFrom()
    const subject = latestMsg.getSubject()
    let bodySnippet = latestMsg.getPlainBody()
      ? latestMsg.getPlainBody().substring(0, 1200)
      : ''
    if (
      bodySnippet.trim().length < 15 &&
      typeof latestMsg.getAttachments === 'function'
    ) {
      try {
        const atts = latestMsg.getAttachments() || []
        const attNames = atts
          .map((a) => (typeof a.getName === 'function' ? a.getName() : ''))
          .filter(Boolean)
        if (attNames.length > 0) {
          bodySnippet =
            (bodySnippet.trim() ? bodySnippet.trim() + ' ' : '') +
            '[Attached: ' +
            attNames.join(', ') +
            ']'
        }
      } catch {
        // ignore attachment errors
      }
    }

    let classification = deterministicRuleClassify_(
      sender,
      subject,
      bodySnippet,
      thread,
      config
    )
    if (!classification) {
      classification = classifyEmailWithGemini(
        config,
        sender,
        subject,
        bodySnippet,
        services.UrlFetchApp
      )
    }
    if (!classification) {
      console.log(
        '[processThreadBatch] Could not classify thread:',
        thread.getId()
      )
      results.push({ threadId: thread.getId(), status: 'unclassified' })
      return
    }

    console.log(
      '[processThreadBatch] Classified as:',
      classification.canonical_label,
      '(Confidence:',
      classification.confidence,
      ')'
    )

    var primaryTag = classification.subLabel
    if (!primaryTag || isRootDomainLabel(primaryTag)) {
      var dom = classification.canonicalDomain || classification.canonical_label
      primaryTag = (dom && DEFAULT_DOMAIN_SUBLABEL_MAP[dom]) || dom || null
      if (primaryTag && isRootDomainLabel(primaryTag)) {
        primaryTag = DEFAULT_DOMAIN_SUBLABEL_MAP[primaryTag] || null
      }
    }

    if (typeof cleanConflictingLabels === 'function') {
      cleanConflictingLabels(
        thread,
        classification.canonicalDomain || classification.canonical_label,
        primaryTag,
        config
      )
    }

    if (primaryTag) {
      const categoryLabel = ensureGmailLabel(
        primaryTag,
        services.GmailApp,
        services.Gmail
      )
      if (!categoryLabel) {
        console.error(
          '[processThreadBatch] Failed to create category label:',
          primaryTag
        )
        results.push({
          threadId: thread.getId(),
          status: 'label_creation_failed',
        })
        return
      }
      thread.addLabel(categoryLabel)
    }
    thread.addLabel(processedLabel)

    // Category-Driven Action Invariant:
    // Primary belongs in the Action Queue (Inbox).
    // Non-Primary categories (Updates, Promotions, Social, Forums) are Informational Streams
    // that deterministically bypass the Primary Inbox into their category tab and domain sub-label.
    if (
      classification.category &&
      classification.category !== 'Primary' &&
      classification.action !== 'trash'
    ) {
      classification.action = 'archive'
    }

    if (
      classification.category &&
      classification.action !== 'trash' &&
      typeof setGmailCategoryTab === 'function'
    ) {
      setGmailCategoryTab(thread, classification.category, services.Gmail)
    }

    if (
      classification.action === 'archive' &&
      typeof thread.moveToArchive === 'function'
    ) {
      thread.moveToArchive()
    }

    let filterCreated = false
    if (classification.confidence >= config.autoFilterConfidenceThreshold) {
      filterCreated = createPermanentGmailFilter(
        sender,
        classification.canonical_label,
        services.Gmail,
        services.GmailApp
      )
    }

    let savedAttachments = []
    if (services?.DriveApp) {
      savedAttachments = persistCanonicalAttachmentsToDrive(
        thread,
        classification,
        config,
        services
      )
    }

    results.push({
      threadId: thread.getId(),
      status: 'classified',
      label: classification.canonical_label,
      confidence: classification.confidence,
      filterCreated: filterCreated,
      savedAttachments: savedAttachments,
    })
  })

  return results
}

const GITHUB_REPO_OWNER = 'don-petry'
const GITHUB_REPO_NAME = 'self-private'

const RULE6_PATTERNS = [
  [/\S \? \S/, "' ? ' between words (was an em dash or a · separator)"],
  [/\?\?/, "'??' (was a multi-codepoint emoji)"],
  [/[A-Za-z]\?[A-Za-z]/, "'?' inside a word (was a curly apostrophe)"],
  [/\uFFFD/, 'U+FFFD replacement character'],
]

/** Refuse to write an entry that already shows mojibake. */
function assertClean_(text, what) {
  if (!text) return
  for (let i = 0; i < RULE6_PATTERNS.length; i++) {
    if (RULE6_PATTERNS[i][0].test(text)) {
      throw new Error(
        'Rule 6: refusing to write ' + what + ' — ' + RULE6_PATTERNS[i][1]
      )
    }
  }
}

/** Refuse to write when a non-ASCII char in the source text became '?' on the way out. */
function assertNoAsciiReplacement_(source, rendered) {
  if (!source || !rendered) return
  if (rendered.indexOf('?') === -1) return
  const lost = []
  for (let i = 0; i < source.length; i++) {
    const c = source.charAt(i)
    if (
      c.charCodeAt(0) > 127 &&
      rendered.indexOf(c) === -1 &&
      lost.indexOf(c) === -1
    ) {
      lost.push(c)
    }
  }
  if (lost.length) {
    throw new Error(
      'Rule 6: refusing to write text that flattened non-ASCII to "?": ' +
        lost.join(' ') +
        ' — encode as UTF-8, not ASCII.'
    )
  }
}

function extractTopicTitleFromPath(filePath) {
  const parts = filePath.split('/')
  const topic = parts.length > 1 ? parts[parts.length - 2] : parts[0]
  // Strip any trailing file extension (e.g. ".md") before title-casing so a
  // single-segment path like "digital-backups.md" becomes "Digital Backups".
  return topic
    .replace(/\.[^.]+$/, '')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, function (l) {
      return l.toUpperCase()
    })
}

function insertEntryIntoLogSection(fullContent, newEntry) {
  const detailsMarker = '</details>'
  const detailsIndex = fullContent.indexOf(detailsMarker)

  if (detailsIndex !== -1) {
    return (
      fullContent.substring(0, detailsIndex) +
      newEntry +
      '\n' +
      fullContent.substring(detailsIndex)
    )
  }

  const section3Marker = '## 3. Ingested Activity'
  const section3Index = fullContent.indexOf(section3Marker)

  if (section3Index !== -1) {
    const lineBreakIndex = fullContent.indexOf('\n', section3Index)
    return (
      fullContent.substring(0, lineBreakIndex + 1) +
      newEntry +
      '\n' +
      fullContent.substring(lineBreakIndex + 1)
    )
  }

  return fullContent + '\n' + newEntry
}

function formatProgressiveDisclosureEntry(
  dateStr,
  title,
  sender,
  subject,
  summaryText,
  accountEmail,
  attachments
) {
  let entry = '\n### ' + dateStr + ' — ' + title + '\n'
  entry += '- **Account**: ' + accountEmail + '\n'
  entry += '- **From**: ' + sender + '\n'
  entry += '- **Subject**: ' + subject + '\n'
  if (summaryText) {
    entry += '- **Summary**:\n  > ' + summaryText.trim() + '\n'
  }
  if (attachments && attachments.length > 0) {
    entry += '- **Attachments**:\n'
    for (let a = 0; a < attachments.length; a++) {
      const att = attachments[a]
      if (att?.name) {
        if (att.url) {
          entry += '  - [' + att.name + '](' + att.url + ')\n'
        } else {
          entry += '  - ' + att.name + '\n'
        }
      }
    }
  }
  return entry
}

function getNotePathForDomain(domain, _subLabel) {
  const map = {
    '01_Household': '01_Household/index.md',
    '02_Finance_Legal': '02_Finance_Legal/index.md',
    '03_Vehicles': '03_Vehicles/index.md',
    '04_Family_Health': '04_Family_Health/index.md',
    '05_Tech_Infrastructure': '05_Tech_Infrastructure/index.md',
    '06_Work_Career': '06_Work_Career/index.md',
    '07_Community_NonProfit': '07_Community_NonProfit/index.md',
  }
  if (typeof PropertiesService !== 'undefined') {
    try {
      const customMapJson =
        PropertiesService.getScriptProperties().getProperty('CUSTOM_NOTE_PATHS')
      if (customMapJson) {
        const customMap = JSON.parse(customMapJson)
        if (customMap && customMap[domain]) {
          return customMap[domain]
        }
      }
    } catch {
      // Fall through to default map
    }
  }
  return map[domain] || null
}

function appendMarkdownEntryToGitHubRepo(
  filePath,
  entryMd,
  commitMessage,
  services
) {
  const props =
    services?.PropertiesService ||
    (typeof PropertiesService !== 'undefined' ? PropertiesService : null)
  const githubToken = props?.getScriptProperties()?.getProperty('GITHUB_PAT')
  if (!githubToken) {
    console.log(
      '[gitHubSync] GITHUB_PAT ScriptProperty not set. Skipping GitHub commit.'
    )
    return false
  }

  const sleep = services?.sleepFn || _sleep
  const maxRetries = 3
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const result = executeGitHubCommit(
      filePath,
      entryMd,
      commitMessage,
      githubToken,
      services
    )
    if (result === true || result === 'IDEMPOTENT_SKIP') {
      return true
    }
    console.log(
      '[gitHubSync] Retry attempt',
      attempt,
      'of',
      maxRetries,
      'for',
      filePath
    )
    sleep(1000 * attempt)
  }

  console.error(
    '[gitHubSync] Failed to commit entry to GitHub after',
    maxRetries,
    'attempts:',
    filePath
  )
  return false
}

function executeGitHubCommit(
  filePath,
  entryMd,
  commitMessage,
  githubToken,
  services
) {
  const urlFetchApp =
    services?.UrlFetchApp ||
    (typeof UrlFetchApp !== 'undefined' ? UrlFetchApp : null)
  const utils =
    services?.Utilities || (typeof Utilities !== 'undefined' ? Utilities : null)

  const repoOwner =
    services?.githubRepoOwner ||
    process.env.GITHUB_REPO_OWNER ||
    GITHUB_REPO_OWNER
  const repoName =
    services?.githubRepoName || process.env.GITHUB_REPO_NAME || GITHUB_REPO_NAME

  const url =
    'https://api.github.com/repos/' +
    repoOwner +
    '/' +
    repoName +
    '/contents/' +
    filePath
  const headers = {
    Authorization: 'token ' + githubToken,
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'Google-Apps-Script',
  }

  try {
    const getOptions = {
      method: 'get',
      headers: headers,
      muteHttpExceptions: true,
    }
    const res = urlFetchApp.fetch(url, getOptions)
    const statusCode = res.getResponseCode()

    let sha = null
    let rawContent = ''

    if (statusCode === 404) {
      console.log(
        '[gitHubSync] File not found on GitHub (HTTP 404). Initializing new note:',
        filePath
      )
      const topicTitle = extractTopicTitleFromPath(filePath)
      const dateStr = utils?.formatDate
        ? utils.formatDate(new Date(), 'GMT', 'yyyy-MM-dd')
        : new Date().toISOString().slice(0, 10)
      rawContent =
        '---\ntitle: ' +
        topicTitle +
        '\ncreated: ' +
        dateStr +
        '\nnotebook: household\nsection: general\n---\n\n' +
        '# ' +
        topicTitle +
        '\n\n' +
        '## 1. Executive Summary & Active Status\n- Ingested records log.\n\n' +
        '## 2. Key References & Quick Links\n| Topic | Asset |\n| :--- | :--- |\n\n' +
        '## 3. Ingested Activity Logs\n<details open><summary><b>Activity Logs</b></summary>\n</details>\n'
    } else if (statusCode === 200) {
      const fileData = JSON.parse(res.getContentText())
      sha = fileData.sha
      // GitHub Contents API wraps Base64 in newlines every 60 chars; strip them
      // before decoding since some decoders reject embedded whitespace.
      rawContent = utils
        .newBlob(
          utils.base64Decode((fileData.content || '').replace(/[\r\n]/g, ''))
        )
        .getDataAsString()

      if (
        rawContent.indexOf(entryMd.trim()) !== -1 ||
        (commitMessage && rawContent.indexOf(commitMessage) !== -1)
      ) {
        console.log(
          '[gitHubSync] Idempotent Skip: Entry already exists in',
          filePath
        )
        return 'IDEMPOTENT_SKIP'
      }
    } else {
      console.error(
        '[gitHubSync] Error fetching file from GitHub (HTTP ' +
          statusCode +
          '):',
        res.getContentText()
      )
      return false
    }

    const updatedContent = insertEntryIntoLogSection(rawContent, entryMd)

    assertClean_(entryMd, 'new entry for ' + filePath)

    const base64Updated = utils.base64Encode(
      utils.newBlob(updatedContent).getBytes()
    )

    // Validate the ACTUAL Base64 round trip at the payload boundary: decode what
    // we are about to PUT and confirm no non-ASCII character was flattened to
    // '?'. Comparing updatedContent to entryMd/rawContent directly is inert
    // because updatedContent contains both source strings unchanged.
    const renderedContent = utils
      .newBlob(utils.base64Decode(base64Updated))
      .getDataAsString()
    assertNoAsciiReplacement_(updatedContent, renderedContent)

    const putPayload = {
      message:
        commitMessage ||
        'feat(ingestion): append ingested document entry via Google Apps Script',
      content: base64Updated,
      branch: 'main',
    }
    if (sha) {
      putPayload.sha = sha
    }

    const putOptions = {
      method: 'put',
      headers: headers,
      contentType: 'application/json',
      payload: JSON.stringify(putPayload),
      muteHttpExceptions: true,
    }

    const putRes = urlFetchApp.fetch(url, putOptions)
    const putStatus = putRes.getResponseCode()

    if (putStatus === 200 || putStatus === 201) {
      console.log(
        '[gitHubSync] Successfully committed markdown entry to GitHub:',
        filePath
      )
      return true
    } else if (putStatus === 409) {
      console.warn('[gitHubSync] SHA collision (HTTP 409) on file:', filePath)
      return false
    } else {
      console.error(
        '[gitHubSync] Error committing to GitHub (HTTP ' + putStatus + '):',
        putRes.getContentText()
      )
      return false
    }
  } catch (e) {
    console.error('[gitHubSync] Exception calling GitHub API:', e.message)
    return false
  }
}

function formatAuditDate_(d) {
  const y = d.getFullYear()
  const m = ('0' + (d.getMonth() + 1)).slice(-2)
  const da = ('0' + d.getDate()).slice(-2)
  return y + '/' + m + '/' + da
}

function getSearchDateRange_(dateStr, days) {
  const parts = dateStr.split('-')
  const year = Number.parseInt(parts[0], 10)
  const month = Number.parseInt(parts[1], 10) - 1
  const day = Number.parseInt(parts[2], 10)
  const dt = new Date(year, month, day)

  const beforeDt = new Date(dt.getTime() + (days + 1) * 86400000)
  const afterDt = new Date(dt.getTime() - days * 86400000)

  return {
    after: formatAuditDate_(afterDt),
    before: formatAuditDate_(beforeDt),
  }
}

/**
 * Audits a collection of processed Gmail threads for classification anomalies.
 *
 * @param {Array} threads - Array of GmailThread-like objects
 * @param {Object} config - Classifier config
 * @returns {Object} report - { scannedCount, flaggedCount, findings, summary }
 */
function auditClassifications(threads, config) {
  const canonicalDomains = config?.canonicalDomains || [
    '01_Household',
    '02_Finance_Legal',
    '03_Vehicles',
    '04_Family_Health',
    '05_Tech_Infrastructure',
    '06_Work_Career',
    '07_Community_NonProfit',
  ]

  const PROMO_KEYWORDS =
    /\b(sale|\d+% off|deal of the day|clearance|limited time offer|coupon|shop now)\b/i
  const NEWSLETTER_KEYWORDS =
    /\b(weekly digest|daily digest|newsletter|roundup|top stories)\b/i
  const ORDER_KEYWORDS =
    /\b(order confirmation|your order|receipt|payment received|invoice|shipped)\b/i
  const TOS_KEYWORDS =
    /\b(terms of service|privacy policy|terms and conditions|user agreement|arbitration terms)\b/i

  const findings = []

  if (!Array.isArray(threads)) {
    return {
      scannedCount: 0,
      flaggedCount: 0,
      findings: [],
      summary: 'No threads to audit.',
    }
  }

  threads.forEach((thread) => {
    if (!thread) return
    const id =
      typeof thread.getId === 'function' ? thread.getId() : thread.id || ''
    const subject =
      typeof thread.getFirstMessageSubject === 'function'
        ? thread.getFirstMessageSubject()
        : thread.subject || ''

    let sender = ''
    if (typeof thread.getMessages === 'function') {
      const msgs = thread.getMessages()
      if (msgs && msgs.length > 0 && typeof msgs[0].getFrom === 'function') {
        sender = msgs[0].getFrom()
      }
    } else if (thread.sender) {
      sender = thread.sender
    }

    let rawLabels = []
    if (typeof thread.getLabels === 'function') {
      const labelObjs = thread.getLabels() || []
      rawLabels = labelObjs.map((l) =>
        typeof l.getName === 'function' ? l.getName() : String(l)
      )
    } else if (Array.isArray(thread.labels)) {
      rawLabels = thread.labels
    }

    const assignedCanonical = rawLabels.filter(
      (l) => canonicalDomains.includes(l) || /^0[1-7]_/.test(l)
    )
    const flags = []

    // 1. Missing Domain
    if (assignedCanonical.length === 0) {
      flags.push(
        'MISSING_CANONICAL_DOMAIN: Thread marked as processed has no canonical domain label.'
      )
    }

    // 2. Conflicting Domains
    if (assignedCanonical.length > 1) {
      flags.push(
        'CONFLICTING_DOMAINS: Multiple canonical domain labels assigned: ' +
          assignedCanonical.join(', ')
      )
    }

    // 3. Heuristic Checks
    const fullText = (subject + ' ' + sender).toLowerCase()
    if (ORDER_KEYWORDS.test(fullText)) {
      const hasFinanceOrHousehold = assignedCanonical.some(
        (l) =>
          l.includes('02_Finance_Legal') ||
          l.includes('01_Household') ||
          l.includes('03_Vehicles')
      )
      if (assignedCanonical.length > 0 && !hasFinanceOrHousehold) {
        flags.push(
          'SUSPICIOUS_ROUTING: Purchase/receipt keywords detected but domain is ' +
            assignedCanonical.join(', ') +
            ' instead of 02_Finance_Legal.'
        )
      }
    }

    if (PROMO_KEYWORDS.test(subject) && assignedCanonical.length > 0) {
      const hasMarketingSublabel = rawLabels.some((l) =>
        /promo|marketing|deal|coupon/i.test(l)
      )
      if (!hasMarketingSublabel) {
        flags.push(
          'PROMOTIONAL_CONTENT: Promotional sale keywords in subject tagged under core domain ' +
            assignedCanonical.join(', ') +
            ' without marketing sub-label.'
        )
      }
    }

    if (NEWSLETTER_KEYWORDS.test(subject) && assignedCanonical.length > 0) {
      const hasNewsletterSublabel = rawLabels.some((l) =>
        /newsletter|digest|news/i.test(l)
      )
      if (!hasNewsletterSublabel) {
        flags.push(
          'UNLABELED_NEWSLETTER: Generic newsletter/digest subject tagged under core domain ' +
            assignedCanonical.join(', ') +
            ' without newsletter sub-label.'
        )
      }
    }

    if (
      TOS_KEYWORDS.test(subject) &&
      assignedCanonical.some((l) => l.includes('02_Finance_Legal'))
    ) {
      flags.push(
        'COMMERCIAL_TOS_IN_LEGAL: Routine commercial terms of service/privacy policy update tagged under 02_Finance_Legal instead of non-canonical broadcast.'
      )
    }

    // 4. Drive Attachment Persistence & Tagging Check
    const driveApp =
      config?.driveApp || (typeof DriveApp !== 'undefined' ? DriveApp : null)
    if (
      driveApp &&
      assignedCanonical.length === 1 &&
      typeof thread.getMessages === 'function'
    ) {
      const domain = assignedCanonical[0]
      const subLabel =
        rawLabels.find((l) => l.includes('/') && !l.includes(domain)) || ''
      const subfolderName = resolveTaxonomySubfolderName(domain, subLabel)
      const msgs = thread.getMessages() || []
      msgs.forEach((msg) => {
        const atts = getMessageAttachments_(msg)
        atts.forEach((att) => {
          if (isEligibleAttachment(att)) {
            const attName =
              typeof att.getName === 'function'
                ? att.getName()
                : att.name || 'unnamed'
            try {
              const targetFolder = ensureDriveTaxonomyFolder(
                domain,
                subfolderName,
                driveApp
              )
              const existingFiles = targetFolder.getFilesByName(attName)
              if (
                !existingFiles ||
                (typeof existingFiles.hasNext === 'function' &&
                  !existingFiles.hasNext())
              ) {
                flags.push(
                  'MISSING_DRIVE_ATTACHMENT: Eligible attachment "' +
                    attName +
                    '" is missing from Drive folder "' +
                    domain +
                    '/' +
                    subfolderName +
                    '".'
                )
              } else if (typeof existingFiles.next === 'function') {
                const driveFile = existingFiles.next()
                const desc =
                  typeof driveFile.getDescription === 'function'
                    ? driveFile.getDescription()
                    : ''
                if (!desc || !desc.includes('[AI_INDEXED]')) {
                  flags.push(
                    'UNTAGGED_DRIVE_ATTACHMENT: Attachment "' +
                      attName +
                      '" exists in Drive but lacks [AI_INDEXED] metadata description.'
                  )
                }
              }
            } catch {
              // Non-blocking folder check
            }
          }
        })
      })
    }

    if (flags.length > 0) {
      findings.push({
        threadId: id,
        subject: subject,
        sender: sender,
        canonicalLabels: assignedCanonical,
        allLabels: rawLabels,
        flags: flags,
      })
    }
  })

  return {
    scannedCount: threads.length,
    flaggedCount: findings.length,
    findings: findings,
    summary:
      'Audited ' +
      threads.length +
      ' thread(s); ' +
      findings.length +
      ' anomaly flag(s) identified.',
  }
}

/**
 * Formats an audit report into a human-readable email digest or log message.
 *
 * @param {Object} report - Result from auditClassifications
 * @returns {string} Formatted digest text
 */
function formatAuditDigest(report) {
  if (!report || report.flaggedCount === 0) {
    return (
      'Gmail AI Classifier Audit: All ' +
      (report ? report.scannedCount : 0) +
      ' analyzed threads are compliant. No anomalies detected.'
    )
  }

  let text = '===================================================\n'
  text += '   GMAIL AI CLASSIFICATION AUDIT REPORT\n'
  text += '===================================================\n'
  text += report.summary + '\n\n'

  report.findings.forEach((finding, idx) => {
    text +=
      idx + 1 + '. Subject: "' + (finding.subject || '(no subject)') + '"\n'
    text += '   Sender:  ' + (finding.sender || '(unknown)') + '\n'
    text +=
      '   Labels:  ' + (finding.canonicalLabels.join(', ') || '(none)') + '\n'
    text += '   Flags:\n'
    finding.flags.forEach((f) => {
      text += '     • ' + f + '\n'
    })
    text += '\n'
  })

  text += '---------------------------------------------------\n'
  text +=
    'Tuning Action: Update ScriptProperty CUSTOM_PROMPT_RULES to add calibrated sender rules.\n'
  text += '===================================================\n'
  return text
}

// ---------------------------------------------------------------------------
// Attachment Persistence to Google Drive along Taxonomy Path
// ---------------------------------------------------------------------------

const CANONICAL_TAXONOMY_SUBFOLDERS = {
  '01_Household': [
    'Primary_House',
    'Shop_Build',
    'Rental_Property',
    'Archive_Property',
    'Bills',
    'Maintenance',
  ],
  '02_Finance_Legal': [
    'Taxes',
    'Insurance',
    'Banking',
    'Legal_Court',
    'Estate_Planning',
    'Bills',
    'Purchases',
  ],
  '03_Vehicles': ['Car_Hunt', 'Vehicle_Fleet', 'Maintenance'],
  '04_Family_Health': [
    'Family_General',
    'Students',
    'Adults',
    'Medical_Records',
    'Activities_Camps',
  ],
  '05_Tech_Infrastructure': ['NAS_Backups', 'Tasker', 'Hardware_Licenses'],
  '06_Work_Career': ['Career_Interviews', 'Expenses_Admin'],
  '07_Community_NonProfit': ['Community_BOD', 'Projects_Telemetry'],
}

const DEFAULT_DOMAIN_SUBLABEL_MAP = {
  '01_Household': 'Household/General',
  '02_Finance_Legal': 'Finance/Banking',
  '03_Vehicles': 'Vehicles/General',
  '04_Family_Health': 'Family/General',
  '05_Tech_Infrastructure': 'Tech/Infrastructure',
  '06_Work_Career': 'Work/General',
  '07_Community_NonProfit': 'Community/NonProfit',
}

function isRootDomainLabel(name) {
  if (!name || typeof name !== 'string') return false
  return (
    !name.includes('/') &&
    (/^0[1-7]_/.test(name) ||
      (typeof DEFAULT_DOMAIN_SUBLABEL_MAP !== 'undefined' &&
        Object.prototype.hasOwnProperty.call(
          DEFAULT_DOMAIN_SUBLABEL_MAP,
          name
        )))
  )
}

const SUBLABEL_TO_FOLDER_MAP = {
  // 01_Household
  'household/general': 'Primary_House',
  'household/property': 'Primary_House',
  'household/primary-property': 'Primary_House',
  'household/primary_house': 'Primary_House',
  'household/primary': 'Primary_House',
  'household/home-maintenance': 'Maintenance',
  'household/maintenance': 'Maintenance',
  'household/utilities': 'Bills',
  'household/bills': 'Bills',
  'household/shop': 'Shop_Build',
  'household/shop-build': 'Shop_Build',
  'household/travel': 'Primary_House',

  // 02_Finance_Legal
  'finance/banking': 'Banking',
  'finance/bills': 'Bills',
  'finance/taxes': 'Taxes',
  'finance/insurance': 'Insurance',
  'finance/purchases': 'Purchases',
  'finance/legal': 'Legal_Court',
  'finance/legal_court': 'Legal_Court',
  'finance/charitable-donations': 'Taxes',
  'finance/estate-planning': 'Estate_Planning',
  'finance/estate_planning': 'Estate_Planning',

  // 03_Vehicles
  'vehicles/general': 'Maintenance',
  'vehicles/maintenance': 'Maintenance',
  'vehicles/parts-orders': 'Maintenance',
  'vehicles/insurance': 'Insurance',
  'vehicles/registration': 'Maintenance',
  'vehicles/rental-cars': 'Maintenance',
  'vehicles/car-hunt': 'Car_Hunt',
  'vehicles/car_hunt': 'Car_Hunt',

  // 04_Family_Health
  'family/general': 'Family_General',
  'family/medical': 'Medical_Records',
  'family/medical-records': 'Medical_Records',
  'family/medical-student': 'Medical_Records',
  'family/health-general': 'Medical_Records',
  'family/school-student': 'Students',
  'family/school-charley': 'Students',
  'family/school-toby': 'Students',
  'family/school-tide': 'Students',
  'family/parents': 'Family_General',
  'family/personal-correspondence': 'Family_General',
  'family/kids/tide': 'Students',
  'family/kids/toby': 'Students',
  'family/kids/david': 'Students',
  'family/kids': 'Students',
  'family/kids/school-tide': 'Students',
  'family/kids/school-toby': 'Students',
  'family/kids/school': 'Students',
  'family/kids/tide-health': 'Medical_Records',
  'family/kids/toby-health': 'Medical_Records',
  'family/parents': 'Family_General',
  'family/sisters': 'Family_General',

  // 05_Tech_Infrastructure
  'tech/infrastructure': 'Hardware_Licenses',
  'tech/alerts-monitoring': 'NAS_Backups',
  'tech/backups': 'NAS_Backups',
  'tech/hardware': 'Hardware_Licenses',
  'tech/hardware-licenses': 'Hardware_Licenses',
  'tech/cloud-gcp': 'NAS_Backups',

  // 06_Work_Career
  'work/general': 'Career_Interviews',
  'work/career': 'Career_Interviews',
  'work/notes': 'Career_Interviews',
  'work/expenses': 'Expenses_Admin',
  'work/expenses-admin': 'Expenses_Admin',
  'work/architecture': 'Career_Interviews',

  // 07_Community_NonProfit
  'community/nonprofit': 'Community_BOD',
  'projects/charity': 'Community_BOD',
  'community/bod': 'Community_BOD',
  'projects/telemetry': 'Projects_Telemetry',
  'projects/beekeeping': 'Projects_Telemetry',
  'projects/hog': 'Community_BOD',
  'community/nonprofit-bod': 'Community_BOD',
  'community/charity': 'Community_BOD',
}

/**
 * Validates whether an email classification represents a canonical domain.
 * Non-canonical emails (promotions, newsletters, spam) return null/empty for canonicalDomain.
 *
 * @param {Object} classification - Gemini classification object
 * @param {Object} [config] - Classifier configuration
 * @returns {boolean} True if canonical domain, false if non-canonical or null
 */
function isCanonicalClassification(classification, config) {
  if (!classification || typeof classification !== 'object') return false
  const domain =
    classification.canonicalDomain || classification.canonical_label
  if (!domain || typeof domain !== 'string') return false
  const trimmed = domain.trim()
  if (trimmed === '' || trimmed === 'null' || trimmed === 'undefined')
    return false

  const allowedDomains = config?.canonicalDomains || [
    '01_Household',
    '02_Finance_Legal',
    '03_Vehicles',
    '04_Family_Health',
    '05_Tech_Infrastructure',
    '06_Work_Career',
    '07_Community_NonProfit',
  ]

  return allowedDomains.some(
    (d) => trimmed === d || trimmed.startsWith(d + '/')
  )
}

/**
 * Resolves the 2nd-level Google Drive taxonomy subfolder name given a canonical domain and sub-label.
 *
 * @param {string} canonicalDomain - e.g. "02_Finance_Legal"
 * @param {string} [subLabel] - e.g. "Finance/Banking" or "Bills"
 * @returns {string} Subfolder name
 */
function resolveTaxonomySubfolderName(canonicalDomain, subLabel) {
  if (subLabel && typeof subLabel === 'string') {
    const normalized = subLabel.trim().toLowerCase()
    if (SUBLABEL_TO_FOLDER_MAP[normalized]) {
      return SUBLABEL_TO_FOLDER_MAP[normalized]
    }

    if (
      normalized.startsWith('family/kids') ||
      normalized.startsWith('family/school')
    ) {
      if (normalized.includes('health') || normalized.includes('medical')) {
        return 'Medical_Records'
      }
      return 'Students'
    }
    if (
      normalized.startsWith('family/sisters') ||
      normalized.startsWith('family/parents')
    ) {
      return 'Family_General'
    }

    const parts = subLabel.split('/')
    const subPart = (parts.length > 1 ? parts[1] : parts[0]).trim()
    const sanitized = subPart.replace(/[-\s]+/g, '_')

    const knownSubfolders = CANONICAL_TAXONOMY_SUBFOLDERS[canonicalDomain] || []
    const match = knownSubfolders.find(
      (sf) => sf.toLowerCase() === sanitized.toLowerCase()
    )
    if (match) return match

    if (sanitized.length > 0) return sanitized
  }

  const defaults = {
    '01_Household': 'Primary_House',
    '02_Finance_Legal': 'Banking',
    '03_Vehicles': 'Maintenance',
    '04_Family_Health': 'Medical_Records',
    '05_Tech_Infrastructure': 'NAS_Backups',
    '06_Work_Career': 'Career_Interviews',
    '07_Community_NonProfit': 'Community_BOD',
  }
  return defaults[canonicalDomain] || 'General'
}

/**
 * Evaluates whether an email attachment is an eligible canonical document
 * and filters out inline images, email signatures, tracking pixels, and non-document artifacts.
 *
 * @param {Object} att - Attachment blob or mock object
 * @returns {{ eligible: boolean, reason: string }}
 */
function evaluateAttachmentEligibility(att) {
  if (!att) return { eligible: false, reason: 'NULL_OR_EMPTY' }
  const name =
    typeof att.getName === 'function' ? att.getName() : att.name || ''
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return { eligible: false, reason: 'MISSING_NAME' }
  }

  let size = 0
  if (typeof att.getSize === 'function') {
    size = att.getSize()
  } else if (typeof att.getBytes === 'function') {
    const bytes = att.getBytes()
    size = bytes ? bytes.length : 0
  } else if (att.bytes) {
    size = att.bytes.length
  } else if (att.size !== undefined) {
    size = att.size
  }

  // 1. Skip empty files or files exceeding GAS payload limit (30MB limit; cap at 25MB)
  if (size <= 0) {
    return { eligible: false, reason: 'ZERO_BYTE' }
  }
  if (size > 25 * 1024 * 1024) {
    return { eligible: false, reason: 'EXCEEDS_GAS_SIZE_LIMIT (>25MB)' }
  }

  const cleanName = name.trim()
  const dotIndex = cleanName.lastIndexOf('.')
  const ext = dotIndex > 0 ? cleanName.slice(dotIndex + 1).toLowerCase() : ''
  const stem = (
    dotIndex > 0 ? cleanName.slice(0, dotIndex) : cleanName
  ).toLowerCase()
  const mimeType = (
    typeof att.getContentType === 'function'
      ? att.getContentType()
      : att.contentType || ''
  ).toLowerCase()

  // 2. Unconditionally blocked non-document extensions
  const BLOCKED_EXTENSIONS = new Set([
    'ics',
    'ical',
    'ifb',
    'vcf',
    'vcard',
    'html',
    'htm',
    'css',
    'js',
    'mjs',
    'json',
    'xml',
    'rss',
    'p7s',
    'p7m',
    'p7c',
    'asc',
    'sig',
    'dat',
    'eml',
    'msg',
    'exe',
    'dmg',
    'pkg',
    'bin',
    'apk',
    'app',
    'sh',
    'bat',
    'cmd',
    'msi',
    'ttf',
    'woff',
    'woff2',
    'eot',
    'otf',
    'ico',
    'gif',
  ])

  if (BLOCKED_EXTENSIONS.has(ext)) {
    return { eligible: false, reason: 'BLOCKED_EXTENSION:.' + ext }
  }

  // 3. Block winmail.dat or mail artifacts without extension
  if (
    cleanName.toLowerCase() === 'winmail.dat' ||
    cleanName.toLowerCase() === 'smime.p7s'
  ) {
    return { eligible: false, reason: 'BLOCKED_MAIL_ARTIFACT' }
  }

  // 4. Canonical document types (Whitelisted)
  const DOCUMENT_EXTENSIONS = new Set([
    'pdf',
    'docx',
    'doc',
    'rtf',
    'odt',
    'pages',
    'xlsx',
    'xls',
    'csv',
    'tsv',
    'ods',
    'numbers',
    'pptx',
    'ppt',
    'key',
  ])

  if (DOCUMENT_EXTENSIONS.has(ext)) {
    return { eligible: true, reason: 'CANONICAL_DOCUMENT' }
  }

  // 5. Plain text files (.txt) - must be substantial and not boilerplate disclaimer
  if (ext === 'txt') {
    if (/^(disclaimer|signature|notice|footer|legal|terms)$/i.test(stem)) {
      return { eligible: false, reason: 'TEXT_BOILERPLATE_DISCLAIMER' }
    }
    return { eligible: true, reason: 'CANONICAL_TEXT_DOCUMENT' }
  }

  // 6. Archives (.zip)
  if (ext === 'zip') {
    return { eligible: true, reason: 'CANONICAL_ARCHIVE' }
  }

  // 7. Image files (.jpg, .jpeg, .png, .heic, .tiff, .tif, .webp)
  const IMAGE_EXTENSIONS = new Set([
    'jpg',
    'jpeg',
    'png',
    'heic',
    'tiff',
    'tif',
    'webp',
  ])

  const isImage = IMAGE_EXTENSIONS.has(ext) || mimeType.startsWith('image/')

  if (isImage) {
    // 7a. Stricter size threshold: genuine receipt/document photos are virtually always >= 35KB
    if (size < 35 * 1024) {
      return { eligible: false, reason: 'IMAGE_BELOW_SIZE_THRESHOLD (<35KB)' }
    }

    // 7b. Tracking, logo, signature stem blacklist
    const SIGNATURE_STEM_PATTERNS = [
      /logo/i,
      /sig(nature)?/i,
      /banner/i,
      /header/i,
      /footer/i,
      /avatar/i,
      /badge/i,
      /icon/i,
      /button/i,
      /social/i,
      /facebook/i,
      /twitter/i,
      /instagram/i,
      /linkedin/i,
      /youtube/i,
      /tiktok/i,
      /pinterest/i,
      /whatsapp/i,
      /spacer/i,
      /pixel/i,
      /tracking/i,
      /divider/i,
      /border/i,
      /bullet/i,
      /rating/i,
      /star/i,
      /thumbnail/i,
      /thumb/i,
      /outlook-[a-z0-9]+/i,
      /^image\d*$/i,
      /^unnamed/i,
      /^pasted/i,
      /^photo$/i,
      /^img$/i,
      /^attachment$/i,
    ]

    for (let i = 0; i < SIGNATURE_STEM_PATTERNS.length; i++) {
      if (SIGNATURE_STEM_PATTERNS[i].test(stem)) {
        return {
          eligible: false,
          reason:
            'SIGNATURE_OR_LOGO_PATTERN:' + SIGNATURE_STEM_PATTERNS[i].source,
        }
      }
    }

    return { eligible: true, reason: 'CANONICAL_IMAGE_SCAN' }
  }

  // Unknown or unsupported extension
  return { eligible: false, reason: 'UNKNOWN_OR_UNSUPPORTED_EXTENSION:.' + ext }
}

/**
 * Backward-compatible boolean evaluator.
 *
 * @param {Object} att - Attachment blob or mock object
 * @returns {boolean} True if eligible canonical document
 */
function isEligibleAttachment(att) {
  return evaluateAttachmentEligibility(att).eligible
}

/**
 * Retrieves attachments from a Gmail message, excluding inline images by default.
 *
 * @param {Object} msg - GmailMessage or mock
 * @returns {Array} Array of attachments
 */
function getMessageAttachments_(msg) {
  if (!msg) return []
  if (typeof msg.getAttachments === 'function') {
    try {
      return (
        msg.getAttachments({
          includeInlineImages: false,
          includeAttachments: true,
        }) || []
      )
    } catch {
      return msg.getAttachments() || []
    }
  }
  return msg.attachments || []
}

function getOrCreateChildFolder_(parentFolder, folderName) {
  const folders = parentFolder.getFoldersByName(folderName)
  if (folders && typeof folders.hasNext === 'function' && folders.hasNext()) {
    return folders.next()
  }
  return parentFolder.createFolder(folderName)
}

/**
 * Idempotently traverses or creates the 2-level Drive taxonomy path (Domain / Subfolder).
 *
 * @param {string} canonicalDomain - e.g. "02_Finance_Legal"
 * @param {string} subfolderName - e.g. "Banking"
 * @param {Object} driveApp - GAS DriveApp service (injected)
 * @returns {Object} Target folder object
 */
function ensureDriveTaxonomyFolder(canonicalDomain, subfolderName, driveApp) {
  let drive = driveApp
  if (typeof drive === 'undefined') {
    drive = typeof DriveApp !== 'undefined' ? DriveApp : null
  }
  if (!drive) {
    throw new Error('DriveApp service unavailable')
  }

  const root =
    typeof drive.getRootFolder === 'function' ? drive.getRootFolder() : drive

  if (!root || typeof root.getFoldersByName !== 'function') {
    throw new Error('DriveApp service unavailable or invalid root folder')
  }

  const domainFolder = getOrCreateChildFolder_(root, canonicalDomain)
  if (!subfolderName) return domainFolder

  return getOrCreateChildFolder_(domainFolder, subfolderName)
}

function extractBlobBytes_(blob) {
  try {
    if (typeof blob?.getBytes === 'function') {
      return blob.getBytes() || Buffer.from('')
    }
    if (blob?.bytes) {
      return blob.bytes
    }
    if (Buffer.isBuffer(blob)) {
      return blob
    }
  } catch {
    return Buffer.from('')
  }
  return Buffer.from('')
}

function extractFileSize_(file) {
  if (!file) return 0
  if (typeof file.getSize === 'function') {
    return file.getSize()
  }
  if (file.size !== undefined) {
    return file.size
  }
  return 0
}

/**
 * Checks if an exact duplicate file already exists in target folder (size match + MD5 hash).
 *
 * @param {Object} existingFiles - Iterator from folder.getFilesByName
 * @param {Object} newFileBlob - Blob of incoming file
 * @param {Object} [helperFns] - Optional helper functions ({ getFileHash })
 * @returns {boolean}
 */
function isDuplicateAttachment(existingFiles, newFileBlob, helperFns) {
  if (
    !existingFiles ||
    typeof existingFiles.hasNext !== 'function' ||
    !newFileBlob
  ) {
    return false
  }
  const hashFn = helperFns?.getFileHash || getFileHash
  const newFileBytes = extractBlobBytes_(newFileBlob)
  const newFileLength = newFileBytes.length
  let newFileHash = ''
  try {
    newFileHash = hashFn(newFileBlob)
  } catch {
    return false
  }

  while (existingFiles.hasNext()) {
    const existingFile = existingFiles.next()
    if (extractFileSize_(existingFile) !== newFileLength) {
      continue
    }

    const existingBlob =
      typeof existingFile.getBlob === 'function'
        ? existingFile.getBlob()
        : existingFile
    if (hashFn(existingBlob) === newFileHash) {
      return true
    }
  }
  return false
}

/**
 * Resolves naming conflicts for attachments. If a file of the same name exists
 * with different content, appends a timestamp before the extension.
 *
 * @param {Object} folder - Target Drive folder
 * @param {string} fileName - Attachment filename
 * @param {Object} newFileBlob - Blob being saved
 * @param {Object} [options] - Injected GAS services ({ Utilities, Session })
 * @returns {string} Safe filename
 */
function resolveAttachmentName(folder, fileName, newFileBlob, options) {
  if (
    folder &&
    typeof folder.getFilesByName === 'function' &&
    !folder.getFilesByName(fileName).hasNext()
  ) {
    return fileName
  }

  const utils =
    options?.Utilities || (typeof Utilities !== 'undefined' ? Utilities : null)
  const session =
    options?.Session || (typeof Session !== 'undefined' ? Session : null)

  let timeTag =
    utils &&
    session &&
    typeof utils.formatDate === 'function' &&
    typeof session.getScriptTimeZone === 'function'
      ? utils.formatDate(new Date(), session.getScriptTimeZone(), '_HHmmssSSS')
      : '_' + Date.now()

  if (typeof timeTag === 'string' && !timeTag.startsWith('_')) {
    timeTag = '_' + timeTag.replace(/[^a-zA-Z0-9]/g, '')
  }

  const renamed = fileName.replace(/(\.[\w-]+)$/i, timeTag + '$1')
  const finalName = renamed === fileName ? fileName + timeTag : renamed

  if (newFileBlob && typeof newFileBlob.setName === 'function') {
    newFileBlob.setName(finalName)
  }
  return finalName
}

/**
 * Persists attached documents from a canonical email thread to Google Drive along
 * the label's taxonomy path, skipping duplicates and strictly ignoring non-canonical emails.
 *
 * @param {Object} thread - Gmail thread object
 * @param {Object} classification - AI classification result
 * @param {Object} config - Classifier config
 * @param {Object} services - Injected GAS services ({ DriveApp, Utilities, Session })
 * @returns {Object[]} Array of saved file metadata ({ name, url, id, domain, subfolder })
 */
function persistCanonicalAttachmentsToDrive(
  thread,
  classification,
  config,
  services
) {
  // STRICT NON-CANONICAL GATE: If email has no canonical domain, ignore attachments completely!
  if (!isCanonicalClassification(classification, config)) {
    console.log(
      '[persistCanonicalAttachmentsToDrive] Non-canonical or null domain; skipping attachment persistence.'
    )
    return []
  }

  let driveApp = services?.DriveApp
  if (typeof driveApp === 'undefined') {
    driveApp = typeof DriveApp !== 'undefined' ? DriveApp : null
  }
  if (!driveApp) {
    console.error(
      '[persistCanonicalAttachmentsToDrive] DriveApp is unavailable; cannot persist attachments.'
    )
    return []
  }

  const canonicalDomain =
    classification.canonicalDomain || classification.canonical_label
  const subLabel = classification.subLabel || ''
  const subfolderName = resolveTaxonomySubfolderName(canonicalDomain, subLabel)

  let targetFolder
  try {
    targetFolder = ensureDriveTaxonomyFolder(
      canonicalDomain,
      subfolderName,
      driveApp
    )
  } catch (err) {
    console.error(
      '[persistCanonicalAttachmentsToDrive] Failed to ensure taxonomy folder ' +
        canonicalDomain +
        '/' +
        subfolderName +
        ': ' +
        err.message
    )
    return []
  }

  const messages =
    typeof thread.getMessages === 'function' ? thread.getMessages() : []
  const savedFiles = []
  const helperFns = {
    getFileHash: services?.getFileHash || getFileHash,
  }

  messages.forEach((msg) => {
    const attachments = getMessageAttachments_(msg)
    attachments.forEach((att) => {
      if (!isEligibleAttachment(att)) {
        console.log(
          '[persistCanonicalAttachmentsToDrive] Skipped ineligible attachment (signature/tracking pixel or empty): ' +
            (typeof att.getName === 'function' ? att.getName() : 'unnamed')
        )
        return
      }

      const fileName =
        typeof att.getName === 'function' ? att.getName() : att.name
      const newFileBlob =
        typeof att.copyBlob === 'function' ? att.copyBlob() : att
      const existingFiles =
        typeof targetFolder.getFilesByName === 'function'
          ? targetFolder.getFilesByName(fileName)
          : null

      if (isDuplicateAttachment(existingFiles, newFileBlob, helperFns)) {
        console.log(
          '[persistCanonicalAttachmentsToDrive] Skipped exact duplicate attachment: ' +
            fileName
        )
        return
      }

      const finalName = resolveAttachmentName(
        targetFolder,
        fileName,
        newFileBlob,
        services
      )
      console.log(
        '[persistCanonicalAttachmentsToDrive] Saving attachment to ' +
          canonicalDomain +
          '/' +
          subfolderName +
          ': ' +
          finalName
      )

      try {
        const file = targetFolder.createFile(newFileBlob)
        const fileId = typeof file.getId === 'function' ? file.getId() : ''
        const fileUrl =
          typeof file.getUrl === 'function'
            ? file.getUrl()
            : 'https://drive.google.com/file/d/' + fileId

        if (typeof file.setDescription === 'function') {
          try {
            const tagDate =
              services?.Utilities &&
              typeof services.Utilities.formatDate === 'function'
                ? services.Utilities.formatDate(
                    new Date(),
                    'GMT',
                    "yyyy-MM-dd'T'HH:mm:ss'Z'"
                  )
                : new Date().toISOString()
            const tagBlock =
              '[AI_INDEXED] ' +
              tagDate +
              '\nDomain: ' +
              canonicalDomain +
              '\nSub-label: ' +
              (classification.subLabel || '') +
              '\nSource: Gmail Attachment' +
              '\nThread-ID: ' +
              (typeof thread.getId === 'function'
                ? thread.getId()
                : thread.id || '')
            file.setDescription(tagBlock)
          } catch {
            // Non-blocking metadata description tagging
          }
        }

        savedFiles.push({
          name: typeof file.getName === 'function' ? file.getName() : finalName,
          url: fileUrl,
          id: fileId,
          domain: canonicalDomain,
          subfolder: subfolderName,
        })
      } catch (saveErr) {
        console.error(
          '[persistCanonicalAttachmentsToDrive] Error saving file ' +
            finalName +
            ': ' +
            saveErr.message
        )
      }
    })
  })

  return savedFiles
}

/**
 * Resolves the canonical domain (e.g. "01_Household") from thread labels.
 * Inspects both root domain identifiers and canonical sub-label prefixes.
 *
 * @param {string[]} rawLabels - Array of label names on the thread
 * @param {string[]} [canonicalDomains] - Optional list of canonical domain keys
 * @returns {string|null} Canonical domain key or null if non-canonical
 */
function resolveCanonicalDomainFromLabels(rawLabels, canonicalDomains) {
  if (!rawLabels || !Array.isArray(rawLabels)) return null
  const allowed = canonicalDomains || [
    '01_Household',
    '02_Finance_Legal',
    '03_Vehicles',
    '04_Family_Health',
    '05_Tech_Infrastructure',
    '06_Work_Career',
    '07_Community_NonProfit',
  ]
  // 1. Direct match on root domain codes (e.g. "01_Household")
  for (let i = 0; i < rawLabels.length; i++) {
    const l = rawLabels[i]
    if (allowed.includes(l) || /^0[1-7]_/.test(l)) {
      return l
    }
  }
  // 2. Canonical sub-label prefix mapping
  for (let j = 0; j < rawLabels.length; j++) {
    const lName = (rawLabels[j] || '').toLowerCase()
    if (lName.startsWith('household/')) return '01_Household'
    if (lName.startsWith('finance/')) return '02_Finance_Legal'
    if (lName.startsWith('vehicles/')) return '03_Vehicles'
    if (lName.startsWith('family/')) return '04_Family_Health'
    if (lName.startsWith('tech/')) return '05_Tech_Infrastructure'
    if (lName.startsWith('work/')) return '06_Work_Career'
    if (lName.startsWith('community/') || lName.startsWith('projects/'))
      return '07_Community_NonProfit'
  }
  return null
}

/**
 * Scans historical Gmail threads for attachments across the 7 Canonical Domains,
 * verifies whether each attachment exists in Google Drive under the correct taxonomy path,
 * checks/applies native [AI_INDEXED] description tags, and optionally backfills missing files.
 *
 * @param {Object} [options] - Execution options
 * @param {boolean} [options.dryRun=true] - If true, only reports discrepancies; if false, uploads missing attachments and tags them.
 * @param {string} [options.query] - Custom search query (defaults to searching canonical domain labels with attachments).
 * @param {number} [options.maxThreads=50] - Maximum threads to inspect in this batch.
 * @param {Object} [config] - Classifier configuration (defaults to getAiClassifierConfig()).
 * @param {Object} [services] - Service injection for testing ({ GmailApp, DriveApp, Utilities }).
 * @returns {Object} report
 */
function auditAndBackfillCanonicalAttachments(options, config, services) {
  const opts = options || {}
  const isDryRun = opts.dryRun !== false
  const maxThreads = opts.maxThreads || 50

  const cfg =
    config ||
    (typeof getAiClassifierConfig === 'function' ? getAiClassifierConfig() : {})
  const canonicalDomains = cfg.canonicalDomains || [
    '01_Household',
    '02_Finance_Legal',
    '03_Vehicles',
    '04_Family_Health',
    '05_Tech_Infrastructure',
    '06_Work_Career',
    '07_Community_NonProfit',
  ]

  const gmail =
    services?.GmailApp || (typeof GmailApp !== 'undefined' ? GmailApp : null)
  const drive =
    services?.DriveApp || (typeof DriveApp !== 'undefined' ? DriveApp : null)
  const utils =
    services?.Utilities || (typeof Utilities !== 'undefined' ? Utilities : null)

  if (!gmail || !drive) {
    throw new Error(
      'GmailApp and DriveApp services are required for attachment audit/backfill.'
    )
  }

  let searchQuery = opts.query || 'has:attachment'

  let threads = []
  if (typeof gmail.search === 'function') {
    threads = gmail.search(searchQuery, 0, maxThreads) || []
  }

  const report = {
    scannedThreads: threads.length,
    threadsWithEligibleAttachments: 0,
    totalAttachmentsInspected: 0,
    totalEligibleAttachments: 0,
    filteredGarbageCount: 0,
    eligibleByType: {},
    filteredByReason: {},
    alreadyStoredAndTagged: 0,
    alreadyStoredUntagged: 0,
    missingFromDrive: 0,
    backfilledCount: 0,
    taggedCount: 0,
    dryRun: isDryRun,
    items: [],
  }

  const startTime = Date.now()
  const timeBudgetMs = opts.timeBudgetMs || 270000
  const folderCache = {}

  for (let i = 0; i < threads.length; i++) {
    if (Date.now() - startTime > timeBudgetMs) {
      console.warn(
        '[auditAndBackfillCanonicalAttachments] Execution reached time budget safety ceiling; concluding batch cleanly.'
      )
      report.timeBudgetReached = true
      break
    }

    const thread = threads[i]
    if (!thread) continue
    const threadId =
      typeof thread.getId === 'function' ? thread.getId() : thread.id || ''
    const subject =
      typeof thread.getFirstMessageSubject === 'function'
        ? thread.getFirstMessageSubject()
        : thread.subject || ''

    let rawLabels = []
    if (typeof thread.getLabels === 'function') {
      const labelObjs = thread.getLabels() || []
      rawLabels = labelObjs.map((l) =>
        typeof l.getName === 'function' ? l.getName() : String(l)
      )
    } else if (Array.isArray(thread.labels)) {
      rawLabels = thread.labels
    }

    const canonicalDomain = resolveCanonicalDomainFromLabels(
      rawLabels,
      canonicalDomains
    )
    if (!canonicalDomain) continue

    const subLabel =
      rawLabels.find((l) => l.includes('/') && !l.includes(canonicalDomain)) ||
      rawLabels.find((l) => l.includes('/')) ||
      ''
    const subfolderName = resolveTaxonomySubfolderName(
      canonicalDomain,
      subLabel
    )

    const folderKey = `${canonicalDomain}::${subfolderName}`
    let targetFolder = folderCache[folderKey]
    if (!targetFolder) {
      try {
        targetFolder = ensureDriveTaxonomyFolder(
          canonicalDomain,
          subfolderName,
          drive
        )
        folderCache[folderKey] = targetFolder
      } catch (err) {
        console.error(
          '[auditAndBackfillCanonicalAttachments] Error accessing folder ' +
            canonicalDomain +
            '/' +
            subfolderName +
            ': ' +
            err.message
        )
        continue
      }
    }

    const msgs =
      typeof thread.getMessages === 'function'
        ? thread.getMessages()
        : thread.messages || []
    let threadHasEligible = false

    msgs.forEach((msg) => {
      const atts = getMessageAttachments_(msg)
      atts.forEach((att) => {
        report.totalAttachmentsInspected++
        const evalResult = evaluateAttachmentEligibility(att)
        if (!evalResult.eligible) {
          report.filteredGarbageCount++
          const reasonKey = evalResult.reason.split(':')[0]
          report.filteredByReason[reasonKey] =
            (report.filteredByReason[reasonKey] || 0) + 1
          return
        }

        threadHasEligible = true
        report.totalEligibleAttachments++
        const fileName =
          typeof att.getName === 'function'
            ? att.getName()
            : att.name || 'unnamed'
        const cleanName = fileName.trim()
        const dotIndex = cleanName.lastIndexOf('.')
        const ext =
          dotIndex > 0 ? cleanName.slice(dotIndex + 1).toLowerCase() : 'other'
        report.eligibleByType[ext] = (report.eligibleByType[ext] || 0) + 1

        let fileSize = extractFileSize_(att)
        if (!fileSize && typeof att.getBytes === 'function') {
          const b = att.getBytes()
          fileSize = b ? b.length : 0
        }
        const fileSizeKb = Math.round((fileSize / 1024) * 10) / 10
        const mimeType =
          typeof att.getContentType === 'function'
            ? att.getContentType()
            : att.contentType || ''

        const newFileBlob =
          typeof att.copyBlob === 'function' ? att.copyBlob() : att

        const existingFiles = targetFolder.getFilesByName(fileName)
        const helperFns = {
          getFileHash: getFileHash,
          Utilities: utils,
        }

        const isDup = isDuplicateAttachment(
          existingFiles,
          newFileBlob,
          helperFns
        )

        const tagDate =
          utils && typeof utils.formatDate === 'function'
            ? utils.formatDate(new Date(), 'GMT', "yyyy-MM-dd'T'HH:mm:ss'Z'")
            : new Date().toISOString()
        const tagBlock =
          '[AI_INDEXED] ' +
          tagDate +
          '\nDomain: ' +
          canonicalDomain +
          '\nSub-label: ' +
          subLabel +
          '\nSource: Gmail Attachment Backfill' +
          '\nThread-ID: ' +
          threadId +
          '\nEmail-Subject: ' +
          subject

        if (isDup) {
          const filesIterator = targetFolder.getFilesByName(fileName)
          const foundFile =
            filesIterator &&
            typeof filesIterator.next === 'function' &&
            filesIterator.hasNext()
              ? filesIterator.next()
              : null
          const desc =
            foundFile && typeof foundFile.getDescription === 'function'
              ? foundFile.getDescription()
              : ''

          if (desc && desc.includes('[AI_INDEXED]')) {
            report.alreadyStoredAndTagged++
            report.items.push({
              threadId: threadId,
              subject: subject,
              fileName: fileName,
              fileSizeKb: fileSizeKb,
              mimeType: mimeType,
              extension: ext,
              domain: canonicalDomain,
              subfolder: subfolderName,
              status: 'ALREADY_STORED_AND_TAGGED',
            })
          } else {
            report.alreadyStoredUntagged++
            if (
              !isDryRun &&
              foundFile &&
              typeof foundFile.setDescription === 'function'
            ) {
              try {
                foundFile.setDescription(tagBlock)
                report.taggedCount++
              } catch {
                // Non-blocking
              }
            }
            report.items.push({
              threadId: threadId,
              subject: subject,
              fileName: fileName,
              fileSizeKb: fileSizeKb,
              mimeType: mimeType,
              extension: ext,
              domain: canonicalDomain,
              subfolder: subfolderName,
              status: isDryRun ? 'STORED_BUT_UNTAGGED' : 'TAGGED_EXISTING',
            })
          }
        } else {
          report.missingFromDrive++
          if (!isDryRun) {
            try {
              const finalName = resolveAttachmentName(
                targetFolder,
                fileName,
                newFileBlob,
                services
              )
              const createdFile = targetFolder.createFile(newFileBlob)
              if (
                createdFile &&
                typeof createdFile.setDescription === 'function'
              ) {
                createdFile.setDescription(tagBlock)
              }
              report.backfilledCount++
              report.items.push({
                threadId: threadId,
                subject: subject,
                fileName: finalName,
                fileSizeKb: fileSizeKb,
                mimeType: mimeType,
                extension: ext,
                domain: canonicalDomain,
                subfolder: subfolderName,
                status: 'BACKFILLED_TO_DRIVE',
              })
            } catch (saveErr) {
              report.items.push({
                threadId: threadId,
                subject: subject,
                fileName: fileName,
                fileSizeKb: fileSizeKb,
                mimeType: mimeType,
                extension: ext,
                domain: canonicalDomain,
                subfolder: subfolderName,
                status: 'BACKFILL_ERROR',
                error: saveErr.message,
              })
            }
          } else {
            report.items.push({
              threadId: threadId,
              subject: subject,
              fileName: fileName,
              fileSizeKb: fileSizeKb,
              mimeType: mimeType,
              extension: ext,
              domain: canonicalDomain,
              subfolder: subfolderName,
              status: 'MISSING_FROM_DRIVE',
            })
          }
        }
      })
    })

    if (threadHasEligible) {
      report.threadsWithEligibleAttachments++
    }
  }

  return report
}

/**
 * Convenience runner for dry-run historical attachment audit.
 */
function runDryRunAttachmentAudit(options, config, services) {
  var opts = Object.assign({ dryRun: true, maxThreads: 50 }, options || {})
  var report = auditAndBackfillCanonicalAttachments(opts, config, services)

  console.log('===============================================================')
  console.log(' CANONICAL ATTACHMENT AUDIT MANIFEST (DRY RUN)')
  console.log('===============================================================')
  console.log(
    'Scanned Threads: ' +
      report.scannedThreads +
      ' | Total Attachments Inspected: ' +
      report.totalAttachmentsInspected +
      ' | Eligible: ' +
      report.totalEligibleAttachments +
      ' | Filtered Garbage: ' +
      report.filteredGarbageCount
  )
  console.log('---------------------------------------------------------------')
  console.log('ELIGIBLE ATTACHMENTS BY TYPE:')
  Object.keys(report.eligibleByType || {}).forEach(function (type) {
    console.log('  .' + type + ': ' + report.eligibleByType[type])
  })
  console.log('FILTERED GARBAGE BY REASON:')
  Object.keys(report.filteredByReason || {}).forEach(function (reason) {
    console.log('  ' + reason + ': ' + report.filteredByReason[reason])
  })
  console.log('---------------------------------------------------------------')
  console.log('CURATED FILES SCHEDULED FOR DRIVE STORAGE:')
  if (!report.items || report.items.length === 0) {
    console.log('  (None - zero files qualify for Drive storage)')
  } else {
    report.items.forEach(function (item, idx) {
      console.log(
        '  [' +
          (idx + 1) +
          '] [' +
          item.domain +
          '/' +
          item.subfolder +
          '] ' +
          item.fileName +
          ' (' +
          item.fileSizeKb +
          ' KB) - Subject: "' +
          item.subject +
          '"'
      )
    })
  }
  console.log('===============================================================')

  return report
}

/**
 * Convenience runner for live historical attachment backfill.
 */
function runLiveAttachmentBackfill(options, config, services) {
  var opts = Object.assign({ dryRun: false, maxThreads: 50 }, options || {})
  return auditAndBackfillCanonicalAttachments(opts, config, services)
}

/**
 * Reclassifies historical threads matching a custom Gmail search query.
 * Useful for retroactive alignment of misclassified or misattributed threads.
 *
 * @param {string} searchQuery - Gmail search query
 * @param {Object} [options] - Options: { maxThreads: 20, dryRun: false }
 * @param {Object} [config] - Classifier config
/**
 * Reclassifies historical threads matching a custom Gmail search query.
 * Useful for retroactive alignment of misclassified or misattributed threads.
 *
 * @param {string} searchQuery - Gmail search query
 * @param {Object} [options] - Options: { maxThreads: 20, dryRun: false }
 * @param {Object} [config] - Classifier config
 * @param {Object} [services] - Dependency injection for testing { GmailApp, Utilities, classifyFn }
 * @returns {Object} Report of reclassified threads
 */
function reclassifyThreadsByQuery(searchQuery, options, config, services) {
  var opts = Object.assign(
    { maxThreads: 20, dryRun: false, timeBudgetMs: 240000 },
    options || {}
  )
  var cfg =
    config ||
    (typeof getAiClassifierConfig === 'function' ? getAiClassifierConfig() : {})
  var gmail =
    (services && services.GmailApp) ||
    (typeof GmailApp !== 'undefined' ? GmailApp : null)
  var classifyFn =
    (services && services.classifyFn) ||
    (typeof classifyEmailWithGemini === 'function'
      ? classifyEmailWithGemini
      : null)

  if (!gmail) {
    throw new Error('GmailApp service is required for reclassifying threads.')
  }

  console.log(
    '[reclassifyThreadsByQuery] Query: ' +
      searchQuery +
      ' (dryRun: ' +
      opts.dryRun +
      ', maxThreads: ' +
      opts.maxThreads +
      ')'
  )

  var threads = gmail.search(searchQuery, 0, opts.maxThreads)
  console.log(
    '[reclassifyThreadsByQuery] Found ' +
      threads.length +
      ' thread(s) matching query.'
  )

  var results = []
  var startTime = Date.now()
  var timeBudgetMs = opts.timeBudgetMs || 240000

  for (var i = 0; i < threads.length; i++) {
    if (Date.now() - startTime > timeBudgetMs) {
      console.warn(
        '[reclassifyThreadsByQuery] Execution safety ceiling reached (' +
          Math.round((Date.now() - startTime) / 1000) +
          's); completing batch cleanly.'
      )
      break
    }

    var thread = threads[i]
    var msgs =
      typeof thread.getMessages === 'function' ? thread.getMessages() : []
    if (!msgs || msgs.length === 0) continue
    var firstMessage = msgs[0]
    var sender =
      typeof firstMessage.getFrom === 'function' ? firstMessage.getFrom() : ''
    var subject =
      typeof firstMessage.getSubject === 'function'
        ? firstMessage.getSubject()
        : ''
    var snippet =
      typeof firstMessage.getPlainBody === 'function'
        ? firstMessage.getPlainBody().substring(0, 500)
        : ''
    if (
      snippet.trim().length < 15 &&
      typeof firstMessage.getAttachments === 'function'
    ) {
      try {
        var atts = firstMessage.getAttachments() || []
        var attNames = atts
          .map(function (a) {
            return typeof a.getName === 'function' ? a.getName() : ''
          })
          .filter(Boolean)
        if (attNames.length > 0) {
          snippet =
            (snippet.trim() ? snippet.trim() + ' ' : '') +
            '[Attached: ' +
            attNames.join(', ') +
            ']'
        }
      } catch {
        // ignore attachment errors
      }
    }

    var rawLabels = []
    if (typeof thread.getLabels === 'function') {
      var labelObjs = thread.getLabels() || []
      rawLabels = labelObjs.map(function (l) {
        return typeof l.getName === 'function' ? l.getName() : String(l)
      })
    }

    var classification = null
    try {
      if (classifyFn) {
        classification = classifyFn(sender, subject, snippet, cfg)
      }
    } catch (e) {
      console.warn(
        '[reclassifyThreadsByQuery] Classifier exception: ' + e.message
      )
    }
    if (!classification) continue
    var oldCanonical = rawLabels.filter(function (l) {
      return (
        (cfg.canonicalDomains || []).indexOf(l) !== -1 || /^0[1-7]_/.test(l)
      )
    })
    var oldDomain = oldCanonical.length > 0 ? oldCanonical[0] : null
    var oldSubLabel =
      rawLabels.find(function (l) {
        return (
          l.indexOf('/') !== -1 &&
          (!oldDomain || l.indexOf(oldDomain) === -1) &&
          l.indexOf('Archives') === -1 &&
          l.indexOf('Retention/') === -1
        )
      }) || ''

    var newDomain =
      classification.canonicalDomain || classification.canonical_label
    var newSubLabel = classification.subLabel || ''
    var tldChanged = oldDomain && newDomain && oldDomain !== newDomain

    var attachmentsMoved = []
    var attachmentsSaved = []

    if (!opts.dryRun) {
      if (typeof cleanConflictingLabels === 'function') {
        cleanConflictingLabels(
          thread,
          classification.canonicalDomain,
          classification.subLabel,
          cfg
        )
      }
      var primaryTag = classification.subLabel
      if (!primaryTag || isRootDomainLabel(primaryTag)) {
        var domainKey =
          classification.canonicalDomain || classification.canonical_label
        primaryTag =
          (domainKey && DEFAULT_DOMAIN_SUBLABEL_MAP[domainKey]) ||
          domainKey ||
          null
        if (primaryTag && isRootDomainLabel(primaryTag)) {
          primaryTag = DEFAULT_DOMAIN_SUBLABEL_MAP[primaryTag] || null
        }
      }
      if (
        primaryTag &&
        typeof ensureGmailLabel === 'function' &&
        typeof thread.addLabel === 'function'
      ) {
        var targetLabel = ensureGmailLabel(primaryTag, gmail)
        thread.addLabel(targetLabel)
      }
      if (
        classification.category &&
        classification.category !== 'Primary' &&
        classification.action !== 'trash'
      ) {
        classification.action = 'archive'
      }
      if (
        classification.category &&
        classification.action !== 'trash' &&
        typeof setGmailCategoryTab === 'function'
      ) {
        setGmailCategoryTab(thread, classification.category)
      }
      if (
        classification.action === 'archive' &&
        typeof thread.moveToArchive === 'function'
      ) {
        thread.moveToArchive()
      }
      if (
        cfg.processedLabel &&
        typeof ensureGmailLabel === 'function' &&
        typeof thread.addLabel === 'function'
      ) {
        var processedLabel = ensureGmailLabel(cfg.processedLabel, gmail)
        thread.addLabel(processedLabel)
      }

      // Drive attachment relocation & backfill
      var drive =
        (services && services.DriveApp) ||
        (typeof DriveApp !== 'undefined' ? DriveApp : null)
      if (drive && isCanonicalClassification(classification, cfg)) {
        var oldSubfolder = oldDomain
          ? resolveTaxonomySubfolderName(oldDomain, oldSubLabel)
          : null
        var newSubfolder = resolveTaxonomySubfolderName(newDomain, newSubLabel)

        // Relocate existing attachments if folder path changed
        if (
          oldDomain &&
          oldSubfolder &&
          (oldDomain !== newDomain || oldSubfolder !== newSubfolder)
        ) {
          try {
            var oldFolder = ensureDriveTaxonomyFolder(
              oldDomain,
              oldSubfolder,
              drive
            )
            var newFolder = ensureDriveTaxonomyFolder(
              newDomain,
              newSubfolder,
              drive
            )

            msgs.forEach(function (msg) {
              var atts = getMessageAttachments_(msg)
              atts.forEach(function (att) {
                if (!isEligibleAttachment(att)) return
                var attName =
                  typeof att.getName === 'function' ? att.getName() : ''
                if (!attName) return

                var existingFiles = oldFolder.getFilesByName(attName)
                if (
                  existingFiles &&
                  typeof existingFiles.hasNext === 'function' &&
                  existingFiles.hasNext()
                ) {
                  var fileToMove = existingFiles.next()
                  if (typeof fileToMove.moveTo === 'function') {
                    fileToMove.moveTo(newFolder)
                    attachmentsMoved.push({
                      name: attName,
                      from: oldDomain + '/' + oldSubfolder,
                      to: newDomain + '/' + newSubfolder,
                    })
                    console.log(
                      '[reclassifyThreadsByQuery] Relocated attachment "' +
                        attName +
                        '" from ' +
                        oldDomain +
                        '/' +
                        oldSubfolder +
                        ' to ' +
                        newDomain +
                        '/' +
                        newSubfolder
                    )
                  }
                }
              })
            })
          } catch (e) {
            console.warn(
              '[reclassifyThreadsByQuery] Drive relocation warning: ' +
                e.message
            )
          }
        }

        // Persist any eligible attachments not yet preserved
        var saved = persistCanonicalAttachmentsToDrive(
          thread,
          classification,
          cfg,
          {
            DriveApp: drive,
            Utilities:
              services && services.Utilities ? services.Utilities : Utilities,
          }
        )
        if (saved && saved.length > 0) {
          attachmentsSaved = saved
        }
      }
    }

    var labelChanged = oldDomain !== newDomain || oldSubLabel !== newSubLabel
    var summary = {
      threadId: typeof thread.getId === 'function' ? thread.getId() : String(i),
      subject: subject,
      sender: sender,
      oldDomain: oldDomain,
      oldSubLabel: oldSubLabel,
      newDomain: newDomain,
      newSubLabel: newSubLabel,
      labelChanged: labelChanged,
      tldChanged: !!tldChanged,
      action: classification.action,
      category: classification.category,
      attachmentsMoved: attachmentsMoved,
      attachmentsSaved: attachmentsSaved,
    }

    results.push(summary)
  }

  if (opts.dryRun) {
    console.log(
      '==============================================================='
    )
    console.log(
      '             HISTORICAL REALIGNMENT AUDIT (DRY RUN)            '
    )
    console.log(
      '==============================================================='
    )
    console.log('Query: ' + searchQuery)
    console.log('Scanned: ' + threads.length + ' thread(s)')
    console.log('Audited: ' + results.length)
    results.forEach(function (item, idx) {
      console.log(
        '  [' +
          (idx + 1) +
          '] Thread: ' +
          item.threadId +
          ' | Subject: "' +
          item.subject +
          '"'
      )
      console.log(
        '      Old: ' +
          (item.oldSubLabel || item.oldDomain || '(none)') +
          ' -> New: ' +
          (item.newSubLabel || item.newDomain) +
          (item.labelChanged ? ' [CHANGES]' : ' [MATCHES]')
      )
      console.log(
        '      TLD Changed: ' +
          item.tldChanged +
          ' | Action: ' +
          item.action +
          ' | Category: ' +
          item.category
      )
      if (item.attachmentsMoved && item.attachmentsMoved.length > 0) {
        console.log(
          '      Attachments to move: ' + JSON.stringify(item.attachmentsMoved)
        )
      }
    })
    console.log(
      '==============================================================='
    )
  }

  return {
    query: searchQuery,
    scanned: threads.length,
    reclassified: results.length,
    dryRun: opts.dryRun,
    items: results,
  }
}

/**
 * Convenience runner to audit historical threads matching a query in dry-run mode.
 */
function runRealignmentAudit(query, options, config, services) {
  var gmail =
    (services && services.GmailApp) ||
    (typeof GmailApp !== 'undefined' ? GmailApp : null)
  var searchQuery = query

  if (!searchQuery && gmail && typeof gmail.getUserLabels === 'function') {
    try {
      var allLabels = gmail.getUserLabels() || []
      var matchedLabels = allLabels
        .filter(function (l) {
          var name = typeof l.getName === 'function' ? l.getName() : String(l)
          return /sister/i.test(name)
        })
        .map(function (l) {
          var name = typeof l.getName === 'function' ? l.getName() : String(l)
          return 'label:"' + name + '"'
        })

      console.log(
        '[runRealignmentAudit] Discovered sister labels in Gmail: ' +
          JSON.stringify(matchedLabels)
      )

      var queryParts = matchedLabels.slice()
      queryParts.push('"name change"')
      searchQuery = queryParts.join(' OR ')
    } catch (e) {
      console.warn(
        '[runRealignmentAudit] Error discovering user labels: ' + e.message
      )
    }
  }

  if (!searchQuery) {
    searchQuery = 'label:"Family/Sisters" OR "name change"'
  }

  return reclassifyThreadsByQuery(
    searchQuery,
    Object.assign({ maxThreads: 25, dryRun: true }, options || {}),
    config,
    services
  )
}

/**
 * Sweeps and reclassifies current unread items in the inbox against the
 * Category-Driven Retention Invariant, archiving all non-Primary streams.
 *
 * @param {Object} [options] - Reclassification options (maxThreads, dryRun, timeBudgetMs)
 * @param {Object} [customConfig] - Optional override config
 * @param {Object} [customServices] - Optional injected services
 * @returns {Object} Realignment summary report
 */
function sweepAllUnreadInboxEmails(options, customConfig, customServices) {
  var opts = Object.assign({ maxThreads: 50, dryRun: false }, options || {})
  return reclassifyThreadsByQuery(
    'in:inbox is:unread',
    opts,
    customConfig,
    customServices
  )
}

/**
 * Checks if a thread contains any messages sent or replied by the account owner.
 */
function isThreadSentOrRepliedByUser(thread, userEmail) {
  try {
    var primaryEmail = (userEmail || '').toLowerCase()
    if (!primaryEmail) {
      return false
    }
    var messages = thread.getMessages()
    for (var m = 0; m < messages.length; m++) {
      var fromAddr = messages[m].getFrom().toLowerCase()
      if (fromAddr.indexOf(primaryEmail) !== -1) {
        return true
      }
    }
  } catch (e) {
    console.warn(
      '[isThreadSentOrRepliedByUser] Error checking message senders:',
      e.message
    )
  }
  return false
}

var DESTRUCTIVE_CONFIDENCE_MIN = 0.85

function isDestructiveActionAllowed_(classification) {
  if (!classification || typeof classification !== 'object') {
    return false
  }
  if (
    classification.action !== 'trash' &&
    classification.action !== 'archive'
  ) {
    return false
  }
  var confidence = classification.confidence
  if (!Number.isFinite(confidence)) {
    return false
  }
  return confidence >= DESTRUCTIVE_CONFIDENCE_MIN
}

var GMAIL_AI_CLASSIFIER_VERSION = 'v1.8.0-drive-taxonomy-attachments'

/**
 * Main entry point for Gemini AI-Powered Semantic Email Classification and Auto-Filter Engine.
 * Supports injected config and services for testing and headless execution.
 *
 * @param {Object} [customConfig] - Optional override config
 * @param {Object} [customServices] - Optional injected services
 */
function processEmailsWithAiClassifier(customConfig, customServices) {
  var services = customServices || {}
  var lockService =
    services.LockService ||
    (typeof LockService !== 'undefined' ? LockService : null)
  var lock = null
  if (lockService && typeof lockService.getScriptLock === 'function') {
    lock = lockService.getScriptLock()
    var hasLock = false
    try {
      hasLock = lock.tryLock(10000)
    } catch (e) {
      console.warn(
        '[processEmailsWithAiClassifier] Error attempting script lock:',
        e.message
      )
    }
    if (!hasLock) {
      console.warn(
        '[processEmailsWithAiClassifier] Could not obtain script lock after 10s. Another execution is in progress. Exiting.'
      )
      return
    }
  }

  try {
    console.log(
      '[processEmailsWithAiClassifier] Engine Version: ' +
        GMAIL_AI_CLASSIFIER_VERSION
    )
    console.log(
      '[processEmailsWithAiClassifier] Starting AI semantic email processing...'
    )
    var config =
      customConfig ||
      (typeof getAiClassifierConfig === 'function'
        ? getAiClassifierConfig()
        : {})

    if (!config.geminiApiKey) {
      console.error(
        '[processEmailsWithAiClassifier] GEMINI_API_KEY ScriptProperty is missing.'
      )
      return
    }

    var gmail =
      services.GmailApp || (typeof GmailApp !== 'undefined' ? GmailApp : null)
    if (!gmail) {
      console.error(
        '[processEmailsWithAiClassifier] GmailApp service is missing.'
      )
      return
    }

    var threads = gmail.search(config.unprocessedQuery, 0, 10)
    console.log(
      '[processEmailsWithAiClassifier] Found ' +
        threads.length +
        ' unprocessed thread(s).'
    )

    if (threads.length === 0) {
      // Secondary sweep: Look for any unread non-primary inbox threads to realign
      var sweepQuery = 'in:inbox is:unread -category:primary -label:Processed'
      threads = gmail.search(sweepQuery, 0, 10)
      console.log(
        '[processEmailsWithAiClassifier] Secondary sweep found ' +
          threads.length +
          ' unread non-primary thread(s) in inbox.'
      )
      if (threads.length === 0) {
        return
      }
    }

    var processedLabel = ensureGmailLabel(
      config.processedLabel,
      gmail,
      services.Gmail
    )

    for (var i = 0; i < threads.length; i++) {
      var thread = threads[i]
      var firstMessage = thread.getMessages()[0]
      var sender = firstMessage.getFrom()
      var subject = firstMessage.getSubject()
      var snippet = firstMessage.getPlainBody().substring(0, 500)
      if (
        snippet.trim().length < 15 &&
        typeof firstMessage.getAttachments === 'function'
      ) {
        try {
          var atts = firstMessage.getAttachments() || []
          var attNames = atts
            .map(function (a) {
              return typeof a.getName === 'function' ? a.getName() : ''
            })
            .filter(Boolean)
          if (attNames.length > 0) {
            snippet =
              (snippet.trim() ? snippet.trim() + ' ' : '') +
              '[Attached: ' +
              attNames.join(', ') +
              ']'
          }
        } catch (attErr) {
          // ignore attachment errors
        }
      }

      console.log(
        '[processEmailsWithAiClassifier] Processing (' +
          (i + 1) +
          '/' +
          threads.length +
          '): ' +
          subject +
          ' from ' +
          sender
      )

      var classification = deterministicRuleClassify_(
        sender,
        subject,
        snippet,
        thread,
        config
      )
      if (!classification) {
        var classifyFn =
          services.classifyFn ||
          (typeof classifyEmailWithGemini === 'function'
            ? function (s, sub, sn, cfg) {
                return classifyEmailWithGemini(
                  cfg,
                  s,
                  sub,
                  sn,
                  services.UrlFetchApp
                )
              }
            : null)
        if (classifyFn) {
          classification = classifyFn(sender, subject, snippet, config)
        }
      }
      if (classification) {
        cleanConflictingLabels(
          thread,
          classification.canonicalDomain,
          classification.subLabel,
          config
        )

        var primaryTag = classification.subLabel
        if (!primaryTag || isRootDomainLabel(primaryTag)) {
          var domainKey =
            classification.canonicalDomain || classification.canonical_label
          primaryTag =
            (domainKey && DEFAULT_DOMAIN_SUBLABEL_MAP[domainKey]) ||
            domainKey ||
            null
          if (primaryTag && isRootDomainLabel(primaryTag)) {
            primaryTag = DEFAULT_DOMAIN_SUBLABEL_MAP[primaryTag] || null
          }
        }
        if (primaryTag) {
          var targetLabel = ensureGmailLabel(primaryTag, gmail, services.Gmail)
          if (targetLabel) {
            thread.addLabel(targetLabel)
          }

          var savedAttachments = persistCanonicalAttachmentsToDrive(
            thread,
            classification,
            config,
            services
          )

          if (config.githubToken) {
            var notePath = getNotePathForDomain(
              classification.canonicalDomain,
              classification.subLabel
            )
            if (notePath && services.Utilities) {
              var dateStr = services.Utilities.formatDate(
                firstMessage.getDate(),
                'GMT',
                'yyyy-MM-dd'
              )
              var entryMd = formatProgressiveDisclosureEntry(
                dateStr,
                classification.title || subject,
                sender,
                subject,
                classification.summary,
                config.userAccountEmail,
                savedAttachments
              )
              assertNoAsciiReplacement_(
                (subject || '') + (classification.summary || ''),
                entryMd
              )
              assertClean_(entryMd, 'new entry for ' + notePath)
              appendMarkdownEntryToGitHubRepo(
                notePath,
                entryMd,
                'feat(ingestion): ' + subject
              )
            }
          }
        }

        if (
          classification.category &&
          classification.category !== 'Primary' &&
          classification.action !== 'trash'
        ) {
          classification.action = 'archive'
        }

        var userSent = isThreadSentOrRepliedByUser(
          thread,
          config.userAccountEmail
        )
        var requestedDestructive =
          classification.action === 'trash' ||
          classification.action === 'archive'
        var destructiveOk = isDestructiveActionAllowed_(classification)
        if (userSent && requestedDestructive) {
          console.log(
            '[processEmailsWithAiClassifier] Shield: Preserved thread in INBOX because user sent/replied to it.'
          )
        } else if (requestedDestructive && !destructiveOk) {
          console.warn(
            '[processEmailsWithAiClassifier] Shield: Skipped destructive action "' +
              classification.action +
              '" (low/invalid confidence ' +
              classification.confidence +
              '); preserved thread in INBOX.'
          )
        } else if (requestedDestructive) {
          if (classification.action === 'trash') {
            thread.moveToTrash()
            console.log(
              '[processEmailsWithAiClassifier] Action: Moved spam/unwanted thread to TRASH.'
            )
          } else {
            thread.moveToArchive()
            console.log(
              '[processEmailsWithAiClassifier] Action: Archived thread out of INBOX.'
            )
          }
        }

        if (classification.action === 'mark_read' || classification.markRead) {
          thread.markRead()
          console.log(
            '[processEmailsWithAiClassifier] Action: Marked thread as READ.'
          )
        }

        if (classification.category && classification.action !== 'trash') {
          setGmailCategoryTab(thread, classification.category, services.Gmail)
        }

        if (processedLabel) {
          thread.addLabel(processedLabel)
        }
      } else {
        console.warn(
          '[processEmailsWithAiClassifier] Classification failed or returned null; preserving thread unprocessed for retry.'
        )
      }

      var utilsService =
        services.Utilities ||
        (typeof Utilities !== 'undefined' ? Utilities : null)
      if (utilsService && typeof utilsService.sleep === 'function') {
        utilsService.sleep(2000)
      }
    }

    console.log('[processEmailsWithAiClassifier] Batch processing complete.')
  } finally {
    if (lock) {
      try {
        lock.releaseLock()
      } catch (e) {
        // ignore lock release error
      }
    }
  }
}

module.exports = {
  processEmailsWithAiClassifier,
  validateClassification,
  classifyEmailWithGemini,
  buildOntologicalPrompt,
  ensureGmailLabel,
  createPermanentGmailFilter,
  processThreadBatch,
  RULE6_PATTERNS,
  assertClean_,
  assertNoAsciiReplacement_,
  extractTopicTitleFromPath,
  insertEntryIntoLogSection,
  formatProgressiveDisclosureEntry,
  getNotePathForDomain,
  appendMarkdownEntryToGitHubRepo,
  executeGitHubCommit,
  getSearchDateRange_,
  auditClassifications,
  formatAuditDigest,
  isCanonicalClassification,
  resolveTaxonomySubfolderName,
  evaluateAttachmentEligibility,
  isEligibleAttachment,
  getMessageAttachments_,
  ensureDriveTaxonomyFolder,
  isDuplicateAttachment,
  resolveAttachmentName,
  persistCanonicalAttachmentsToDrive,
  auditAndBackfillCanonicalAttachments,
  runDryRunAttachmentAudit,
  runLiveAttachmentBackfill,
  setGmailCategoryTab,
  cleanConflictingLabels,
  reclassifyThreadsByQuery,
  runRealignmentAudit,
  sweepAllUnreadInboxEmails,
  CANONICAL_TAXONOMY_SUBFOLDERS,
  SUBLABEL_TO_FOLDER_MAP,
  DEFAULT_DOMAIN_SUBLABEL_MAP,
  isRootDomainLabel,
  resolveCanonicalDomainFromLabels,
  deterministicRuleClassify_,
}
