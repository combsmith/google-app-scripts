/**
 * Gmail AI Classifier & Filing Agent
 *
 * Uses Gemini API to classify incoming emails into taxonomy labels,
 * saves canonical attachments to Google Drive, and applies retention policies.
 */

function getFileHash(blob) {
  if (!blob) return ''
  try {
    let bytes = blob
    if (typeof blob === 'object' && typeof blob.getBytes === 'function') {
      bytes = blob.getBytes()
    }
    if (!bytes) return ''
    const util =
      typeof Utilities !== 'undefined' && Utilities
        ? Utilities
        : typeof globalThis !== 'undefined' && globalThis.Utilities
          ? globalThis.Utilities
          : null
    if (util && typeof util.computeDigest === 'function') {
      const rawDigest = util.computeDigest(util.DigestAlgorithm.MD5, bytes)
      return rawDigest
        .map((b) => {
          const v = b < 0 ? b + 256 : b
          return v.toString(16).padStart(2, '0')
        })
        .join('')
    }
    return ''
  } catch {
    return ''
  }
}

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

const VALID_ONTOLOGICAL_CATEGORIES_ = [
  'Primary',
  'Updates',
  'Promotions',
  'Social',
  'Forums',
]
const VALID_ONTOLOGICAL_ACTIONS_ = ['keep', 'archive', 'trash', 'mark_read']

/**
 * Validates an ontological classification response object returned by classifyWithGemini.
 *
 * @param {Object} classification - Parsed response from Gemini
 * @param {string[]} [canonicalDomains] - Allowed canonical domain keys
 * @returns {boolean}
 */
function validateOntologicalClassification(classification, canonicalDomains) {
  if (
    !classification ||
    typeof classification !== 'object' ||
    Array.isArray(classification)
  ) {
    return false
  }
  if (
    typeof classification.confidence === 'number' &&
    (!Number.isFinite(classification.confidence) ||
      classification.confidence < 0 ||
      classification.confidence > 1)
  ) {
    return false
  }
  if (
    classification.confidence !== undefined &&
    typeof classification.confidence !== 'number'
  ) {
    return false
  }
  var domain = classification.canonicalDomain
  if (domain !== null && domain !== undefined && domain !== '') {
    if (typeof domain !== 'string') return false
    if (
      Array.isArray(canonicalDomains) &&
      canonicalDomains.length > 0 &&
      canonicalDomains.indexOf(domain) === -1
    ) {
      return false
    }
  }
  if (
    classification.category !== undefined &&
    classification.category !== null &&
    VALID_ONTOLOGICAL_CATEGORIES_.indexOf(classification.category) === -1
  ) {
    return false
  }
  if (
    classification.action !== undefined &&
    classification.action !== null &&
    VALID_ONTOLOGICAL_ACTIONS_.indexOf(classification.action) === -1
  ) {
    return false
  }
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
    '• Community/beehive telemetry (BroodMinder monitors, "Events in your apiaries", hive alerts) -> "07_Community_NonProfit", sub-label "Projects/Telemetry" or "Projects/Beekeeping".\n' +
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
    '3. Completed_Transaction (Confirmed scheduled auto-payments, delivered packages, successful SSO/sign-ins, routine lunch menu digests, bank transfers, automated machine/sensor telemetry [BroodMinder, apiary events, HoneyBeeham], device/server pings):\n' +
    "   -> category: 'Updates', action: 'archive'\n" +
    '4. Broadcast_Marketing (Commercial promos, retail discounts, vendor newsletters, terms of service and privacy policy updates):\n' +
    "   -> category: 'Promotions', action: 'archive'\n" +
    '5. Spam_Solicitation (Phishing, scam attempts, cold wholesaler pitches):\n' +
    "   -> category: 'Promotions', action: 'trash'\n\n" +
    'CATEGORY-DRIVEN INBOX RETENTION INVARIANT & PRIMARY INBOX PURITY RULE (ACTION-FIRST INBOX):\n' +
    '• Primary Inbox is an Action Queue: Only emails categorized as "Primary" belong in the Primary Inbox (action: "keep").\n' +
    '• Emails that do not require prompt, personalized human action (such as automated newsletters, order receipts, shipping updates, travel confirmations, account alerts, credit scores, smart reorders, school bulletins, marketing promos, and social pings) MUST NOT stay in Primary (they must be categorized as "Updates", "Promotions", or "Social" with action: "archive"). Reserve category: "Primary" and action: "keep" ONLY for authentic human-to-human correspondence, critical urgent action items, or manual bills needing immediate human review.\n' +
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

function computeStringHash(str, services) {
  if (!str) return ''
  try {
    var utils =
      (services && services.Utilities) ||
      (typeof Utilities !== 'undefined' ? Utilities : null)
    if (utils && typeof utils.computeDigest === 'function') {
      var algo = (utils.DigestAlgorithm && utils.DigestAlgorithm.MD5) || 'MD5'
      var digest = utils.computeDigest(algo, str)
      return digest
        .map(function (b) {
          return ('0' + (b & 0xff).toString(16)).slice(-2)
        })
        .join('')
    }
  } catch {
    // Non-blocking fallback
  }
  var hash = 0
  for (var i = 0; i < str.length; i++) {
    hash = Math.trunc((hash << 5) - hash + str.charCodeAt(i))
  }
  return 'h_' + Math.abs(hash).toString(16)
}

function classifyWithGemini(sender, subject, snippet, config, services) {
  var urlFetch =
    (services && services.UrlFetchApp) ||
    (typeof UrlFetchApp !== 'undefined' ? UrlFetchApp : null)
  var sleepFn =
    (services && services.sleepFn) ||
    (services && services.Utilities && services.Utilities.sleep) ||
    (typeof Utilities !== 'undefined' && Utilities && Utilities.sleep
      ? Utilities.sleep
      : function () {})
  var cache =
    (services && services.CacheService) ||
    (typeof CacheService !== 'undefined' &&
    CacheService &&
    CacheService.getScriptCache
      ? CacheService.getScriptCache()
      : null)
  var props =
    (services &&
    services.PropertiesService &&
    typeof services.PropertiesService.getScriptProperties === 'function'
      ? services.PropertiesService.getScriptProperties()
      : null) ||
    (services && services.properties) ||
    (typeof PropertiesService !== 'undefined' &&
    typeof PropertiesService.getScriptProperties === 'function'
      ? PropertiesService.getScriptProperties()
      : null)

  var canonicalDomains = config && config.canonicalDomains

  // 1. Check classification cache
  var cacheKey = null
  if (cache) {
    var rawKey = (sender || '') + '|' + (subject || '') + '|' + (snippet || '')
    var hashed = computeStringHash(rawKey, services)
    if (hashed) {
      cacheKey = 'cls_' + hashed
      try {
        var cachedJson = cache.get(cacheKey)
        if (cachedJson) {
          var cachedResult = JSON.parse(cachedJson)
          if (
            validateOntologicalClassification(cachedResult, canonicalDomains)
          ) {
            console.log('[classifyWithGemini] Cache hit for: ' + subject)
            return cachedResult
          }
        }
      } catch {
        // Cache read is non-blocking
      }
    }
  }

  // 2. Check circuit breaker before hitting remote endpoints
  if (isCircuitBreakerOpen(props)) {
    console.warn(
      '[classifyWithGemini] Circuit breaker is open. Skipping remote API call.'
    )
    return null
  }

  var prompt = buildOntologicalPrompt(config, sender, subject, snippet)

  var payload = {
    contents: [
      {
        parts: [{ text: prompt }],
      },
    ],
    generationConfig: { response_mime_type: 'application/json' },
  }

  // Cascading Gemini Model Matrix (Production GA models preferred)
  var endpoints = []
  if (config && config.modelEndpoint) {
    endpoints.push(config.modelEndpoint)
  }
  var fallbackModels = [
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent',
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent',
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent',
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent',
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-pro-latest:generateContent',
  ]
  for (var f = 0; f < fallbackModels.length; f++) {
    if (endpoints.indexOf(fallbackModels[f]) === -1) {
      endpoints.push(fallbackModels[f])
    }
  }

  if (!urlFetch) {
    console.error('[classifyWithGemini] UrlFetchApp service is not available.')
    return null
  }

  var maxRetryDelayMs = null

  for (var e = 0; e < endpoints.length; e++) {
    var url = endpoints[e]
    var options = {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'x-goog-api-key': (config && config.geminiApiKey) || '',
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    }

    try {
      var response = urlFetch.fetch(url, options)
      var statusCode = response.getResponseCode()
      var jsonText = response.getContentText()

      if (statusCode === 200) {
        var resData = JSON.parse(jsonText)
        if (
          resData.candidates &&
          resData.candidates[0] &&
          resData.candidates[0].content &&
          resData.candidates[0].content.parts &&
          resData.candidates[0].content.parts[0]
        ) {
          var textOutput = resData.candidates[0].content.parts[0].text
          var parsedObj = extractJsonSubstring(textOutput)
          if (
            parsedObj &&
            validateOntologicalClassification(parsedObj, canonicalDomains)
          ) {
            console.log(
              '[classifyWithGemini] Success using endpoint: ' + endpoints[e]
            )
            if (props) {
              recordCircuitBreakerSuccess(props)
            }
            if (cache && cacheKey) {
              try {
                cache.put(cacheKey, JSON.stringify(parsedObj), 21600)
              } catch {
                // Cache write is non-blocking
              }
            }
            return parsedObj
          }
          console.warn(
            '[classifyWithGemini] Invalid ontological response schema from endpoint: ' +
              endpoints[e]
          )
        }
      } else if (statusCode === 429) {
        var delayMs = parseRetryDelayMs(response)
        if (maxRetryDelayMs === null || delayMs > maxRetryDelayMs) {
          maxRetryDelayMs = delayMs
        }
        console.warn(
          '[classifyWithGemini] Endpoint ' +
            endpoints[e] +
            ' HTTP 429 Rate Limit. Honoring Retry-After / retryDelay: sleeping ' +
            delayMs / 1000 +
            's before fallback...'
        )
        sleepFn(delayMs)
      } else {
        console.warn(
          '[classifyWithGemini] Endpoint ' +
            endpoints[e] +
            ' HTTP ' +
            statusCode +
            ': ' +
            jsonText
        )
      }
    } catch (err) {
      console.warn(
        '[classifyWithGemini] Exception on endpoint ' +
          endpoints[e] +
          ': ' +
          err.message
      )
      if (
        err.message &&
        err.message.indexOf('Service invoked too many times') !== -1
      ) {
        console.error(
          '[classifyWithGemini] UrlFetchApp daily quota exhausted. Halting remote API calls.'
        )
        break
      }
    }
  }

  console.error(
    '[classifyWithGemini] All model endpoints failed or rate-limited.'
  )
  if (props) {
    recordCircuitBreakerFailure(props, maxRetryDelayMs)
  }
  return null
}

function extractJsonSubstring(text) {
  if (!text) return null
  text = text
    .replace(/```json/gi, '')
    .replace(/```/gi, '')
    .trim()

  var start = text.indexOf('{')
  var end = text.lastIndexOf('}')
  if (start !== -1 && end !== -1 && end > start) {
    var rawJson = text.substring(start, end + 1)
    try {
      return JSON.parse(rawJson)
    } catch {
      try {
        var cleaned = rawJson.replace(/,\s*([\]}])/g, '$1')
        return JSON.parse(cleaned)
      } catch (e2) {
        console.warn(
          '[extractJsonSubstring] JSON parse error on raw substring:',
          e2.message
        )
      }
    }
  }
  return null
}

function parseRetryDelayMs(response) {
  try {
    var headers =
      (response && typeof response.getHeaders === 'function'
        ? response.getHeaders()
        : null) || {}
    var retryHeader = headers['Retry-After'] || headers['retry-after']
    if (retryHeader) {
      var seconds = Number.parseInt(retryHeader, 10)
      if (!Number.isNaN(seconds) && seconds > 0) {
        return Math.min(seconds * 1000, 30000)
      }
    }

    var jsonText =
      (response && typeof response.getContentText === 'function'
        ? response.getContentText()
        : null) || ''
    if (jsonText) {
      var resData = JSON.parse(jsonText)
      if (resData.error && resData.error.details) {
        for (var i = 0; i < resData.error.details.length; i++) {
          var detail = resData.error.details[i]
          if (detail.retryDelay) {
            var secStr = detail.retryDelay.replace('s', '')
            var sec = Number.parseFloat(secStr)
            if (!Number.isNaN(sec) && sec > 0) {
              return Math.min(Math.ceil(sec * 1000), 30000)
            }
          }
        }
      }
    }
  } catch (e) {
    console.warn('[parseRetryDelayMs] Failed to parse retry delay:', e.message)
  }
  return 5000
}

/**
 * Cross-execution circuit breaker state check.
 * Checks whether remote AI calls should be skipped due to active backoff.
 */
function isCircuitBreakerOpen(props, nowMs) {
  if (!props || typeof props.getProperty !== 'function') return false
  var untilStr = props.getProperty('GEMINI_BACKOFF_UNTIL')
  if (!untilStr) return false
  var until = Number.parseInt(untilStr, 10)
  if (Number.isNaN(until)) return false
  var now = typeof nowMs === 'number' ? nowMs : Date.now()
  return now < until
}

/**
 * Records a remote API failure in PropertiesService, applying exponential backoff.
 */
function recordCircuitBreakerFailure(props, retryDelayMs, nowMs) {
  if (!props || typeof props.setProperty !== 'function') return 0
  var now = typeof nowMs === 'number' ? nowMs : Date.now()
  var currentFailures = 0
  if (typeof props.getProperty === 'function') {
    var fStr = props.getProperty('GEMINI_BACKOFF_FAILURES')
    currentFailures = Number.parseInt(fStr || '0', 10)
    if (Number.isNaN(currentFailures)) currentFailures = 0
  }
  var failures = currentFailures + 1
  props.setProperty('GEMINI_BACKOFF_FAILURES', String(failures))

  var backoffMs = 60000 * Math.pow(2, failures - 1)
  if (typeof retryDelayMs === 'number' && retryDelayMs > backoffMs) {
    backoffMs = retryDelayMs
  }
  if (backoffMs > 3600000) {
    backoffMs = 3600000
  }
  var backoffUntil = now + backoffMs
  props.setProperty('GEMINI_BACKOFF_UNTIL', String(backoffUntil))
  return backoffMs
}

/**
 * Resets the cross-execution circuit breaker upon a successful remote API call.
 */
function recordCircuitBreakerSuccess(props) {
  if (!props) return
  if (typeof props.deleteProperty === 'function') {
    props.deleteProperty('GEMINI_BACKOFF_UNTIL')
    props.deleteProperty('GEMINI_BACKOFF_FAILURES')
  } else if (typeof props.setProperty === 'function') {
    props.setProperty('GEMINI_BACKOFF_UNTIL', '')
    props.setProperty('GEMINI_BACKOFF_FAILURES', '0')
  }
}

/**
 * Retrieves the retry failure count for a thread from cache.
 */
function getThreadRetryCount_(thread, cache) {
  if (!thread || !cache || typeof cache.get !== 'function') return 0
  var threadId = typeof thread.getId === 'function' ? thread.getId() : ''
  if (!threadId) return 0
  var val = cache.get('retry_count_' + threadId)
  var count = Number.parseInt(val || '0', 10)
  return Number.isNaN(count) ? 0 : count
}

/**
 * Increments the retry failure count for a thread in cache (6h TTL).
 */
function incrementThreadRetryCount_(thread, cache) {
  if (!thread || !cache || typeof cache.put !== 'function') return 1
  var threadId = typeof thread.getId === 'function' ? thread.getId() : ''
  if (!threadId) return 1
  var count = getThreadRetryCount_(thread, cache) + 1
  try {
    cache.put('retry_count_' + threadId, String(count), 21600)
  } catch {
    // Cache write is non-blocking
  }
  return count
}

/**
 * Clears the retry failure count for a thread from cache.
 */
function clearThreadRetryCount_(thread, cache) {
  if (!thread || !cache || typeof cache.remove !== 'function') return
  var threadId = typeof thread.getId === 'function' ? thread.getId() : ''
  if (!threadId) return
  try {
    cache.remove('retry_count_' + threadId)
  } catch {
    // Non-blocking
  }
}

function listAvailableGeminiModels(config, services) {
  var urlFetch =
    (services && services.UrlFetchApp) ||
    (typeof UrlFetchApp !== 'undefined' ? UrlFetchApp : null)
  if (!urlFetch) return []
  var cfg =
    config ||
    (typeof getAiClassifierConfig === 'function' ? getAiClassifierConfig() : {})
  if (!cfg || !cfg.geminiApiKey) return []
  var url = 'https://generativelanguage.googleapis.com/v1beta/models'
  try {
    var response = urlFetch.fetch(url, {
      headers: {
        'x-goog-api-key': cfg.geminiApiKey,
      },
      muteHttpExceptions: true,
    })
    if (response.getResponseCode() === 200) {
      var data = JSON.parse(response.getContentText())
      var modelNames = (data.models || []).map(function (m) {
        return m.name
      })
      console.log(
        '[listAvailableGeminiModels] Available models for key:',
        JSON.stringify(modelNames)
      )
      return modelNames
    } else {
      console.warn(
        '[listAvailableGeminiModels] HTTP ' +
          response.getResponseCode() +
          ': ' +
          response.getContentText()
      )
    }
  } catch (e) {
    console.warn(
      '[listAvailableGeminiModels] Error querying models:',
      e.message
    )
  }
  return []
}

/**
 * Ensures a Gmail user label exists, creating it if necessary.
 *
 * @param {string} labelName - Full label name (e.g. "01_Household/Primary")
 * @param {Object} gmailApp - GAS GmailApp service (injected for testability)
 * @returns {Object|null} GmailLabel or null on failure
 */
function ensureGmailLabel(labelName, gmailApp, gmailAdvanced) {
  if (
    !gmailApp ||
    !labelName ||
    typeof gmailApp.getUserLabelByName !== 'function'
  ) {
    return null
  }
  const existing = gmailApp.getUserLabelByName(labelName)
  if (existing) return existing

  if (typeof gmailApp.getUserLabels === 'function') {
    const allLabels = gmailApp.getUserLabels() || []
    for (let i = 0; i < allLabels.length; i++) {
      if (
        allLabels[i] &&
        typeof allLabels[i].getName === 'function' &&
        allLabels[i].getName().toLowerCase() === labelName.toLowerCase()
      ) {
        return allLabels[i]
      }
    }
  }

  if (labelName.indexOf('/') !== -1) {
    const parts = labelName.split('/')
    let currentPath = ''
    for (let p = 0; p < parts.length - 1; p++) {
      currentPath = currentPath ? currentPath + '/' + parts[p] : parts[p]
      ensureGmailLabel(currentPath, gmailApp, gmailAdvanced)
    }
  }

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
    try {
      if (typeof gmailApp.getUserLabels === 'function') {
        const existingLabels = gmailApp.getUserLabels() || []
        for (let j = 0; j < existingLabels.length; j++) {
          if (
            existingLabels[j] &&
            typeof existingLabels[j].getName === 'function' &&
            existingLabels[j].getName().toLowerCase() ===
              labelName.toLowerCase()
          ) {
            return existingLabels[j]
          }
        }
      }
    } catch {}
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
  if (!senderEmail || typeof senderEmail !== 'string') return false
  if (!labelName || typeof labelName !== 'string') return false
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
  if (!thread || typeof thread.getId !== 'function') {
    return
  }
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
  if (!thread || typeof thread.getLabels !== 'function') return
  try {
    var existingLabels = thread.getLabels() || []
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

    var removeLabelSafe = function (lObj, msgPrefix) {
      try {
        thread.removeLabel(lObj)
        console.log('[cleanConflictingLabels] ' + msgPrefix)
      } catch (err) {
        console.warn(
          '[cleanConflictingLabels] Failed ' + msgPrefix + ': ' + err.message
        )
      }
    }

    for (var j = 0; j < existingLabels.length; j++) {
      var lObj = existingLabels[j]
      var lName =
        typeof lObj.getName === 'function' ? lObj.getName() : String(lObj)

      // 1. Strip redundant Retention/Permanent (Inverted Model: blank = permanent)
      if (lName === 'Retention/Permanent') {
        removeLabelSafe(lObj, 'Stripped Retention/Permanent: ' + lName)
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
      var isLegacy = false
      for (var f = 0; f < legacyFlatLabels.length; f++) {
        if (lName.toLowerCase() === legacyFlatLabels[f].toLowerCase()) {
          removeLabelSafe(lObj, 'Stripped legacy flat label: ' + lName)
          isLegacy = true
          break
        }
      }
      if (isLegacy) continue

      // 5. Clean ALL Core Domain labels (threads only carry Sub-Labels, never raw domain codes)
      var isDomainCode =
        isRootDomainLabel(lName) || canonicalDomains.indexOf(lName) !== -1
      if (isDomainCode) {
        removeLabelSafe(lObj, 'Removed domain code label: ' + lName)
        continue
      }

      // 6. Clean conflicting sub-labels if they don't match targetSubLabel
      if (
        lName.indexOf('/') !== -1 &&
        lName !== targetSubLabel &&
        lName.indexOf('Archives') === -1 &&
        lName.indexOf('Retention/') === -1
      ) {
        removeLabelSafe(lObj, 'Removed conflicting sub-label: ' + lName)
      }
    }
  } catch (e) {
    console.warn('[cleanConflictingLabels] Error cleaning labels: ' + e.message)
  }
}

/**
 * Extracts the normalized email address from a From header string.
 *
 * @param {string} sender - Raw sender header
 * @returns {string} Lowercase email address or empty string
 */
function extractSenderAddress_(sender) {
  const raw = String(sender || '')
    .trim()
    .toLowerCase()
  const angleMatch = /<([^<>@\s]+@[^<>@\s]+)>/.exec(raw)
  if (angleMatch) return angleMatch[1]
  const plainMatch = /([^\s<>,"']+@[a-z0-9.-]+\.[a-z]{2,})/i.exec(raw)
  return plainMatch ? plainMatch[1].toLowerCase() : ''
}

/**
 * Extracts the hostname portion of the sender's email address.
 *
 * @param {string} sender - Raw sender header
 * @returns {string} Lowercase domain host or empty string
 */
function extractSenderHost_(sender) {
  const addr = extractSenderAddress_(sender)
  if (addr) {
    const atIdx = addr.lastIndexOf('@')
    return atIdx === -1 ? '' : addr.slice(atIdx + 1)
  }
  const raw = String(sender || '')
    .trim()
    .toLowerCase()
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(raw) ? raw : ''
}

function toTermList_(items) {
  if (!items) return []
  return Array.isArray(items) ? items : String(items).split('|')
}

/**
 * Checks whether the sender's hostname exactly matches or is a subdomain of
 * any domain in the provided list. Prevents substring false positives (e.g.
 * 'x.com' matching 'netflix.com' or 'fedex.com').
 *
 * @param {string} sender - Raw sender header
 * @param {string[]|string} domains - Candidate root/sub domains (array or pipe-delimited)
 * @returns {boolean} True if sender host matches any domain
 */
function matchesSenderDomain_(sender, domains) {
  const host = extractSenderHost_(sender)
  const list = toTermList_(domains)
  if (!host || list.length === 0) return false
  for (let i = 0; i < list.length; i++) {
    const target = String(list[i] || '')
      .trim()
      .toLowerCase()
    if (target && (host === target || host.endsWith('.' + target))) {
      return true
    }
  }
  return false
}

/**
 * Checks whether the sender's email address exactly matches any address in the list.
 *
 * @param {string} sender - Raw sender header
 * @param {string[]|string} addresses - Candidate email addresses (array or pipe-delimited)
 * @returns {boolean} True if sender address matches
 */
function matchesSenderAddress_(sender, addresses) {
  const addr = extractSenderAddress_(sender)
  const list = toTermList_(addresses)
  if (!addr || list.length === 0) return false
  for (let i = 0; i < list.length; i++) {
    const target = String(list[i] || '')
      .trim()
      .toLowerCase()
    if (target && addr === target) return true
  }
  return false
}

/**
 * Checks whether the lowercased text contains any of the given substrings.
 *
 * @param {string} textLower - Lowercased hay-stack string
 * @param {string[]|string} terms - Lowercase needle terms (array or pipe-delimited)
 * @returns {boolean} True if any term is found
 */
function containsAny_(textLower, terms) {
  const list = toTermList_(terms)
  if (!textLower || list.length === 0) return false
  for (let i = 0; i < list.length; i++) {
    if (list[i] && textLower.indexOf(list[i]) !== -1) return true
  }
  return false
}

/**
 * Builds a normalized deterministic classification result object.
 *
 * @param {string|null} canonicalDomain - Canonical domain or null
 * @param {string|null} subLabel - Sub-label or null
 * @param {string} category - Inbox category ('Primary', 'Updates', 'Promotions', 'Social')
 * @param {string} action - Action ('keep', 'archive', 'trash')
 * @param {number} confidence - Confidence score (0.0 to 1.0)
 * @param {string} subject - Email subject
 * @param {string} summary - Classification summary
 * @param {string} reasoning - Rule reasoning identifier
 * @returns {Object} Classification result
 */
function makeDeterministicResult_(
  canonicalDomain,
  subLabel,
  category,
  action,
  confidence,
  subject,
  summary,
  reasoning
) {
  return {
    canonicalDomain: canonicalDomain,
    canonical_label: canonicalDomain,
    subLabel: subLabel,
    category: category,
    action: action,
    confidence: confidence,
    title: subject,
    summary: summary,
    reasoning: reasoning,
  }
}

const SCHOOL_DOMAINS_ =
  'bcsk12.org|bcs-lions.org|briarwoodchristianschool.org|mcaabhm.org|jeffersonstate.edu'

const SCHOOL_BROADCAST_TERMS_ =
  'weekly|newsletter|bulletin|school update|campus update|district update|bcs update|lions update|digest|progress is ready|lunch|menu|portraits|news|noteworthy|announcement|athletics|e learning|e-learning|report card update|trunk or treat|spirit week|pto|pta|open house|picture day|fall festival|spring festival|school announcement|tryouts|tryout|try-outs|try-out|auditions|audition|team tryouts|absent|attendance|tardy|tuition|billing statement|assignment posted|new assignment|grade updated|score published|family portal|parent portal'

const CAREER_SUBJECT_TERMS_ =
  'employment agreement|employment contract|offer letter|job offer|employment offer|terms of employment|independent contractor agreement|restrictive covenant|confidentiality agreement|interview confirmation|interview invitation|invitation to interview|interview with |schedule an interview|recruiter screen|phone screen'

const CAREER_SNIPPET_TERMS_ =
  'employment agreement|offer of employment|terms of employment|pleased to offer you the position|pleased to offer you|pleased to confirm our offer|congratulations on your offer|employment document|restrictive covenants agreement'

const CUSTOM_RULE_MATCHERS_ = {
  nonprofit: function (ctx) {
    return (
      matchesSenderDomain_(
        ctx.sender,
        'ignite-hope.org|helpingoneguy.com|charitywater.org|compassion.com|worldvision.org'
      ) ||
      containsAny_(ctx.subLower, 'ironmen|iron men') ||
      (containsAny_(ctx.sLower, 'newsletter|update|impact') &&
        containsAny_(
          ctx.subLower,
          'impact update|ministry update|community update'
        ))
    )
  },
  saasPlan: function (ctx) {
    return (
      containsAny_(
        ctx.subLower,
        'trial is ending|trial ending|trial will expire|trial expired|trial expiration|free trial is ending|free trial ends'
      ) ||
      (ctx.subLower.indexOf('aws') !== -1 &&
        containsAny_(
          ctx.subLower,
          'upgraded to a paid plan|free plan is ready'
        )) ||
      ((matchesSenderDomain_(
        ctx.sender,
        'aws.com|amazonaws.com|digitalocean.com|cloudflare.com|openai.com|anthropic.com|supabase.com|neon.tech'
      ) ||
        ctx.sLower.indexOf('azure') !== -1) &&
        containsAny_(
          ctx.subLower,
          'upgraded to a paid plan|free plan is ready|free tier|startup credits|account plan'
        ))
    )
  },
  schoolBroadcast: function (ctx) {
    const isParentSquare = matchesSenderDomain_(ctx.sender, 'parentsquare.com')
    return (
      ctx.isBrightArrow ||
      ((ctx.isSchoolDomain ||
        isParentSquare ||
        matchesSenderAddress_(ctx.sender, 'admissions@ua.edu')) &&
        (ctx.isBroadcastSubject || isParentSquare))
    )
  },
  schoolTravel: function (ctx) {
    return (
      matchesSenderDomain_(
        ctx.sender,
        'ef.com|eftours.com|worldstrides.com|explorica.com|acis.com'
      ) ||
      (containsAny_(ctx.subLower, 'trip to |school travel|educational tour') &&
        containsAny_(
          ctx.subLower,
          'interest meeting|informational meeting|rsvp|enrollment discount'
        ))
    )
  },
  bankRate: function (ctx) {
    return (
      containsAny_(
        ctx.subLower,
        'higher apy|apy has increased|apy increased|earns a higher apy|rate increase|rate decrease|rate update|rates are changing|yield update|interest rate increase|savings rate increase|annual percentage yield'
      ) ||
      (ctx.subLower.indexOf('rate change') !== -1 &&
        containsAny_(ctx.subLower, 'apy|cash|savings|interest'))
    )
  },
}

/**
 * Declarative deterministic rule specifications.
 * Format: mode::domains::addresses::senderTerms::subjectTerms::excludeSubject::domain::subLabel::category::action::confidence::reasoning::summary
 */
const DETERMINISTIC_RULE_SPECS_ = [
  'any::::::::your day ahead::::01_Household::Household/Property::Updates::archive::0.99::Daily Digest::Automated daily agenda digest routed to Updates.',
  'sender+sub::amazon.com|hp.com|brother.com|canon.com|epson.com::auto-reorder@amazon.com|dash@amazon.com::instantink::time to order the|time to reorder|smart reorder|auto-reorder|replenishment|low ink|ink alert|toner low|toner alert|toner for your|replacement filter|reorder your::::01_Household::Household/Supplies::Updates::archive::0.99::Smart Reorder::Automated smart reorder or consumable replenishment alert routed to Updates.',
  'any::broodminder.com|mybroodminder.com::::broodminder|mybroodminder::hive alert|events in your apiaries|events in your apiary|event in your apiaries|event in your apiary|apiary alert|apiary event::::07_Community_NonProfit::Projects/Telemetry::Updates::archive::0.99::BroodMinder Telemetry::Automated hive and apiary telemetry alert routed to Projects/Telemetry.',
  'any::qnap.com::::qts notification|notificationcenter::[qnap|qts notification|qvr pro|qulog::::05_Tech_Infrastructure::Tech/Alerts::Updates::archive::0.99::QNAP Telemetry::QNAP NAS system health, RAID, backup, or QVR surveillance telemetry alert routed to Tech/Alerts.',
  'any::ui.com|ubnt.com::::::unifi::verification code|mfa|one-time|security code::05_Tech_Infrastructure::Tech/Alerts::Updates::archive::0.99::UniFi Telemetry::UniFi Dream Machine or network infrastructure alert routed to Tech/Alerts.',
  'any::nabucasa.com|home-assistant.io::::::home assistant::::05_Tech_Infrastructure::Tech/Alerts::Updates::archive::0.99::Home Assistant Telemetry::Home Assistant or Nabu Casa cloud telemetry/subscription alert routed to Tech/Alerts.',
  'custom:nonprofit::::::::::::07_Community_NonProfit::NonProfit/General::Updates::archive::0.98::NonProfit Impact Newsletter::Community non-profit organization newsletter, Bible study digest, or project impact update routed to Updates.',
  'any::linear.app::::::::::05_Tech_Infrastructure::Tech/Alerts::Updates::archive::0.99::Linear Alert::Linear task and project notification digest routed to Tech/Alerts.',
  'any::notifications.cubic.dev|cubic.dev::::cubic::::::05_Tech_Infrastructure::Tech/Alerts::Updates::archive::0.99::Cubic Code Review::Cubic AI automated code review notice routed to Tech/Alerts.',
  'any::::notifications@github.com::::::::05_Tech_Infrastructure::Tech/Alerts::Updates::archive::0.99::GitHub Alert::GitHub CI/CD workflow run or notification routed to Tech/Alerts.',
  'any::sonarcloud.io|sentry.io|vercel.com::noreply-apps-scripts-notifications@google.com::::::::05_Tech_Infrastructure::Tech/Alerts::Updates::archive::0.99::Developer Monitoring Alert::CI/CD code quality, error monitoring, or deployment alert routed to Tech/Alerts.',
  'any::::googleaistudio-noreply@google.com::::::::05_Tech_Infrastructure::Tech/Alerts::Updates::archive::0.99::Google AI Studio Alert::Google AI Studio API quota, model deprecation, or project update routed to Tech/Alerts.',
  'any::updates.codeant.ai|codeant.ai::::::::::::::Promotions::archive::0.98::DevTool Promo::Developer tooling promotional or product feature announcement routed to Promotions.',
  'any::::calendar-notification@google.com::::::::01_Household::Household/Property::Updates::archive::0.99::Calendar Notification::Google Calendar event reminder notification routed to Updates.',
  'custom:saasPlan::::::::::::05_Tech_Infrastructure::Tech/Alerts::Updates::archive::0.99::SaaS / Cloud Plan Alert::Cloud provider tier status, SaaS trial expiration, or account plan notification routed to Tech/Alerts.',
  'any::pypi.org|npmjs.com|docker.com|crates.io::::::[pypi]|trusted publisher::::05_Tech_Infrastructure::Tech/Alerts::Updates::archive::0.99::Package Registry Alert::Package repository publishing, release, or trusted publisher notification routed to Tech/Alerts.',
  'any::::::::you shared some google account data with|google account data with|granted access to your google account|third-party access|app access granted::::05_Tech_Infrastructure::Tech/Security::Primary::keep::1::Third-Party Authorization Shield::Third-party application account data sharing or authorization notice preserved in Primary Inbox as security warning.',
  'any::::::::verification code|security code|one-time passcode|one-time password|your login code|new sign-in|signed in from a new|new device signed in|sign-in from new device|security alert for your|password changed|password reset confirmation::::05_Tech_Infrastructure::Tech/Security::Updates::archive::0.99::Authentication/Sign-in Ping::Automated authentication verification code or device sign-in alert routed to Tech/Security.',
  'any::cvs.com|walgreens.com|questdiagnostics.com|labcorp.com|zocdoc.com|athenahealth.com::::mychart|cvshealth::appointment reminder|upcoming appointment|appointment confirmation|appointment is confirmed|prescription is ready|prescription ready|refill reminder|refill confirmation::::04_Family_Health::Family/Health-Medical::Updates::archive::0.99::Healthcare/Pharmacy Alert::Automated patient portal appointment reminder or pharmacy prescription status notice.',
  'sender+sub::delta.com|southwest.com|aa.com|united.com|airbnb.com|vrbo.com|marriott.com|hilton.com|uber.com|lyft.com|waymo.com::::waymo::flight confirmation|flight status|boarding pass|check in for your flight|reservation confirmed|reservation confirmation|upcoming stay|trip with uber|ride with lyft|waymo ride|riding with waymo|receipt::::01_Household::Household/Travel::Updates::archive::0.99::Travel Confirmation::Travel itinerary reservation, flight check-in, or rideshare receipt.',
  'any::::::::how was your experience|how did we do|rate your recent|rate your experience|rate your stay|tell us what you think|take our survey|take our quick survey|quick survey|feedback requested|review your purchase|leave a review|your opinion matters::::::::Promotions::archive::0.99::Customer Survey::Automated post-transaction customer satisfaction feedback or survey request.',
  'any::ifttt.com|notify.mios.com::::::::::01_Household::Household/Property::Updates::archive::0.98::IFTTT / Weather Alert::Automated weather or IoT trigger notification routed to Household/Property.',
  'custom:schoolBroadcast::::::::::::04_Family_Health::Family/School-Student::Updates::archive::0.98::School Broadcast::Routine school bulletin, newsletter, BrightArrow broadcast, or ParentSquare digest routed to Updates.',
  'custom:schoolTravel::::::::::::04_Family_Health::Family/School-Student::Promotions::archive::0.99::School Travel Solicitation::Educational travel program solicitation or informational trip meeting announcement routed to Promotions.',
  'any::hello.springhealth.com|springhealth.com::::::::::04_Family_Health::Family/Health-Medical::Updates::archive::0.98::Benefits Broadcast::Routine employer healthcare benefit announcement or wellness newsletter.',
  'sender+sub::ebay.com::::::delivered|out for delivery|order confirmed|shipped::::02_Finance_Legal::Finance/Purchases::Updates::archive::0.98::Order Tracking::Online order confirmation or package delivery tracking notice.',
  'sender+sub::ups.com|fedex.com|usps.com|usps.gov::::::delivered|out for delivery|tracking|scheduled delivery|package|shipment::::02_Finance_Legal::Finance/Purchases::Updates::archive::0.98::Carrier Tracking::Carrier parcel shipment or package delivery notification.',
  'sender+sub::amazon.com::::::ordered:|shipped:|delivered:|refund issued|auto-reloaded::::02_Finance_Legal::Finance/Purchases::Updates::archive::0.98::Amazon Routine::Routine Amazon e-commerce order, shipping, or refund update.',
  'sender+sub::chase.com|bankofamerica.com|spireenergy.com|alabamapower.com|bwwb.org|message.att-mail.com|att-mail.com|citi.com|americanexpress.com|apcocu.org|rocketmortgage.com|mycirclecard.target.com::::capitalone|spectrum|citicards::statement|autopay|payment processed|payment confirmation|payment scheduled|payment received|scheduled payment|bill is ready|bill is available|e-statement|estatement::failed|failure|declined|past due|overdue|action required|unpaid|late fee|returned payment|insufficient funds::02_Finance_Legal::Finance/Bills::Updates::archive::0.98::Routine Billing::Routine billing statement, receipt, or AutoPay confirmation.',
  'sender+sub::bcbsal.org|bcbs.com|uhc.com|aetna.com|cigna.com|humana.com::::bluecrosspayments|unitedhealthcare::explanation of benefits|claim|claims|eob::::02_Finance_Legal::Finance/Insurance::Updates::archive::0.99::Insurance Claim / EOB Notice::Health insurance claim processing notice or explanation of benefits (EOB) notification routed to Finance/Insurance.',
  'sender+sub::bcbsal.org|bcbs.com|uhc.com|aetna.com|cigna.com|humana.com::::bluecrosspayments|unitedhealthcare::payment|payments|premium|statement|bill|processed|receipt::failed|failure|declined|past due|overdue|action required|unpaid|late fee|returned payment|insufficient funds::02_Finance_Legal::Finance/Bills::Updates::archive::0.99::Insurance Payment Receipt::Health insurance premium payment or processing notification routed to Finance/Bills.',
  'sender+sub::geico.com|progressive.com|statefarm.com::::::auto pay|autopay|payment|bill|statement|policy document|id card::claim|adjuster|settlement|complaint|failed|failure|declined|past due|overdue|action required|unpaid|late fee|returned payment|insufficient funds::02_Finance_Legal::Finance/Bills::Updates::archive::0.99::Auto Insurance Routine Billing::Routine auto insurance billing, AutoPay notice, or policy document routed to Finance/Bills.',
  'sender+sub::chase.com|discover.com::::creditwise|creditkarma|experian|equifax|transunion|myfico|capitalone::credit score|score went up|score went down|creditwise|score changed|credit alert|credit monitoring|credit report|fico score|new credit inquiry::::02_Finance_Legal::Finance/Banking::Updates::archive::0.99::Credit Score Alert::Automated credit score update or credit monitoring notification routed to Updates.',
  'custom:bankRate::::::::::::02_Finance_Legal::Finance/Banking::Updates::archive::0.99::Bank Rate Update::Automated bank account APY or interest rate change notification routed to Finance/Banking.',
  'any::::::::terms of service|privacy policy|terms and conditions|terms of use|user agreement|privacy notice|policy update|updates to our terms|updates to our privacy|arbitration clause|arbitration terms|consumer privacy::::::::Updates::archive::0.99::Policy / Terms Update::Commercial platform terms of service, privacy policy revision, or user agreement update routed to Updates.',
  'sender+sub::paypal.com::::::receipt|payment|transaction|you sent|you paid|you received|authorized|usd::::02_Finance_Legal::Finance/Purchases::Updates::archive::0.98::Payment Receipt::Electronic payment transaction receipt or transfer confirmation.',
  'sender+sub::homedepot.com::::::order|receipt|picked up|ready for pickup::::02_Finance_Legal::Finance/Purchases::Updates::archive::0.98::Retail Order / Receipt::Home Depot store receipt or order pickup confirmation.',
  'sender+sub::target.com|costco.com|bestbuy.com|walmart.com::::::order|receipt|ready for pickup|picked up|shipped|delivered::::02_Finance_Legal::Finance/Purchases::Updates::archive::0.98::Retail Order / Receipt::Retail store order confirmation, receipt, or pickup notice.',
  'sender+sub::ereceiptshell.com|autozone.com|advanceautoparts.com|rockauto.com::::shell e-receipt::receipt|purchase|order|fuel::::03_Vehicles::Vehicles/Maintenance::Updates::archive::0.99::Vehicle Fuel/Maintenance Receipt::Automated vehicle fuel purchase receipt or parts order confirmation routed to Vehicles/Maintenance.',
  'any::nytimes.com|nextdoor.com|substack.com|redditmail.com|daily.therundown.ai|therundown.ai|mail.instagram.com|instagram.com|facebookmail.com|linkedin.com|pinterest.com|quora.com|youtube.com|twitter.com|x.com::::dougforalabama|ossoff|the passion translation|aibreakfast::::::::::Social::archive::0.98::News/Newsletter/Social::Routine media newsletter, Substack digest, social media alert, or political appeal.',
]

function evaluateDeterministicRuleSpec_(specStr, ctx, subject) {
  const parts = specStr.split('::')
  const mode = parts[0]
  const excludeSubject = parts[5]
  if (excludeSubject && containsAny_(ctx.subLower, excludeSubject)) {
    return null
  }
  let matched = false
  if (mode.indexOf('custom:') === 0) {
    matched = CUSTOM_RULE_MATCHERS_[mode.slice(7)](ctx)
  } else {
    const senderHit =
      matchesSenderDomain_(ctx.sender, parts[1]) ||
      matchesSenderAddress_(ctx.sender, parts[2]) ||
      containsAny_(ctx.sLower, parts[3])
    const subjectHit = containsAny_(ctx.subLower, parts[4])
    matched =
      mode === 'sender+sub' ? senderHit && subjectHit : senderHit || subjectHit
  }
  if (!matched) return null
  return makeDeterministicResult_(
    parts[6] || null,
    parts[7] || null,
    parts[8],
    parts[9],
    Number.parseFloat(parts[10]),
    subject,
    parts[12],
    parts[11]
  )
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
  const sLower = (sender || '').toLowerCase()
  const subLower = (subject || '').toLowerCase()
  const snipLower = (snippet || '').toLowerCase()
  const userEmail = (
    config && config.userAccountEmail ? config.userAccountEmail : ''
  ).toLowerCase()

  // 1. Safety Shields
  if (thread && typeof thread.getMessages === 'function' && userEmail) {
    try {
      const msgs = thread.getMessages() || []
      for (let m = 0; m < msgs.length; m++) {
        const fromA = (
          msgs[m] && typeof msgs[m].getFrom === 'function'
            ? msgs[m].getFrom()
            : (msgs[m] && msgs[m].from) || ''
        ).toLowerCase()
        if (fromA.indexOf(userEmail) !== -1) {
          return makeDeterministicResult_(
            null,
            null,
            'Primary',
            'keep',
            1.0,
            subject,
            'User-sent or replied thread preserved in Primary Inbox.',
            'User-Sent Shield'
          )
        }
      }
    } catch {
      // ignore thread check errors
    }
  }

  // Family 1:1 Shield (configurable via config.familyEmails or customPromptRules)
  const familyList =
    config && config.familyEmails
      ? config.familyEmails.toLowerCase().split(',')
      : []
  if (
    familyList.length > 0 &&
    familyList.some(function (f) {
      return f.trim() && sLower.indexOf(f.trim()) !== -1
    })
  ) {
    return makeDeterministicResult_(
      '04_Family_Health',
      'Family/Correspondence',
      'Primary',
      'keep',
      1.0,
      subject,
      'Direct family correspondence preserved in Primary Inbox.',
      'Family 1:1 Shield'
    )
  }

  // Teacher / Academic Counselor 1:1 Shield (exclude mass broadcast subjects)
  const isSchoolDomain = matchesSenderDomain_(sender, SCHOOL_DOMAINS_)
  const isBrightArrow =
    matchesSenderDomain_(sender, ['brightarrow.com']) ||
    sLower.indexOf('brightarrow') !== -1
  const isBroadcastSubject = containsAny_(subLower, SCHOOL_BROADCAST_TERMS_)

  if (isSchoolDomain && !isBroadcastSubject && !isBrightArrow) {
    return makeDeterministicResult_(
      '04_Family_Health',
      'Family/School-Student',
      'Primary',
      'keep',
      1.0,
      subject,
      'Direct 1:1 teacher or school counselor correspondence preserved in Primary Inbox.',
      'Teacher 1:1 Shield'
    )
  }

  // 06_Work_Career: Employment Agreements, Offer Letters, Employment Contracts, Recruiter Screens & Interviews
  if (
    containsAny_(subLower, CAREER_SUBJECT_TERMS_) ||
    containsAny_(snipLower, CAREER_SNIPPET_TERMS_)
  ) {
    return makeDeterministicResult_(
      '06_Work_Career',
      'Work/Career',
      'Primary',
      'keep',
      0.99,
      subject,
      'Employment agreement, offer letter, or career interview communication preserved in Primary Inbox.',
      'Career / Employment Contract Rule'
    )
  }

  // 2. Deterministic Feeds & Broadcasts
  const ruleContext = {
    sender: sender,
    sLower: sLower,
    subLower: subLower,
    snipLower: snipLower,
    isSchoolDomain: isSchoolDomain,
    isBrightArrow: isBrightArrow,
    isBroadcastSubject: isBroadcastSubject,
  }
  for (let r = 0; r < DETERMINISTIC_RULE_SPECS_.length; r++) {
    const ruleHit = evaluateDeterministicRuleSpec_(
      DETERMINISTIC_RULE_SPECS_[r],
      ruleContext,
      subject
    )
    if (ruleHit) return ruleHit
  }

  // Retail & E-Commerce Marketing Blasts
  const isScarsella = sLower.indexOf('scarsella') !== -1
  const isScarsellaCurriculum =
    isScarsella &&
    /\b(curriculum|schedule|testing|belt|forms?)\b/i.test(
      (subject || '') + ' ' + (snippet || '')
    )

  const isPromoSubject =
    /\b(sale|\d+%\s*off|deal of the day|daily deals?|clearance|limited time offer|coupon|promo code|shop now|shop today|exclusive offer|special offer|flash sale|black friday|cyber monday|memorial day sale|labor day sale|presidents day sale|discount code|save \$\d+|save up to|free shipping|buy one get one|bogo|don't miss out|last chance to save|doorbusters?|rewards balance|earn bonus points|member exclusive)\b/i.test(
      subject || ''
    )
  const isNonTransactional = !containsAny_(
    subLower,
    'order|receipt|invoice|statement|autopay|tracking|shipped|delivered'
  )

  const isRetailVendor =
    matchesSenderDomain_(
      sender,
      'target.com|costco.com|bestbuy.com|walmart.com|doordash.com|kohls.com|samsclub.com|em1.cloudflare.com'
    ) ||
    containsAny_(
      sLower,
      'lowes|mannlake|urotuning|ray-ban|americanmeadows|foxhound|bhphotovideo|starbucks|birminghamhomebuyers|trailerparts|hillco'
    )

  if (
    (isRetailVendor && isNonTransactional) ||
    (isScarsella && !isScarsellaCurriculum) ||
    (isPromoSubject && isNonTransactional)
  ) {
    return makeDeterministicResult_(
      null,
      null,
      'Promotions',
      'archive',
      0.98,
      subject,
      'Commercial vendor retail promo, discount, or marketing announcement.',
      'Retail Promo'
    )
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
    const threadId =
      typeof thread.getId === 'function'
        ? thread.getId()
        : thread.id || 'unknown'
    const messages =
      typeof thread.getMessages === 'function' ? thread.getMessages() : []
    if (!messages || messages.length === 0) {
      results.push({ threadId: threadId, status: 'empty' })
      return
    }

    const latestMsg = messages[0]
    const sender =
      typeof latestMsg.getFrom === 'function'
        ? latestMsg.getFrom()
        : latestMsg.from || ''
    const subject =
      typeof latestMsg.getSubject === 'function'
        ? latestMsg.getSubject()
        : latestMsg.subject || ''
    let bodySnippet =
      typeof latestMsg.getPlainBody === 'function'
        ? latestMsg.getPlainBody().substring(0, 1200)
        : latestMsg.snippet || ''
    bodySnippet = enrichSnippetWithAttachments_(bodySnippet, latestMsg)

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
      console.log('[processThreadBatch] Could not classify thread:', threadId)
      results.push({ threadId: threadId, status: 'unclassified' })
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
          threadId: threadId,
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
    if (services && services.DriveApp) {
      savedAttachments = persistCanonicalAttachmentsToDrive(
        thread,
        classification,
        config,
        services
      )
    }

    results.push({
      threadId: threadId,
      status: 'classified',
      label: classification.canonical_label,
      confidence: classification.confidence,
      filterCreated: filterCreated,
      savedAttachments: savedAttachments,
    })
  })

  return results
}

const RULE6_PATTERNS = [
  [/\S \? \S/, "' ? ' between words (was an em dash or a · separator)"],
  [/\?\?/, "'??' (was a multi-codepoint emoji)"],
  [/[A-Za-z]\?[A-Za-z]/, "'?' inside a word (was a curly apostrophe)"],
  [/\uFFFD/, 'U+FFFD replacement character'],
]

/**
 * Resolves the target GitHub repository owner and name from injected services,
 * environment variables, ScriptProperties, or config.
 *
 * @param {Object} [services] - Optional injected services
 * @returns {{ repoOwner: string, repoName: string }}
 */
function resolveGitHubRepoTarget_(services) {
  const props =
    services?.PropertiesService ||
    (typeof PropertiesService !== 'undefined' ? PropertiesService : null)
  const scriptProps = props?.getScriptProperties?.()
  const cfg =
    typeof getAiClassifierConfig === 'function' ? getAiClassifierConfig() : {}
  const envOwner =
    typeof process !== 'undefined' && process.env
      ? process.env.GITHUB_REPO_OWNER
      : ''
  const envName =
    typeof process !== 'undefined' && process.env
      ? process.env.GITHUB_REPO_NAME
      : ''

  const repoOwner =
    services?.githubRepoOwner ||
    envOwner ||
    scriptProps?.getProperty?.('GITHUB_REPO_OWNER') ||
    cfg.githubRepoOwner ||
    ''
  const repoName =
    services?.githubRepoName ||
    envName ||
    scriptProps?.getProperty?.('GITHUB_REPO_NAME') ||
    cfg.githubRepoName ||
    ''

  return { repoOwner, repoName }
}

/** Refuse to write an entry that already shows mojibake. */
function assertClean_(text, what) {
  if (!text) return
  const scrubbed = String(text).replace(/https?:\/\/\S+/gi, '')
  for (let i = 0; i < RULE6_PATTERNS.length; i++) {
    if (RULE6_PATTERNS[i][0].test(scrubbed)) {
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
  if (!filePath || typeof filePath !== 'string') {
    return 'Ingested Records'
  }
  const trimmed = filePath.trim()
  if (!trimmed || trimmed === '/') {
    return 'Ingested Records'
  }
  const parts = trimmed.split('/').filter(Boolean)
  if (parts.length === 0) {
    return 'Ingested Records'
  }
  const topic = parts.length > 1 ? parts[parts.length - 2] : parts[0]
  // Strip any trailing file extension (e.g. ".md") before title-casing so a
  // single-segment path like "digital-backups.md" becomes "Digital Backups".
  const cleaned = topic.replace(/\.[^.]+$/, '').replace(/-/g, ' ')
  if (!cleaned) return 'Ingested Records'
  return cleaned.replace(/\b\w/g, function (l) {
    return l.toUpperCase()
  })
}

function insertEntryIntoLogSection(fullContent, newEntry) {
  if (!fullContent && !newEntry) return ''
  if (!fullContent) return String(newEntry)
  if (!newEntry) return String(fullContent)

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
  if (!filePath || !entryMd) {
    console.warn('[gitHubSync] Missing filePath or entryMd for GitHub commit.')
    return false
  }
  const urlFetchApp =
    services?.UrlFetchApp ||
    (typeof UrlFetchApp !== 'undefined' ? UrlFetchApp : null)
  const utils =
    services?.Utilities || (typeof Utilities !== 'undefined' ? Utilities : null)

  const { repoOwner, repoName } = resolveGitHubRepoTarget_(services)
  if (!repoOwner || !repoName) {
    console.warn(
      '[gitHubSync] GITHUB_REPO_OWNER or GITHUB_REPO_NAME not configured. Skipping GitHub commit.'
    )
    return false
  }

  const encodedPath = String(filePath)
    .split('/')
    .filter(Boolean)
    .map(function (segment) {
      return encodeURIComponent(segment)
    })
    .join('/')

  const url =
    'https://api.github.com/repos/' +
    encodeURIComponent(repoOwner) +
    '/' +
    encodeURIComponent(repoName) +
    '/contents/' +
    encodedPath
  const headers = {
    Authorization: 'Bearer ' + githubToken,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
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
 * Checks whether a sender matches known non-canonical newsletter or social domains.
 *
 * @param {string} sender - Raw sender header
 * @returns {boolean} True if sender is a non-canonical newsletter/social source
 */
function isNonCanonicalSender_(sender) {
  return (
    matchesSenderDomain_(sender, [
      'substack.com',
      'redditmail.com',
      'nextdoor.com',
      'facebookmail.com',
      'instagram.com',
      'twitter.com',
      'x.com',
      'pinterest.com',
      'quora.com',
    ]) || /\bnewsletters?@/i.test(String(sender || ''))
  )
}

/**
 * Checks whether a thread has been assigned a secondary Gmail category tab
 * (Updates, Promotions, Social, Forums) via user labels, thread properties,
 * or the Advanced Gmail API (`CATEGORY_*` system label IDs).
 *
 * @param {Object} thread - GmailThread or mock object
 * @param {string[]} rawLabels - User label names on the thread
 * @param {Object} [services] - Optional injected services ({ Gmail })
 * @returns {boolean} True if thread is in a secondary category stream
 */
function hasSecondaryCategory_(thread, rawLabels, services) {
  if (
    Array.isArray(rawLabels) &&
    rawLabels.some(function (l) {
      return /promotions|updates|social|forums|archive/i.test(String(l || ''))
    })
  ) {
    return true
  }

  const threadCat =
    typeof thread?.getCategory === 'function'
      ? thread.getCategory()
      : thread?.category || ''
  if (
    threadCat &&
    /promotions|updates|social|forums|CATEGORY_(UPDATES|PROMOTIONS|SOCIAL|FORUMS)/i.test(
      String(threadCat)
    )
  ) {
    return true
  }

  const gmailAdv =
    services?.Gmail || (typeof Gmail !== 'undefined' ? Gmail : null)
  const threadId =
    typeof thread?.getId === 'function' ? thread.getId() : thread?.id || ''
  if (threadId && typeof gmailAdv?.Users?.Threads?.get === 'function') {
    try {
      const threadMeta = gmailAdv.Users.Threads.get('me', threadId)
      const labelIds = [].concat(
        Array.isArray(threadMeta?.labelIds) ? threadMeta.labelIds : []
      )
      if (Array.isArray(threadMeta?.messages)) {
        for (let m = 0; m < threadMeta.messages.length; m++) {
          if (Array.isArray(threadMeta.messages[m]?.labelIds)) {
            labelIds.push(...threadMeta.messages[m].labelIds)
          }
        }
      }
      if (
        labelIds.some(function (id) {
          return /^CATEGORY_(UPDATES|PROMOTIONS|SOCIAL|FORUMS)$/i.test(
            String(id || '')
          )
        })
      ) {
        return true
      }
    } catch {
      // Non-blocking fallback when Advanced Gmail API is unavailable
    }
  }

  return false
}

/**
 * Audits a collection of processed Gmail threads for classification anomalies.
 *
 * @param {Array} threads - Array of GmailThread-like objects
 * @param {Object} config - Classifier config
 * @param {Object} [services] - Optional injected services ({ Gmail })
 * @returns {Object} report - { scannedCount, flaggedCount, findings, summary }
 */
function auditClassifications(threads, config, services) {
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
  const SURVEY_KEYWORDS =
    /\b(survey|feedback|net promoter|nps|rate your experience|how did we do|review us)\b/i
  const POLITICAL_KEYWORDS =
    /\b(campaign|pac|fundraiser|election|candidate|contribute now|donate to our campaign)\b/i

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

    const assignedCanonical = []
    rawLabels.forEach((l) => {
      if (!l || typeof l !== 'string') return
      const resolved = resolveCanonicalDomainFromLabels([l], canonicalDomains)
      if (resolved && canonicalDomains.includes(resolved)) {
        if (!assignedCanonical.includes(resolved)) {
          assignedCanonical.push(resolved)
        }
        return
      }
      const match = l.match(/^(0[1-7]_[A-Za-z_]+)/)
      if (match && canonicalDomains.includes(match[1])) {
        if (!assignedCanonical.includes(match[1])) {
          assignedCanonical.push(match[1])
        }
      }
    })

    let isInTrash = false
    if (typeof thread.isInTrash === 'function') {
      try {
        isInTrash = thread.isInTrash()
      } catch {}
    } else if (thread.isInTrash === true || thread.isTrash === true) {
      isInTrash = true
    }

    const flags = []
    const fullText = (subject + ' ' + sender).toLowerCase()
    const isReceiptOrOrder = ORDER_KEYWORDS.test(fullText)
    const isNonCanonicalStream =
      isInTrash ||
      (!isReceiptOrOrder &&
        (rawLabels.some((l) =>
          /promotions|social|forums|marketing|promo|deal|newsletter/i.test(l)
        ) ||
          isNonCanonicalSender_(sender) ||
          PROMO_KEYWORDS.test(subject) ||
          NEWSLETTER_KEYWORDS.test(subject) ||
          TOS_KEYWORDS.test(subject) ||
          SURVEY_KEYWORDS.test(subject) ||
          POLITICAL_KEYWORDS.test(subject)))

    // 1. Missing Domain
    if (assignedCanonical.length === 0 && !isNonCanonicalStream) {
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
        rawLabels.find((l) => {
          if (!l || typeof l !== 'string' || !l.includes('/')) return false
          if (/^0[1-7]_/.test(l)) {
            return l.startsWith(domain + '/')
          }
          return true
        }) || ''
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
              const targetFolder = findDriveTaxonomyFolder_(
                domain,
                subfolderName,
                driveApp,
                config?.driveRootFolderName
              )
              const existingFiles = targetFolder
                ? targetFolder.getFilesByName(attName)
                : null
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

    // 5. Archived from Inbox Without Action Check
    const isArchived =
      (typeof thread.isInInbox === 'function' &&
        thread.isInInbox() === false) ||
      thread.isInInbox === false
    if (isArchived && assignedCanonical.length > 0) {
      const isStarred =
        (typeof thread.isStarred === 'function' &&
          thread.isStarred() === true) ||
        thread.isStarred === true
      const userEmail = (config && config.userAccountEmail) || ''
      const isSentOrReplied =
        typeof isThreadSentOrRepliedByUser === 'function'
          ? isThreadSentOrRepliedByUser(thread, userEmail)
          : false
      const hasSecondaryCategory = hasSecondaryCategory_(
        thread,
        rawLabels,
        services
      )

      if (!isStarred && !isSentOrReplied && !hasSecondaryCategory) {
        flags.push(
          'ARCHIVED_WITHOUT_ACTION: Thread tagged under ' +
            assignedCanonical.join(', ') +
            ' was archived from Inbox without user reply or star; candidate for secondary stream routing (Updates).'
        )
      }
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
    if (!finding) return
    const labelsStr =
      Array.isArray(finding.canonicalLabels) &&
      finding.canonicalLabels.length > 0
        ? finding.canonicalLabels.join(', ')
        : '(none)'
    const flagsList = Array.isArray(finding.flags) ? finding.flags : []

    text +=
      idx + 1 + '. Subject: "' + (finding.subject || '(no subject)') + '"\n'
    text += '   Sender:  ' + (finding.sender || '(unknown)') + '\n'
    text += '   Labels:  ' + labelsStr + '\n'
    text += '   Flags:\n'
    flagsList.forEach((f) => {
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

/**
 * Daily audit sweep that examines recently classified threads (default: last 2 days),
 * identifies classification anomalies, logs them, and sends an email digest.
 *
 * @param {Object} [customConfig] - Optional override configuration
 * @param {Object} [customServices] - Optional injected services (GmailApp)
 * @returns {Object} report - { scannedCount, flaggedCount, findings, summary }
 */
function auditEmailClassifications(customConfig, customServices) {
  console.log(
    '[auditEmailClassifications] Starting daily classification audit sweep...'
  )
  const services = customServices || {}
  const config = resolveEffectiveConfig_(customConfig)
  const gmail =
    services.GmailApp || (typeof GmailApp !== 'undefined' ? GmailApp : null)
  const lookback = config.auditLookbackDays || 2
  const query =
    'label:' +
    (config.processedLabel || 'Processed') +
    ' newer_than:' +
    lookback +
    'd'

  const rawThreads =
    gmail && typeof gmail.search === 'function'
      ? gmail.search(query, 0, 50)
      : []
  const threads = sortThreadsByLastMessageDate_(rawThreads)
  console.log(
    '[auditEmailClassifications] Found ' +
      threads.length +
      ' processed thread(s) in last ' +
      lookback +
      ' day(s).'
  )

  const report = auditClassifications(threads, config, services)
  console.log('[auditEmailClassifications] ' + report.summary)

  if (report.flaggedCount > 0) {
    const digest = formatAuditDigest(report)
    console.warn('[auditEmailClassifications] Anomalies detected:\n' + digest)

    if (
      config.auditDigestEmail &&
      gmail &&
      typeof gmail.sendEmail === 'function'
    ) {
      try {
        gmail.sendEmail(
          config.auditDigestEmail,
          '[Gmail AI Classifier] Daily Classification Audit: ' +
            report.flaggedCount +
            ' anomalies detected',
          digest
        )
        console.log(
          '[auditEmailClassifications] Audit digest email sent to ' +
            config.auditDigestEmail
        )
      } catch (e) {
        console.error(
          '[auditEmailClassifications] Failed to send audit digest email:',
          e.message
        )
      }
    }
  } else {
    console.log(
      '[auditEmailClassifications] All analyzed threads are compliant with taxonomy rules.'
    )
  }

  return report
}

/**
 * Sets up a weekly cloud trigger to run purgeExpiredEmailsByRetentionPolicy every Sunday at 1:00 AM.
 */
function setupWeeklyRetentionTrigger(services) {
  const scriptApp =
    services?.ScriptApp || (typeof ScriptApp !== 'undefined' ? ScriptApp : null)
  if (!scriptApp) return
  const triggers = scriptApp.getProjectTriggers() || []
  for (let i = 0; i < triggers.length; i++) {
    if (
      triggers[i].getHandlerFunction() === 'purgeExpiredEmailsByRetentionPolicy'
    ) {
      scriptApp.deleteTrigger(triggers[i])
    }
  }

  scriptApp
    .newTrigger('purgeExpiredEmailsByRetentionPolicy')
    .timeBased()
    .onWeekDay(scriptApp.WeekDay ? scriptApp.WeekDay.SUNDAY : 1)
    .atHour(1)
    .create()

  console.log(
    '[setupWeeklyRetentionTrigger] Established weekly Sunday 1:00 AM retention cleanup trigger.'
  )
}

/**
 * Sets up a daily cloud trigger to run auditEmailClassifications every morning at 6:00 AM.
 */
function setupDailyAuditTrigger(services) {
  const scriptApp =
    services?.ScriptApp || (typeof ScriptApp !== 'undefined' ? ScriptApp : null)
  if (!scriptApp) return
  const triggers = scriptApp.getProjectTriggers() || []
  for (let i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'auditEmailClassifications') {
      scriptApp.deleteTrigger(triggers[i])
    }
  }

  scriptApp
    .newTrigger('auditEmailClassifications')
    .timeBased()
    .everyDays(1)
    .atHour(6)
    .create()

  console.log(
    '[setupDailyAuditTrigger] Established daily 6:00 AM classification audit trigger.'
  )
}

/**
 * Sets up a recurring cloud trigger to run auditEmailClassifications every 4 hours.
 */
function setupFourHourAuditTrigger(services) {
  const scriptApp =
    services?.ScriptApp || (typeof ScriptApp !== 'undefined' ? ScriptApp : null)
  if (!scriptApp) return
  const triggers = scriptApp.getProjectTriggers() || []
  for (let i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'auditEmailClassifications') {
      scriptApp.deleteTrigger(triggers[i])
    }
  }

  scriptApp
    .newTrigger('auditEmailClassifications')
    .timeBased()
    .everyHours(4)
    .create()

  console.log(
    '[setupFourHourAuditTrigger] Established 4-hour classification audit trigger.'
  )
}

/**
 * Clears all active time-driven triggers for this script.
 */
function stopAllTriggers(services) {
  const scriptApp =
    services?.ScriptApp || (typeof ScriptApp !== 'undefined' ? ScriptApp : null)
  if (!scriptApp) return
  const triggers = scriptApp.getProjectTriggers() || []
  for (let i = 0; i < triggers.length; i++) {
    scriptApp.deleteTrigger(triggers[i])
  }
  console.log('[stopAllTriggers] All script triggers removed.')
}

/**
 * Creates an automatic Cloud Trigger that runs email classification every 5 minutes 24/7.
 */
function setupFiveMinuteTrigger(services) {
  const scriptApp =
    services?.ScriptApp || (typeof ScriptApp !== 'undefined' ? ScriptApp : null)
  if (!scriptApp) return
  stopAllTriggers(services)
  scriptApp
    .newTrigger('processEmailsWithAiClassifier')
    .timeBased()
    .everyMinutes(5)
    .create()
  setupWeeklyRetentionTrigger(services)
  setupDailyAuditTrigger(services)
  console.log(
    '[setupFiveMinuteTrigger] Successfully established 5-minute recurring cloud trigger, weekly retention trigger, and daily audit trigger.'
  )
}

/**
 * Decommissioned static filter creation helper (retained as no-op for backward compatibility).
 */
function createGmailFilterRule(_senderEmail, _targetLabelName) {
  console.log(
    '[createGmailFilterRule] Permanent filter auto-creation is permanently decommissioned. No-op.'
  )
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
  '06_Work_Career': [
    'Career_Interviews',
    'Career_DJ',
    'Career_Rachel',
    'Employer',
    'Expenses_Admin',
  ],
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
  'finance/donations': 'Taxes',
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
  'family/correspondence': 'Family_General',
  'family/personal-correspondence': 'Family_General',
  'family/legal': 'Family_General',
  'family/medical': 'Medical_Records',
  'family/medical-records': 'Medical_Records',
  'family/medical-student': 'Medical_Records',
  'family/health-general': 'Medical_Records',
  'family/school-student': 'Students',
  'family/school-charley': 'Students',
  'family/school-toby': 'Students',
  'family/school-tide': 'Students',
  'family/parents': 'Family_General',
  'family/kids/tide': 'Students',
  'family/kids/toby': 'Students',
  'family/kids/david': 'Students',
  'family/kids': 'Students',
  'family/kids/school-tide': 'Students',
  'family/kids/school-toby': 'Students',
  'family/kids/school': 'Students',
  'family/kids/tide-health': 'Medical_Records',
  'family/kids/toby-health': 'Medical_Records',
  'family/activities': 'Activities_Camps',
  'family/camps': 'Activities_Camps',
  'family/sisters': 'Family_General',

  // 05_Tech_Infrastructure
  'tech/infrastructure': 'Hardware_Licenses',
  'tech/cloud': 'NAS_Backups',
  'tech/security': 'Hardware_Licenses',
  'tech/alerts': 'NAS_Backups',
  'tech/alerts-monitoring': 'NAS_Backups',
  'tech/backups': 'NAS_Backups',
  'tech/hardware': 'Hardware_Licenses',
  'tech/hardware-licenses': 'Hardware_Licenses',
  'tech/cloud-gcp': 'NAS_Backups',

  // 06_Work_Career
  'work/general': 'Career_Interviews',
  'work/career': 'Career_Interviews',
  'work/employer': 'Career_Interviews',
  'career/dj': 'Career_DJ',
  'career/rachel': 'Career_Rachel',
  'career/employer': 'Employer',
  'work/notes': 'Career_Interviews',
  'work/expenses': 'Expenses_Admin',
  'work/expenses-admin': 'Expenses_Admin',
  'work/architecture': 'Career_Interviews',

  // 07_Community_NonProfit
  'community/nonprofit': 'Community_BOD',
  'nonprofit/general': 'Community_BOD',
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

/**
 * Enriches email snippet text with eligible attachment filenames so classifiers
 * (deterministic rules and Gemini) have full document context.
 *
 * @param {string} snippet - Raw or truncated body snippet
 * @param {Object} message - GmailMessage or mock
 * @returns {string} Enriched snippet string
 */
function enrichSnippetWithAttachments_(snippet, message) {
  var baseSnippet = (snippet || '').trim()
  if (!message || typeof message.getAttachments !== 'function') {
    return baseSnippet
  }
  if (baseSnippet.indexOf('[Attached:') !== -1) {
    return baseSnippet
  }
  try {
    var atts = message.getAttachments() || []
    var attNames = atts
      .map(function (a) {
        return typeof a.getName === 'function' ? a.getName() : a.name || ''
      })
      .filter(function (name) {
        if (!name || typeof name !== 'string') return false
        var clean = name.trim()
        var dot = clean.lastIndexOf('.')
        var ext = dot > 0 ? clean.slice(dot + 1).toLowerCase() : ''
        var stem =
          dot > 0 ? clean.slice(0, dot).toLowerCase() : clean.toLowerCase()
        if (
          /(logo|banner|header|footer|avatar|badge|icon|button|spacer|pixel|tracking|divider|rating|star|thumb|unnamed|outlook-)/i.test(
            stem
          ) ||
          /(^|[-_.])sig(nature)?([-_.]|$)/i.test(stem) ||
          /^image\d*$/i.test(stem)
        ) {
          return false
        }
        if (
          /^(ics|ical|vcf|vcard|htm|html|css|js|json|xml|dat|p7s|p7m|eml|msg)$/i.test(
            ext
          )
        ) {
          return false
        }
        return true
      })
    if (attNames.length > 0) {
      return (
        (baseSnippet ? baseSnippet + ' ' : '') +
        '[Attached: ' +
        attNames.join(', ') +
        ']'
      )
    }
  } catch {
    // ignore attachment inspection errors
  }
  return baseSnippet
}

function getExistingChildFolder_(parentFolder, folderName) {
  const folders =
    parentFolder && typeof parentFolder.getFoldersByName === 'function'
      ? parentFolder.getFoldersByName(folderName)
      : null
  return folders && typeof folders.hasNext === 'function' && folders.hasNext()
    ? folders.next()
    : null
}

function getOrCreateChildFolder_(parentFolder, folderName, lockService) {
  const existing = getExistingChildFolder_(parentFolder, folderName)
  if (existing) {
    return existing
  }
  const lockSvc =
    lockService || (typeof LockService !== 'undefined' ? LockService : null)
  const lock =
    lockSvc && typeof lockSvc.getScriptLock === 'function'
      ? lockSvc.getScriptLock()
      : null
  let acquired = false
  if (lock && typeof lock.tryLock === 'function') {
    try {
      acquired = lock.tryLock(5000)
    } catch {}
  }
  try {
    return (
      getExistingChildFolder_(parentFolder, folderName) ||
      parentFolder.createFolder(folderName)
    )
  } finally {
    if (acquired && lock && typeof lock.releaseLock === 'function') {
      try {
        lock.releaseLock()
      } catch {
        // Ignore lock release errors
      }
    }
  }
}

function resolveDriveRootContainer_(
  driveApp,
  rootFolderName,
  createIfMissing,
  lockService
) {
  const drive =
    driveApp !== undefined
      ? driveApp
      : typeof DriveApp !== 'undefined'
        ? DriveApp
        : null
  if (!drive) {
    throw new Error('DriveApp service unavailable')
  }

  let root =
    typeof drive.getRootFolder === 'function' ? drive.getRootFolder() : drive

  if (!root || typeof root.getFoldersByName !== 'function') {
    throw new Error('DriveApp service unavailable or invalid root folder')
  }

  const trimmedRootName =
    typeof rootFolderName === 'string' ? rootFolderName.trim() : ''
  if (trimmedRootName) {
    root = createIfMissing
      ? getOrCreateChildFolder_(root, trimmedRootName, lockService)
      : getExistingChildFolder_(root, trimmedRootName)
  }
  return root
}

/**
 * Idempotently traverses or creates the 2-level Drive taxonomy path (Domain / Subfolder),
 * optionally nested under a configured root folder (`DRIVE_ROOT_FOLDER_NAME`).
 *
 * @param {string} canonicalDomain - e.g. "02_Finance_Legal"
 * @param {string} subfolderName - e.g. "Banking"
 * @param {Object} driveApp - GAS DriveApp service (injected)
 * @param {string|Object} [rootFolderNameOrOptions] - Optional Drive container folder name or options ({ rootFolderName, lockService })
 * @returns {Object} Target folder object
 */
function ensureDriveTaxonomyFolder(
  canonicalDomain,
  subfolderName,
  driveApp,
  rootFolderNameOrOptions
) {
  const rootFolderName =
    typeof rootFolderNameOrOptions === 'string'
      ? rootFolderNameOrOptions
      : rootFolderNameOrOptions?.rootFolderName || ''
  const lockService =
    typeof rootFolderNameOrOptions === 'object' && rootFolderNameOrOptions
      ? rootFolderNameOrOptions.lockService ||
        rootFolderNameOrOptions.LockService
      : null
  const root = resolveDriveRootContainer_(
    driveApp,
    rootFolderName,
    true,
    lockService
  )
  const domainFolder = getOrCreateChildFolder_(
    root,
    canonicalDomain,
    lockService
  )
  if (!subfolderName) return domainFolder

  return getOrCreateChildFolder_(domainFolder, subfolderName, lockService)
}

/**
 * Non-mutating lookup of an existing 2-level Drive taxonomy folder.
 * Returns null instead of creating folders when any segment does not exist.
 *
 * @param {string} canonicalDomain - e.g. "02_Finance_Legal"
 * @param {string} subfolderName - e.g. "Banking"
 * @param {Object} driveApp - GAS DriveApp service (injected)
 * @param {string} [rootFolderName] - Optional Drive container folder name
 * @returns {Object|null} Existing target folder or null
 */
function findDriveTaxonomyFolder_(
  canonicalDomain,
  subfolderName,
  driveApp,
  rootFolderName
) {
  const root = resolveDriveRootContainer_(driveApp, rootFolderName, false)
  if (!root) return null
  const domainFolder = getExistingChildFolder_(root, canonicalDomain)
  if (!domainFolder) return null
  if (!subfolderName) return domainFolder
  return getExistingChildFolder_(domainFolder, subfolderName)
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
 * Collects candidate existing Drive files for duplicate comparison, including both
 * exact filename matches (`getFilesByName(fileName)`) and conflict-renamed variants
 * (`stem_<timestamp>.ext`) when `folder.getFiles()` is available.
 *
 * @param {Object} folder - Drive folder
 * @param {string} fileName - Original attachment filename
 * @returns {{ hasNext: function(): boolean, next: function(): Object }} Iterator over candidate files
 */
function collectCandidateDriveFiles_(folder, fileName) {
  const items = []
  const seenRefs = new Set()

  function addFromIterator(iter, filterFn) {
    if (!iter || typeof iter.hasNext !== 'function') return
    while (iter.hasNext()) {
      const f = iter.next()
      if (!f || seenRefs.has(f)) continue
      if (filterFn && !filterFn(f)) continue
      seenRefs.add(f)
      items.push(f)
    }
  }

  if (folder && typeof folder.getFilesByName === 'function') {
    addFromIterator(folder.getFilesByName(fileName))
  }

  if (folder && typeof folder.getFiles === 'function' && fileName) {
    const clean = String(fileName).trim()
    const dotIdx = clean.lastIndexOf('.')
    const stem = (dotIdx > 0 ? clean.slice(0, dotIdx) : clean).toLowerCase()
    const ext = dotIdx > 0 ? clean.slice(dotIdx).toLowerCase() : ''

    addFromIterator(folder.getFiles(), function (f) {
      const fName = (
        typeof f.getName === 'function' ? f.getName() : f.name || ''
      ).toLowerCase()
      if (!fName) return false
      if (fName === clean.toLowerCase()) return true
      return fName.startsWith(stem + '_') && (ext === '' || fName.endsWith(ext))
    })
  }

  let idx = 0
  return {
    hasNext: function () {
      return idx < items.length
    },
    next: function () {
      return items[idx++]
    },
  }
}

/**
 * Finds and returns the first existing file in `existingFiles` that matches
 * `newFileBlob` by size and MD5 content hash, or null if none match.
 *
 * @param {Object} existingFiles - Iterator of Drive files
 * @param {Object} newFileBlob - Blob of incoming file
 * @param {Object} [helperFns] - Optional helper functions ({ getFileHash })
 * @returns {Object|null} Matching Drive file or null
 */
function findMatchingDuplicateFile_(existingFiles, newFileBlob, helperFns) {
  if (
    !existingFiles ||
    typeof existingFiles.hasNext !== 'function' ||
    !newFileBlob
  ) {
    return null
  }
  const hashFn = helperFns?.getFileHash || getFileHash
  const newFileBytes = extractBlobBytes_(newFileBlob)
  const newFileLength = newFileBytes.length
  let newFileHash = null

  while (existingFiles.hasNext()) {
    const existingFile = existingFiles.next()
    if (extractFileSize_(existingFile) !== newFileLength) {
      continue
    }

    if (newFileHash === null) {
      try {
        newFileHash = hashFn(newFileBlob)
      } catch {
        return null
      }
    }

    const existingBlob =
      typeof existingFile.getBlob === 'function'
        ? existingFile.getBlob()
        : existingFile
    if (hashFn(existingBlob) === newFileHash) {
      return existingFile
    }
  }
  return null
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
  return Boolean(
    findMatchingDuplicateFile_(existingFiles, newFileBlob, helperFns)
  )
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
  const existingFiles =
    folder && typeof folder.getFilesByName === 'function'
      ? folder.getFilesByName(fileName)
      : null
  if (
    !existingFiles ||
    typeof existingFiles.hasNext !== 'function' ||
    !existingFiles.hasNext()
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
 * Unzips a canonical .zip archive into a dedicated subfolder within targetFolder.
 * Filters out OS artifacts, checks document eligibility, skips duplicates, and tags files.
 *
 * @param {Folder} targetFolder - Parent Google Drive folder
 * @param {Blob|File} zipBlobOrFile - The zip file or blob to extract
 * @param {Object} [services] - Utilities, DriveApp, getFileHash
 * @param {Object} [metadata] - { canonicalDomain, subfolderName, tagBlock, sourceFileName }
 * @returns {Array} Array of saved file summary objects
 */
function extractZipArchiveToSubfolder(
  targetFolder,
  zipBlobOrFile,
  services,
  metadata
) {
  if (!targetFolder) return []
  const utils =
    services?.Utilities || (typeof Utilities !== 'undefined' ? Utilities : null)
  if (!utils || typeof utils.unzip !== 'function') return []

  let zipBlob = zipBlobOrFile
  let fileName = ''
  if (zipBlobOrFile && typeof zipBlobOrFile.getBlob === 'function') {
    zipBlob = zipBlobOrFile.getBlob()
    fileName =
      typeof zipBlobOrFile.getName === 'function' ? zipBlobOrFile.getName() : ''
  } else if (zipBlobOrFile && typeof zipBlobOrFile.getName === 'function') {
    fileName = zipBlobOrFile.getName()
  }
  if (!fileName && metadata?.sourceFileName) {
    fileName = metadata.sourceFileName
  }
  if (!fileName) fileName = 'archive.zip'

  const zipStem = fileName.replace(/\.zip$/i, '')
  if (!zipStem) return []

  const extractedSummaries = []
  try {
    const unzippedBlobs = utils.unzip(zipBlob)
    if (!unzippedBlobs || unzippedBlobs.length === 0) return []

    const maxEntries = 25
    if (unzippedBlobs.length > maxEntries) {
      console.warn(
        '[extractZipArchiveToSubfolder] Archive "' +
          fileName +
          '" contains ' +
          unzippedBlobs.length +
          ' entries; truncating extraction to first ' +
          maxEntries +
          ' entries.'
      )
    }

    const archiveFolder = getOrCreateChildFolder_(targetFolder, zipStem)
    const extractLimit = Math.min(unzippedBlobs.length, maxEntries)
    const helperFns = {
      getFileHash: services?.getFileHash || getFileHash,
    }

    for (let z = 0; z < extractLimit; z++) {
      const entryBlob = unzippedBlobs[z]
      if (!entryBlob) continue
      const entryName =
        typeof entryBlob.getName === 'function'
          ? entryBlob.getName()
          : 'unnamed'

      const slashIdx = Math.max(
        entryName.lastIndexOf('/'),
        entryName.lastIndexOf('\\')
      )
      const baseEntryName =
        slashIdx !== -1 ? entryName.substring(slashIdx + 1) : entryName

      if (
        !baseEntryName ||
        baseEntryName.charAt(0) === '.' ||
        entryName.indexOf('__MACOSX') !== -1 ||
        baseEntryName.toLowerCase() === 'thumbs.db'
      ) {
        continue
      }

      if (
        typeof isEligibleAttachment === 'function' &&
        !isEligibleAttachment(entryBlob)
      ) {
        console.log(
          '[extractZipArchiveToSubfolder] Skipped ineligible file inside zip: ' +
            baseEntryName
        )
        continue
      }

      const existingCandidates = collectCandidateDriveFiles_(
        archiveFolder,
        baseEntryName
      )

      if (
        typeof isDuplicateAttachment === 'function' &&
        isDuplicateAttachment(existingCandidates, entryBlob, helperFns)
      ) {
        console.log(
          '[extractZipArchiveToSubfolder] Skipped exact duplicate inside zip: ' +
            baseEntryName
        )
        continue
      }

      const safeEntryName = resolveAttachmentName(
        archiveFolder,
        baseEntryName,
        entryBlob,
        services
      )
      if (entryBlob && typeof entryBlob.setName === 'function') {
        entryBlob.setName(safeEntryName)
      }
      const extractedFile = archiveFolder.createFile(entryBlob)
      const extractedId =
        typeof extractedFile.getId === 'function' ? extractedFile.getId() : ''
      const extractedUrl =
        typeof extractedFile.getUrl === 'function'
          ? extractedFile.getUrl()
          : 'https://drive.google.com/file/d/' + extractedId

      if (typeof extractedFile.setDescription === 'function') {
        try {
          const desc =
            (metadata?.tagBlock ? metadata.tagBlock + '\n' : '') +
            'Extracted-From: ' +
            fileName
          extractedFile.setDescription(desc)
        } catch {}
      }

      const cDomain = metadata?.canonicalDomain || ''
      const sFolder = metadata?.subfolderName || ''

      extractedSummaries.push({
        name:
          zipStem +
          '/' +
          (typeof extractedFile.getName === 'function'
            ? extractedFile.getName()
            : safeEntryName),
        url: extractedUrl,
        id: extractedId,
        domain: cDomain,
        subfolder: sFolder ? sFolder + '/' + zipStem : zipStem,
      })

      console.log(
        '[extractZipArchiveToSubfolder] Auto-unzipped: ' +
          (cDomain ? cDomain + '/' : '') +
          (sFolder ? sFolder + '/' : '') +
          zipStem +
          '/' +
          safeEntryName
      )
    }
  } catch (unzipErr) {
    console.warn(
      '[extractZipArchiveToSubfolder] Auto-unzip warning for ' +
        fileName +
        ': ' +
        unzipErr.message
    )
  }

  return extractedSummaries
}

/**
 * Unzips an existing .zip file in Google Drive into a subfolder named after the zip stem.
 *
 * @param {string} fileIdOrName - File ID or file name in targetFolder
 * @param {Folder} targetFolder - Drive folder containing the zip file
 * @param {Object} [services] - { DriveApp, Utilities }
 * @returns {Array} Array of extracted file summaries
 */
function unzipExistingDriveArchive(fileIdOrName, targetFolder, services) {
  const drive =
    services?.DriveApp || (typeof DriveApp !== 'undefined' ? DriveApp : null)
  if (!drive && !targetFolder) {
    console.error(
      '[unzipExistingDriveArchive] DriveApp or targetFolder required.'
    )
    return []
  }

  let zipFile = null
  let parentFolder = targetFolder

  if (targetFolder && typeof targetFolder.getFilesByName === 'function') {
    const files = targetFolder.getFilesByName(fileIdOrName)
    if (files && files.hasNext && files.hasNext()) {
      zipFile = files.next()
    }
  }

  if (!zipFile && drive && typeof drive.getFileById === 'function') {
    try {
      zipFile = drive.getFileById(fileIdOrName)
      if (!parentFolder && typeof zipFile.getParents === 'function') {
        const parents = zipFile.getParents()
        if (parents && parents.hasNext && parents.hasNext()) {
          parentFolder = parents.next()
        }
      }
    } catch {}
  }

  if (!zipFile || !parentFolder) {
    console.error(
      '[unzipExistingDriveArchive] Could not locate zip file: ' + fileIdOrName
    )
    return []
  }

  return extractZipArchiveToSubfolder(parentFolder, zipFile, services, {
    sourceFileName: zipFile.getName(),
  })
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
      driveApp,
      config?.driveRootFolderName
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
  const subject =
    classification?.title ||
    (typeof thread.getFirstMessageSubject === 'function'
      ? thread.getFirstMessageSubject()
      : thread.subject || '')

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
      const existingFiles = collectCandidateDriveFiles_(targetFolder, fileName)

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
            : thread.id || '') +
          (subject ? '\nEmail-Subject: ' + subject : '')

        if (typeof file.setDescription === 'function') {
          try {
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

        // Auto-Unzip Enhancement for .zip archives
        if (fileName.toLowerCase().endsWith('.zip')) {
          const extractedFiles = extractZipArchiveToSubfolder(
            targetFolder,
            newFileBlob,
            services,
            {
              canonicalDomain: canonicalDomain,
              subfolderName: subfolderName,
              tagBlock: tagBlock,
              sourceFileName: fileName,
            }
          )
          if (extractedFiles && extractedFiles.length > 0) {
            for (let ef = 0; ef < extractedFiles.length; ef++) {
              savedFiles.push(extractedFiles[ef])
            }
          }
        }
      } catch (saveErr) {
        console.error(
          '[persistCanonicalAttachmentsToDrive] Error saving file ' +
            finalName +
            ': ' +
            saveErr.message
        )
        Object.defineProperty(savedFiles, 'hadErrors', {
          value: true,
          enumerable: false,
          configurable: true,
        })
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
    if (
      lName.startsWith('community/') ||
      lName.startsWith('projects/') ||
      lName.startsWith('nonprofit/')
    )
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

  const cfg = resolveEffectiveConfig_(config)
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

  const defaultCanonicalQuery =
    'has:attachment (label:01_Household OR label:02_Finance_Legal OR label:03_Vehicles OR label:04_Family_Health OR label:05_Tech_Infrastructure OR label:06_Work_Career OR label:07_Community_NonProfit OR label:Household OR label:Finance OR label:Vehicles OR label:Family OR label:Tech OR label:Work OR label:Community OR label:Projects OR label:NonProfit)'
  const searchQuery = opts.query || defaultCanonicalQuery

  let threads = []
  if (typeof gmail.search === 'function') {
    threads = sortThreadsByLastMessageDate_(
      gmail.search(searchQuery, 0, maxThreads) || []
    )
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

    const msgs =
      typeof thread.getMessages === 'function'
        ? thread.getMessages()
        : thread.messages || []
    const eligibleAtts = []

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
        eligibleAtts.push(att)
      })
    })

    if (eligibleAtts.length === 0) {
      continue
    }

    const folderKey = `${canonicalDomain}::${subfolderName}`
    let targetFolder = folderCache[folderKey]
    if (targetFolder === undefined) {
      try {
        targetFolder = isDryRun
          ? findDriveTaxonomyFolder_(
              canonicalDomain,
              subfolderName,
              drive,
              cfg.driveRootFolderName
            )
          : ensureDriveTaxonomyFolder(
              canonicalDomain,
              subfolderName,
              drive,
              cfg.driveRootFolderName
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

    report.threadsWithEligibleAttachments++

    eligibleAtts.forEach((att) => {
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

      const existingFiles = targetFolder
        ? collectCandidateDriveFiles_(targetFolder, fileName)
        : null
      const helperFns = {
        getFileHash: getFileHash,
        Utilities: utils,
      }

      const foundFile = findMatchingDuplicateFile_(
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

      if (foundFile) {
        const desc =
          typeof foundFile.getDescription === 'function'
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
          if (!isDryRun && typeof foundFile.setDescription === 'function') {
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
        if (!isDryRun && targetFolder) {
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
  }

  return report
}

/**
 * Convenience runner for dry-run historical attachment audit.
 */
function runDryRunAttachmentAudit(options, config, services) {
  const opts = Object.assign({ dryRun: true, maxThreads: 50 }, options || {})
  const report = auditAndBackfillCanonicalAttachments(opts, config, services)

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
  const opts = Object.assign({ dryRun: false, maxThreads: 50 }, options || {})
  return auditAndBackfillCanonicalAttachments(opts, config, services)
}

/**
 * Detects whether a first argument passed to a trigger handler is a Google Apps Script
 * time-driven event object rather than a classifier configuration object.
 *
 * @param {*} obj - Candidate argument
 * @returns {boolean} True if obj is a GAS trigger event payload
 */
function isTriggerEventObject_(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return false
  }
  const hasClassifierConfigKey =
    'geminiApiKey' in obj ||
    'canonicalDomains' in obj ||
    'unprocessedQuery' in obj ||
    'processedLabel' in obj ||
    'auditLookbackDays' in obj ||
    'auditDigestEmail' in obj ||
    'userAccountEmail' in obj ||
    'driveApp' in obj
  if (hasClassifierConfigKey) {
    return false
  }
  return (
    'triggerUid' in obj ||
    'authMode' in obj ||
    ('year' in obj && 'month' in obj && 'hour' in obj)
  )
}

/**
 * Resolves the effective classifier configuration, ignoring GAS time-driven
 * trigger event objects when functions are invoked directly by ScriptApp triggers.
 *
 * @param {Object} [customConfig] - Optional custom config or trigger event object
 * @returns {Object} Effective configuration
 */
function resolveEffectiveConfig_(customConfig) {
  if (
    customConfig &&
    typeof customConfig === 'object' &&
    !isTriggerEventObject_(customConfig)
  ) {
    return customConfig
  }
  return typeof getAiClassifierConfig === 'function'
    ? getAiClassifierConfig()
    : {}
}

/**
 * Extracts a numeric timestamp (ms) from a Gmail thread for deterministic sorting.
 *
 * @param {Object} thread - GmailThread or mock object
 * @returns {number} Epoch milliseconds or 0 if unavailable
 */
function getThreadLastMessageTimestamp_(thread) {
  if (!thread || typeof thread !== 'object') return 0
  try {
    const d =
      typeof thread.getLastMessageDate === 'function'
        ? thread.getLastMessageDate()
        : thread.lastMessageDate
    if (d instanceof Date && !Number.isNaN(d.getTime())) return d.getTime()
    if (typeof d === 'number' && Number.isFinite(d)) return d
    if (typeof d === 'string') {
      const parsed = Date.parse(d)
      if (!Number.isNaN(parsed)) return parsed
    }
  } catch {
    // Non-blocking fallback
  }
  return 0
}

/**
 * Sorts an array of Gmail threads by last-message date (newest first),
 * preserving original order when timestamps are equal or absent.
 *
 * @param {Array} threads - Array of GmailThread objects
 * @returns {Array} Sorted shallow copy of threads
 */
function sortThreadsByLastMessageDate_(threads) {
  if (!Array.isArray(threads) || threads.length <= 1) {
    return Array.isArray(threads) ? threads.slice() : []
  }
  return threads
    .map(function (thread, index) {
      return {
        thread: thread,
        index: index,
        ts: getThreadLastMessageTimestamp_(thread),
      }
    })
    .sort(function (a, b) {
      if (b.ts !== a.ts) {
        return b.ts - a.ts
      }
      return a.index - b.index
    })
    .map(function (entry) {
      return entry.thread
    })
}

/**
 * Verifies that a candidate Drive file in `oldFolder` actually belongs to the
 * thread attachment being relocated (`Thread-ID` description match or size/hash match),
 * preventing unrelated files that share a generic filename (e.g. `invoice.pdf`) from being moved.
 *
 * @param {Object} fileCandidate - Drive file object
 * @param {Object} att - Gmail attachment object
 * @param {string} threadId - Current Gmail thread ID
 * @param {Object} [helperFns] - Optional helper functions ({ getFileHash })
 * @returns {boolean} True if fileCandidate matches the thread attachment
 */
function doesDriveFileMatchThreadAttachment_(
  fileCandidate,
  att,
  threadId,
  helperFns
) {
  if (!fileCandidate || !att) return false
  const desc =
    typeof fileCandidate.getDescription === 'function'
      ? fileCandidate.getDescription() || ''
      : fileCandidate.description || ''
  if (desc && desc.indexOf('Thread-ID:') !== -1) {
    return Boolean(threadId) && desc.indexOf('Thread-ID: ' + threadId) !== -1
  }

  const candidateSize = extractFileSize_(fileCandidate)
  const attSize = extractFileSize_(att) || extractBlobBytes_(att).length
  if (candidateSize > 0 && attSize > 0 && candidateSize !== attSize) {
    return false
  }

  const hashFn = (helperFns && helperFns.getFileHash) || getFileHash
  const candidateBlob =
    typeof fileCandidate.getBlob === 'function'
      ? fileCandidate.getBlob()
      : fileCandidate
  const attBlob = typeof att.copyBlob === 'function' ? att.copyBlob() : att
  const candidateHash = hashFn(candidateBlob)
  const attHash = hashFn(attBlob)
  if (candidateHash && attHash) {
    return candidateHash === attHash
  }

  return true
}

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
  const opts = Object.assign(
    { maxThreads: 20, dryRun: false, timeBudgetMs: 240000 },
    options || {}
  )
  const cfg = resolveEffectiveConfig_(config)
  const gmail =
    (services && services.GmailApp) ||
    (typeof GmailApp !== 'undefined' ? GmailApp : null)
  const classifyFn =
    (services && services.classifyFn) ||
    function (s, sub, sn, c) {
      return classifyWithGemini(s, sub, sn, c, services)
    }

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

  const rawThreads = gmail.search(searchQuery, 0, opts.maxThreads) || []
  const threads = sortThreadsByLastMessageDate_(rawThreads)
  console.log(
    '[reclassifyThreadsByQuery] Found ' +
      threads.length +
      ' thread(s) matching query.'
  )

  const results = []
  const startTime = Date.now()
  const timeBudgetMs = opts.timeBudgetMs || 240000

  for (let i = 0; i < threads.length; i++) {
    if (Date.now() - startTime > timeBudgetMs) {
      console.warn(
        '[reclassifyThreadsByQuery] Execution safety ceiling reached (' +
          Math.round((Date.now() - startTime) / 1000) +
          's); completing batch cleanly.'
      )
      break
    }

    const thread = threads[i]
    const threadId =
      typeof thread.getId === 'function'
        ? thread.getId()
        : thread.id || String(i)
    const msgs =
      typeof thread.getMessages === 'function' ? thread.getMessages() : []
    if (!msgs || msgs.length === 0) continue
    const firstMessage = msgs[0]
    const sender =
      typeof firstMessage.getFrom === 'function' ? firstMessage.getFrom() : ''
    const subject =
      typeof firstMessage.getSubject === 'function'
        ? firstMessage.getSubject()
        : ''
    let snippet =
      typeof firstMessage.getPlainBody === 'function'
        ? firstMessage.getPlainBody().substring(0, 500)
        : ''
    snippet = enrichSnippetWithAttachments_(snippet, firstMessage)

    let rawLabels = []
    if (typeof thread.getLabels === 'function') {
      const labelObjs = thread.getLabels() || []
      rawLabels = labelObjs.map(function (l) {
        return typeof l.getName === 'function' ? l.getName() : String(l)
      })
    }

    let classification = null
    try {
      classification =
        deterministicRuleClassify_(sender, subject, snippet, thread, cfg) ||
        classifyFn(sender, subject, snippet, cfg)
    } catch (e) {
      console.warn(
        '[reclassifyThreadsByQuery] Classifier exception: ' + e.message
      )
    }
    if (!classification) continue
    let oldDomain = resolveCanonicalDomainFromLabels(
      rawLabels,
      cfg.canonicalDomains
    )
    if (!oldDomain) {
      const oldCanonical = rawLabels.filter(function (l) {
        return (
          (cfg.canonicalDomains || []).indexOf(l) !== -1 || /^0[1-7]_/.test(l)
        )
      })
      oldDomain = oldCanonical.length > 0 ? oldCanonical[0] : null
    }
    const oldSubLabel =
      rawLabels.find(function (l) {
        return (
          l.indexOf('/') !== -1 &&
          l !== oldDomain &&
          l.indexOf('Archives') === -1 &&
          l.indexOf('Retention/') === -1
        )
      }) || ''

    const newDomain =
      classification.canonicalDomain || classification.canonical_label
    const newSubLabel = classification.subLabel || ''
    const tldChanged = oldDomain && newDomain && oldDomain !== newDomain

    const attachmentsMoved = []
    let attachmentsSaved = []

    if (!opts.dryRun) {
      cleanConflictingLabels(
        thread,
        classification.canonicalDomain,
        classification.subLabel,
        cfg
      )
      let primaryTag = classification.subLabel
      if (!primaryTag || isRootDomainLabel(primaryTag)) {
        const domainKey =
          classification.canonicalDomain || classification.canonical_label
        primaryTag =
          (domainKey && DEFAULT_DOMAIN_SUBLABEL_MAP[domainKey]) ||
          domainKey ||
          null
      }
      if (primaryTag && typeof thread.addLabel === 'function') {
        const targetLabel = ensureGmailLabel(primaryTag, gmail)
        thread.addLabel(targetLabel)
      }
      if (
        classification.category &&
        classification.category !== 'Primary' &&
        classification.action !== 'trash'
      ) {
        classification.action = 'archive'
      }
      if (classification.category && classification.action !== 'trash') {
        setGmailCategoryTab(thread, classification.category)
      }

      const userSent = isThreadSentOrRepliedByUser(thread, cfg.userAccountEmail)
      const requestedDestructive =
        classification.action === 'archive' || classification.action === 'trash'
      const destructiveOk = isDestructiveActionAllowed_(classification)

      if (requestedDestructive && !userSent && destructiveOk) {
        if (
          classification.action === 'trash' &&
          typeof thread.moveToTrash === 'function'
        ) {
          thread.moveToTrash()
        } else if (
          classification.action === 'archive' &&
          typeof thread.moveToArchive === 'function'
        ) {
          thread.moveToArchive()
        }
      }

      if (cfg.processedLabel && typeof thread.addLabel === 'function') {
        const processedLabel = ensureGmailLabel(cfg.processedLabel, gmail)
        thread.addLabel(processedLabel)
      }

      // Drive attachment relocation & backfill
      const drive =
        (services && services.DriveApp) ||
        (typeof DriveApp !== 'undefined' ? DriveApp : null)
      if (drive && isCanonicalClassification(classification, cfg)) {
        const oldSubfolder = oldDomain
          ? resolveTaxonomySubfolderName(oldDomain, oldSubLabel)
          : null
        const newSubfolder = resolveTaxonomySubfolderName(
          newDomain,
          newSubLabel
        )

        // Relocate existing attachments if folder path changed
        if (
          oldDomain &&
          oldSubfolder &&
          (oldDomain !== newDomain || oldSubfolder !== newSubfolder)
        ) {
          try {
            const oldFolder =
              findDriveTaxonomyFolder_(
                oldDomain,
                oldSubfolder,
                drive,
                cfg.driveRootFolderName
              ) ||
              ensureDriveTaxonomyFolder(
                oldDomain,
                oldSubfolder,
                drive,
                cfg.driveRootFolderName
              )
            const newFolder = ensureDriveTaxonomyFolder(
              newDomain,
              newSubfolder,
              drive,
              cfg.driveRootFolderName
            )
            const helperFns = {
              getFileHash: services?.getFileHash || getFileHash,
            }

            msgs.forEach(function (msg) {
              const atts = getMessageAttachments_(msg)
              atts.forEach(function (att) {
                if (!isEligibleAttachment(att)) return
                const attName =
                  typeof att.getName === 'function' ? att.getName() : ''
                if (!attName || !oldFolder) return

                const existingFiles = collectCandidateDriveFiles_(
                  oldFolder,
                  attName
                )
                while (
                  existingFiles &&
                  typeof existingFiles.hasNext === 'function' &&
                  existingFiles.hasNext()
                ) {
                  const fileToMove = existingFiles.next()
                  if (
                    typeof fileToMove.moveTo === 'function' &&
                    doesDriveFileMatchThreadAttachment_(
                      fileToMove,
                      att,
                      threadId,
                      helperFns
                    )
                  ) {
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
                    break
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
        const saved = persistCanonicalAttachmentsToDrive(
          thread,
          classification,
          cfg,
          {
            DriveApp: drive,
            Utilities:
              services && services.Utilities
                ? services.Utilities
                : typeof Utilities !== 'undefined'
                  ? Utilities
                  : null,
          }
        )
        if (saved && saved.length > 0) {
          attachmentsSaved = saved
        }
      }
    }

    const labelChanged = oldDomain !== newDomain || oldSubLabel !== newSubLabel
    const summary = {
      threadId: threadId,
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
 * Automatically identifies career/employment emails from the past 14 days that were
 * missed or prematurely labeled 'Processed' without receiving a canonical career tag.
 * Reverts 'Processed' and applies 'AI/Needs-Retry' to durably queue them for classification.
 */
function revertAndQueueMissedCareerEmails(gmailApp, config) {
  const gmail = gmailApp || (typeof GmailApp !== 'undefined' ? GmailApp : null)
  if (!gmail || typeof gmail.search !== 'function') return []

  const cfg = resolveEffectiveConfig_(config)
  const retryLabelName = cfg.retryLabel || 'AI/Needs-Retry'
  const processedLabelName = cfg.processedLabel || 'Processed'

  const retryLabel = ensureGmailLabel(retryLabelName, gmail)
  const processedLabel = ensureGmailLabel(processedLabelName, gmail)

  const recoverySearch =
    'newer_than:14d (subject:"Employment Agreement" OR subject:"Employment Contract" OR subject:"Offer Letter" OR subject:"PwC" OR subject:"KPMG")'

  const modifiedThreadIds = []
  try {
    const rawThreads = gmail.search(recoverySearch, 0, 20) || []
    const threads = sortThreadsByLastMessageDate_(rawThreads)
    for (let i = 0; i < threads.length; i++) {
      const thread = threads[i]
      if (isThreadSentOrRepliedByUser(thread, cfg.userAccountEmail)) {
        continue
      }
      let labels = []
      if (typeof thread.getLabels === 'function') {
        const lObjs = thread.getLabels() || []
        labels = lObjs.map(function (l) {
          return typeof l.getName === 'function' ? l.getName() : String(l)
        })
      }
      const hasCareerTag =
        labels.indexOf('06_Work_Career') !== -1 ||
        labels.indexOf('Work/Career') !== -1 ||
        labels.indexOf('Career/DJ') !== -1 ||
        labels.indexOf('Career/Rachel') !== -1 ||
        labels.indexOf('Career_Interviews') !== -1

      if (!hasCareerTag) {
        let changed = false
        if (processedLabel && labels.indexOf(processedLabelName) !== -1) {
          try {
            thread.removeLabel(processedLabel)
            changed = true
          } catch {}
        }
        if (retryLabel && labels.indexOf(retryLabelName) === -1) {
          try {
            thread.addLabel(retryLabel)
            changed = true
          } catch {}
        }
        if (changed) {
          const tId =
            typeof thread.getId === 'function' ? thread.getId() : String(i)
          modifiedThreadIds.push(tId)
          console.log(
            '[revertAndQueueMissedCareerEmails] Reverted Processed and queued thread: ' +
              tId
          )
        }
      }
    }
  } catch (err) {
    console.warn(
      '[revertAndQueueMissedCareerEmails] Search or labeling error:',
      err.message
    )
  }
  return modifiedThreadIds
}

/**
 * Convenience runner for re-evaluating recent emails from the past 14 days
 * or emails tagged with AI/Needs-Retry that may have been missed.
 */
function runMissedEmailsSweep(config, services) {
  const gmail =
    (services && services.GmailApp) ||
    (typeof GmailApp !== 'undefined' ? GmailApp : null)
  const cfg = resolveEffectiveConfig_(config)
  if (typeof revertAndQueueMissedCareerEmails === 'function') {
    revertAndQueueMissedCareerEmails(gmail, cfg)
  }

  // 1. Direct Priority Recovery: First sweep and reclassify career & employment contract emails
  const careerQuery =
    'newer_than:14d (subject:"Employment Agreement" OR subject:"Employment Contract" OR subject:"Offer Letter" OR subject:"PwC" OR subject:"KPMG")'
  console.log('[runMissedEmailsSweep] Priority career sweep: ' + careerQuery)
  reclassifyThreadsByQuery(
    careerQuery,
    { maxThreads: 20, dryRun: false },
    cfg,
    services
  )

  // 2. Secondary General Recovery: Sweep other unclassified threads
  const query =
    'label:AI/Needs-Retry OR (newer_than:14d -label:Processed -label:AI/Manual-Review)'
  console.log('[runMissedEmailsSweep] Sweeping query: ' + query)
  return reclassifyThreadsByQuery(
    query,
    { maxThreads: 30, dryRun: false },
    cfg,
    services
  )
}

/**
 * Convenience runner to audit historical threads matching a query in dry-run mode.
 */
function runRealignmentAudit(query, options, config, services) {
  const gmail =
    (services && services.GmailApp) ||
    (typeof GmailApp !== 'undefined' ? GmailApp : null)
  let searchQuery = query

  if (!searchQuery && gmail && typeof gmail.getUserLabels === 'function') {
    try {
      const allLabels = gmail.getUserLabels() || []
      const matchedLabels = allLabels
        .filter(function (l) {
          const name = typeof l.getName === 'function' ? l.getName() : String(l)
          return /sister/i.test(name)
        })
        .map(function (l) {
          const name = typeof l.getName === 'function' ? l.getName() : String(l)
          return 'label:"' + name + '"'
        })

      console.log(
        '[runRealignmentAudit] Discovered sister labels in Gmail: ' +
          JSON.stringify(matchedLabels)
      )

      const queryParts = matchedLabels.slice()
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
  const opts = Object.assign({ maxThreads: 50, dryRun: false }, options || {})
  return reclassifyThreadsByQuery(
    'in:inbox is:unread -is:starred -from:me',
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
    const primaryEmail = (userEmail || '').toLowerCase()
    if (!primaryEmail || !thread || typeof thread.getMessages !== 'function') {
      return false
    }
    const messages = thread.getMessages() || []
    for (let m = 0; m < messages.length; m++) {
      const msg = messages[m]
      if (!msg || typeof msg.getFrom !== 'function') continue
      const rawFrom = msg.getFrom()
      const fromAddr = (
        rawFrom && typeof rawFrom === 'string' ? rawFrom : ''
      ).toLowerCase()
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

/**
 * Automatically purges emails older than their category retention policy (2 years for Promotions/Social/Forums).
 * Core household domains (01_Household - 07_Community_NonProfit), Primary, Updates, Starred, and User Replied/Sent threads are 100% EXEMPT.
 */
function purgeExpiredEmailsByRetentionPolicy(customConfig, customServices) {
  console.log(
    '[purgeExpiredEmailsByRetentionPolicy] Starting weekly category retention cleanup...'
  )
  const services = customServices || {}
  const config = resolveEffectiveConfig_(customConfig)

  const gmail =
    services.GmailApp || (typeof GmailApp !== 'undefined' ? GmailApp : null)
  if (!gmail) {
    console.error(
      '[purgeExpiredEmailsByRetentionPolicy] GmailApp service is missing.'
    )
    return { trashedCount: 0, exemptedCount: 0 }
  }

  // Explicitly exclude threads sent by user or containing user replies
  const retentionQuery =
    '(category:promotions OR category:social OR category:forums) older_than:2y -is:starred -from:me'

  const coreDomainLabels = config.canonicalDomains || [
    '01_Household',
    '02_Finance_Legal',
    '03_Vehicles',
    '04_Family_Health',
    '05_Tech_Infrastructure',
    '06_Work_Career',
    '07_Community_NonProfit',
  ]
  const pageSize = 50
  const maxPages = 5
  let trashedCount = 0
  let exemptedCount = 0
  let totalFound = 0

  for (let page = 0; page < maxPages; page++) {
    const offset = page * pageSize
    const rawPage = gmail.search(retentionQuery, offset, pageSize) || []
    const threads = sortThreadsByLastMessageDate_(rawPage)
    if (page === 0) {
      console.log(
        '[purgeExpiredEmailsByRetentionPolicy] Found ' +
          threads.length +
          ' expired thread(s) matching 2-year retention query.'
      )
      if (threads.length === 0) {
        return { trashedCount: 0, exemptedCount: 0 }
      }
    } else if (threads.length === 0) {
      break
    }

    totalFound += threads.length

    for (let i = 0; i < threads.length; i++) {
      try {
        const thread = threads[i]
        if (!thread) continue
        const labels =
          typeof thread.getLabels === 'function' ? thread.getLabels() || [] : []
        let isExempt = false

        // Safety Shield 1: Check if thread contains any Core Household Domain label
        // OR any classifier sub-label.
        for (let l = 0; l < labels.length; l++) {
          const labelName =
            typeof labels[l].getName === 'function'
              ? labels[l].getName()
              : String(labels[l])
          for (let cd = 0; cd < coreDomainLabels.length; cd++) {
            if (labelName.indexOf(coreDomainLabels[cd]) !== -1) {
              isExempt = true
              break
            }
          }
          if (isExempt) break
          if (
            labelName.indexOf('/') !== -1 &&
            labelName.indexOf('Retention/') !== 0
          ) {
            isExempt = true
            break
          }
        }

        // Safety Shield 2: Check if user sent a message or replied in this thread
        if (!isExempt) {
          if (isThreadSentOrRepliedByUser(thread, config.userAccountEmail)) {
            isExempt = true
          }
        }

        if (!isExempt) {
          if (typeof thread.moveToTrash === 'function') {
            thread.moveToTrash()
          }
          trashedCount++
        } else {
          exemptedCount++
          const subj =
            typeof thread.getFirstMessageSubject === 'function'
              ? thread.getFirstMessageSubject()
              : thread.getId()
          console.log(
            '[purgeExpiredEmailsByRetentionPolicy] Exempted thread from trash (contains core domain label or user reply): ' +
              subj
          )
        }
      } catch (err) {
        console.warn(
          '[purgeExpiredEmailsByRetentionPolicy] Error processing thread: ' +
            err.message
        )
      }
    }

    if (rawPage.length < pageSize) {
      break
    }
  }

  console.log(
    '[purgeExpiredEmailsByRetentionPolicy] Retention cleanup complete. Scanned ' +
      totalFound +
      ' thread(s); moved ' +
      trashedCount +
      ' expired thread(s) to Trash.'
  )
  return { trashedCount: trashedCount, exemptedCount: exemptedCount }
}

const DESTRUCTIVE_CONFIDENCE_MIN = 0.85

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
  const confidence = classification.confidence
  if (!Number.isFinite(confidence)) {
    return false
  }
  return confidence >= DESTRUCTIVE_CONFIDENCE_MIN
}

const GMAIL_AI_CLASSIFIER_VERSION = 'v1.8.0-drive-taxonomy-attachments'

/**
 * Main entry point for Gemini AI-Powered Semantic Email Classification and Auto-Filter Engine.
 * Supports injected config and services for testing and headless execution.
 *
 * @param {Object} [customConfig] - Optional override config
 * @param {Object} [customServices] - Optional injected services
 */
function processEmailsWithAiClassifier(customConfig, customServices) {
  const services = customServices || {}
  const lockService =
    services.LockService ||
    (typeof LockService !== 'undefined' ? LockService : null)
  let lock = null
  if (lockService && typeof lockService.getScriptLock === 'function') {
    lock = lockService.getScriptLock()
    let hasLock = false
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
    const hasExplicitCustomConfig = Boolean(
      customConfig && !isTriggerEventObject_(customConfig)
    )
    const config = resolveEffectiveConfig_(customConfig)

    if (!config.geminiApiKey) {
      console.error(
        '[processEmailsWithAiClassifier] GEMINI_API_KEY ScriptProperty is missing.'
      )
      return
    }

    const gmail =
      services.GmailApp || (typeof GmailApp !== 'undefined' ? GmailApp : null)
    if (!gmail) {
      console.error(
        '[processEmailsWithAiClassifier] GmailApp service is missing.'
      )
      return
    }

    if (!hasExplicitCustomConfig) {
      revertAndQueueMissedCareerEmails(gmail, config)
    }

    const rawPrimaryThreads = gmail.search(config.unprocessedQuery, 0, 10) || []
    let threads = sortThreadsByLastMessageDate_(rawPrimaryThreads)
    console.log(
      '[processEmailsWithAiClassifier] Found ' +
        threads.length +
        ' unprocessed thread(s).'
    )

    const retryLabelName = config.retryLabel || 'AI/Needs-Retry'
    const manualReviewLabelName = config.manualReviewLabel || 'AI/Manual-Review'

    let isSecondarySweep = false
    if (threads.length === 0) {
      // Secondary sweep: Look for unread unstarred inbox threads to realign non-Primary items
      const sweepQuery =
        'in:inbox is:unread -is:starred -from:me -label:' +
        manualReviewLabelName
      const rawSweepThreads = gmail.search(sweepQuery, 0, 15) || []
      threads = sortThreadsByLastMessageDate_(rawSweepThreads)
      isSecondarySweep = true
      console.log(
        '[processEmailsWithAiClassifier] Secondary sweep found ' +
          threads.length +
          ' unread inbox thread(s) for realignment.'
      )
      if (threads.length === 0) {
        return
      }
    }

    const processedLabel = ensureGmailLabel(
      config.processedLabel,
      gmail,
      services.Gmail
    )
    const retryLabel = ensureGmailLabel(retryLabelName, gmail, services.Gmail)
    const manualReviewLabel = ensureGmailLabel(
      manualReviewLabelName,
      gmail,
      services.Gmail
    )

    const props =
      (services.PropertiesService &&
      typeof services.PropertiesService.getScriptProperties === 'function'
        ? services.PropertiesService.getScriptProperties()
        : null) ||
      services.properties ||
      (typeof PropertiesService !== 'undefined' &&
      typeof PropertiesService.getScriptProperties === 'function'
        ? PropertiesService.getScriptProperties()
        : null)

    const cache =
      (services.CacheService &&
      typeof services.CacheService.getScriptCache === 'function'
        ? services.CacheService.getScriptCache()
        : null) ||
      services.cache ||
      (typeof CacheService !== 'undefined' &&
      typeof CacheService.getScriptCache === 'function'
        ? CacheService.getScriptCache()
        : null)

    const startTime = Date.now()
    let consecutiveRemoteFailures = 0
    let remoteQuotaExhausted = false

    if (isCircuitBreakerOpen(props)) {
      const untilMs = Number.parseInt(
        props.getProperty('GEMINI_BACKOFF_UNTIL'),
        10
      )
      console.warn(
        '[processEmailsWithAiClassifier] Circuit breaker is OPEN until ' +
          (Number.isNaN(untilMs)
            ? 'unknown'
            : new Date(untilMs).toISOString()) +
          '; skipping remote AI calls for this execution.'
      )
      remoteQuotaExhausted = true
    }

    for (let i = 0; i < threads.length; i++) {
      if (Date.now() - startTime > 270000) {
        console.warn(
          '[processEmailsWithAiClassifier] Safety time budget reached (270s); stopping batch gracefully.'
        )
        break
      }
      const thread = threads[i]
      const messages =
        typeof thread.getMessages === 'function' ? thread.getMessages() : []
      if (!messages || messages.length === 0) continue
      const firstMessage = messages[0]
      const sender =
        typeof firstMessage.getFrom === 'function'
          ? firstMessage.getFrom()
          : firstMessage.from || ''
      const subject =
        typeof firstMessage.getSubject === 'function'
          ? firstMessage.getSubject()
          : firstMessage.subject || ''
      let snippet =
        typeof firstMessage.getPlainBody === 'function'
          ? firstMessage.getPlainBody().substring(0, 500)
          : firstMessage.snippet || ''
      snippet = enrichSnippetWithAttachments_(snippet, firstMessage)

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

      let threadLabels = []
      if (typeof thread.getLabels === 'function') {
        try {
          const lList = thread.getLabels() || []
          threadLabels = lList.map(function (l) {
            return typeof l.getName === 'function' ? l.getName() : String(l)
          })
        } catch {}
      }
      const isAlreadyProcessed =
        config.processedLabel &&
        threadLabels.indexOf(config.processedLabel) !== -1
      const isManualReview = threadLabels.indexOf(manualReviewLabelName) !== -1

      let classification = deterministicRuleClassify_(
        sender,
        subject,
        snippet,
        thread,
        config
      )
      let usedRemoteApi = false
      if (
        !classification &&
        !remoteQuotaExhausted &&
        !isManualReview &&
        (!isSecondarySweep || !isAlreadyProcessed)
      ) {
        const classifyFn =
          services.classifyFn ||
          function (s, sub, sn, cfg) {
            return classifyWithGemini(s, sub, sn, cfg, services)
          }
        classification = classifyFn(sender, subject, snippet, config)
        usedRemoteApi = true
        if (!classification) {
          consecutiveRemoteFailures++
          recordCircuitBreakerFailure(props)
          if (consecutiveRemoteFailures >= 2) {
            console.warn(
              '[processEmailsWithAiClassifier] Multiple consecutive remote API failures detected; disabling remote API for remainder of batch to preserve execution budget.'
            )
            remoteQuotaExhausted = true
          }
        } else {
          consecutiveRemoteFailures = 0
          recordCircuitBreakerSuccess(props)
        }
      }
      if (classification) {
        cleanConflictingLabels(
          thread,
          classification.canonicalDomain,
          classification.subLabel,
          config
        )

        let primaryTag = classification.subLabel
        if (!primaryTag || isRootDomainLabel(primaryTag)) {
          const domainKey =
            classification.canonicalDomain || classification.canonical_label
          primaryTag =
            (domainKey && DEFAULT_DOMAIN_SUBLABEL_MAP[domainKey]) ||
            domainKey ||
            null
        }
        if (primaryTag) {
          const targetLabel = ensureGmailLabel(
            primaryTag,
            gmail,
            services.Gmail
          )
          if (targetLabel) {
            thread.addLabel(targetLabel)
          }

          const savedAttachments = persistCanonicalAttachmentsToDrive(
            thread,
            classification,
            config,
            services
          )
          if (savedAttachments && savedAttachments.hadErrors) {
            const attRetryCount = incrementThreadRetryCount_(thread, cache)
            if (attRetryCount >= 5 && manualReviewLabel) {
              thread.addLabel(manualReviewLabel)
            } else if (retryLabel) {
              thread.addLabel(retryLabel)
            }
            console.warn(
              '[processEmailsWithAiClassifier] Attachment persistence failed; queued thread for retry without marking Processed.'
            )
            continue
          }

          if (config.githubToken) {
            try {
              const notePath = getNotePathForDomain(
                classification.canonicalDomain,
                classification.subLabel
              )
              const utils =
                services.Utilities ||
                (typeof Utilities !== 'undefined' ? Utilities : null)
              if (notePath && utils) {
                const msgDate =
                  typeof firstMessage.getDate === 'function'
                    ? firstMessage.getDate()
                    : new Date()
                const dateStr = utils.formatDate(msgDate, 'GMT', 'yyyy-MM-dd')
                const entryMd = formatProgressiveDisclosureEntry(
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
                  'feat(ingestion): ' + subject,
                  services
                )
              }
            } catch (ghErr) {
              console.warn(
                '[processEmailsWithAiClassifier] Non-blocking GitHub sync error for ' +
                  subject +
                  ': ' +
                  ghErr.message
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

        const userSent = isThreadSentOrRepliedByUser(
          thread,
          config.userAccountEmail
        )
        const requestedDestructive =
          classification.action === 'trash' ||
          classification.action === 'archive'
        const destructiveOk = isDestructiveActionAllowed_(classification)
        if (requestedDestructive && !userSent && !destructiveOk) {
          console.warn(
            '[processEmailsWithAiClassifier] Shield: Skipped destructive action "' +
              classification.action +
              '" (low/invalid confidence ' +
              classification.confidence +
              '); preserved thread in INBOX.'
          )
        } else if (requestedDestructive && !userSent) {
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

        // Remove retryLabel if present
        if (retryLabel && threadLabels.indexOf(retryLabelName) !== -1) {
          try {
            thread.removeLabel(retryLabel)
            console.log(
              '[processEmailsWithAiClassifier] Removed retry label from successfully classified thread.'
            )
          } catch (rErr) {
            console.warn(
              '[processEmailsWithAiClassifier] Failed to remove retry label:',
              rErr.message
            )
          }
        }
        clearThreadRetryCount_(thread, cache)

        if (processedLabel) {
          thread.addLabel(processedLabel)
        }
      } else {
        if (usedRemoteApi) {
          const retryCount = incrementThreadRetryCount_(thread, cache)
          if (retryCount >= 5) {
            if (retryLabel && threadLabels.indexOf(retryLabelName) !== -1) {
              try {
                thread.removeLabel(retryLabel)
              } catch {}
            }
            if (manualReviewLabel) {
              thread.addLabel(manualReviewLabel)
            }
            console.warn(
              '[processEmailsWithAiClassifier] Classification failed after ' +
                retryCount +
                ' attempts; escalated to ' +
                manualReviewLabelName +
                ' for manual review.'
            )
          } else {
            if (retryLabel) {
              thread.addLabel(retryLabel)
            }
            console.warn(
              '[processEmailsWithAiClassifier] Classification failed or returned null; tagged with ' +
                retryLabelName +
                ' (attempt ' +
                retryCount +
                '/5) to ensure durable retry.'
            )
          }
        } else {
          console.warn(
            '[processEmailsWithAiClassifier] Remote classification skipped for thread; preserving untouched for next execution.'
          )
        }
      }

      if (usedRemoteApi) {
        const utilsService =
          services.Utilities ||
          (typeof Utilities !== 'undefined' ? Utilities : null)
        if (utilsService && typeof utilsService.sleep === 'function') {
          utilsService.sleep(2000)
        }
      }
    }

    console.log('[processEmailsWithAiClassifier] Batch processing complete.')
  } finally {
    if (lock) {
      try {
        lock.releaseLock()
      } catch {
        // ignore lock release error
      }
    }
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    getAiClassifierConfig:
      typeof getAiClassifierConfig !== 'undefined'
        ? getAiClassifierConfig
        : undefined,
    getClassifierConfig:
      typeof getClassifierConfig !== 'undefined'
        ? getClassifierConfig
        : undefined,
    processEmailsWithAiClassifier,
    purgeExpiredEmailsByRetentionPolicy,
    isThreadSentOrRepliedByUser,
    isDestructiveActionAllowed_,
    validateClassification,
    validateOntologicalClassification,
    classifyEmailWithGemini,
    buildOntologicalPrompt,
    ensureGmailLabel,
    ensureUserLabel: ensureGmailLabel,
    createPermanentGmailFilter,
    createGmailFilterRule,
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
    auditEmailClassifications,
    setupWeeklyRetentionTrigger,
    setupDailyAuditTrigger,
    setupFourHourAuditTrigger,
    setupFiveMinuteTrigger,
    stopAllTriggers,
    isCanonicalClassification,
    resolveTaxonomySubfolderName,
    evaluateAttachmentEligibility,
    isEligibleAttachment,
    getMessageAttachments_,
    ensureDriveTaxonomyFolder,
    findDriveTaxonomyFolder_,
    isDuplicateAttachment,
    resolveAttachmentName,
    extractZipArchiveToSubfolder,
    unzipExistingDriveArchive,
    persistCanonicalAttachmentsToDrive,
    auditAndBackfillCanonicalAttachments,
    runDryRunAttachmentAudit,
    runLiveAttachmentBackfill,
    setGmailCategoryTab,
    cleanConflictingLabels,
    reclassifyThreadsByQuery,
    runRealignmentAudit,
    runMissedEmailsSweep,
    revertAndQueueMissedCareerEmails,
    sweepAllUnreadInboxEmails,
    CANONICAL_TAXONOMY_SUBFOLDERS,
    SUBLABEL_TO_FOLDER_MAP,
    DEFAULT_DOMAIN_SUBLABEL_MAP,
    isRootDomainLabel,
    resolveCanonicalDomainFromLabels,
    deterministicRuleClassify_,
    enrichSnippetWithAttachments_,
    getFileHash,
    classifyWithGemini,
    extractJsonSubstring,
    parseRetryDelayMs,
    computeStringHash,
    listAvailableGeminiModels,
    isCircuitBreakerOpen,
    recordCircuitBreakerFailure,
    recordCircuitBreakerSuccess,
    getThreadRetryCount_,
    incrementThreadRetryCount_,
    clearThreadRetryCount_,
    isTriggerEventObject_,
    resolveEffectiveConfig_,
    sortThreadsByLastMessageDate_,
  }
}
