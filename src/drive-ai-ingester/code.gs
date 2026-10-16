/**
 * Main entry point for Google Drive AI Ingestion & Dual-Layer Auto-Tagging Engine.
 * PROD RUNTIME: Runs autonomously 24/7 in Google Apps Script via 15-minute Cloud Trigger.
 * Continuously iterates page-by-page over ALL non-media files across the ENTIRE Google Drive.
 */

var DRIVE_AI_INGESTER_VERSION = 'v1.4.0-drive-continuous'

function processDriveFilesWithAiIngester() {
  console.log(
    '[processDriveFilesWithAiIngester] Engine Version: ' +
      DRIVE_AI_INGESTER_VERSION
  )
  console.log(
    '[processDriveFilesWithAiIngester] Starting continuous in-place AI tagging across entire Google Drive...'
  )
  var config = getDriveIngesterConfig()

  if (!config.geminiApiKey) {
    console.error(
      '[processDriveFilesWithAiIngester] GEMINI_API_KEY ScriptProperty is missing.'
    )
    return
  }

  // Concurrency guard: serialize runs across triggers
  var lock = LockService.getScriptLock()
  if (!lock.tryLock(1000)) {
    console.log(
      '[processDriveFilesWithAiIngester] Another ingestion run is in progress; skipping this trigger.'
    )
    return
  }

  var processedCount = 0
  var inspectedCount = 0
  var MAX_FILES_PER_RUN = 10
  var MAX_INSPECTED_PER_RUN = 50

  // Injected services for extracted functions
  var services = {
    DocumentApp: DocumentApp,
    MimeType: MimeType,
    UrlFetchApp: UrlFetchApp,
    Utilities: Utilities,
  }

  try {
    console.log(
      '[processDriveFilesWithAiIngester] Searching non-trashed document files across Drive...'
    )
    var query =
      "trashed = false and (mimeType = 'application/vnd.google-apps.document' or mimeType = 'text/plain')"
    var props = PropertiesService.getScriptProperties()
    var continuationToken = props.getProperty(
      'DRIVE_INGESTER_CONTINUATION_TOKEN'
    )
    var files = null
    if (continuationToken) {
      try {
        files = DriveApp.continueFileIterator(continuationToken)
      } catch (tokenErr) {
        console.warn(
          '[processDriveFilesWithAiIngester] Could not resume file iteration with token, restarting search: ' +
            tokenErr.message
        )
        files = DriveApp.searchFiles(query)
      }
    } else {
      files = DriveApp.searchFiles(query)
    }

    while (
      files &&
      files.hasNext() &&
      processedCount < MAX_FILES_PER_RUN &&
      inspectedCount < MAX_INSPECTED_PER_RUN
    ) {
      var file = files.next()
      inspectedCount++

      try {
        var description = ''
        try {
          description = file.getDescription() || ''
        } catch (e) {}

        var isIndexed = description.indexOf('[AI_INDEXED]') !== -1
        var mime = file.getMimeType()

        // 1. Skip if already tagged & indexed
        if (isIndexed) {
          continue
        }

        // 2. Filter to document types whose contents can be extracted.
        var isDocument =
          mime === MimeType.GOOGLE_DOCS || mime === MimeType.PLAIN_TEXT

        if (!isDocument) {
          continue
        }

        console.log(
          '[processDriveFilesWithAiIngester] Tagging document (' +
            (processedCount + 1) +
            '/' +
            MAX_FILES_PER_RUN +
            '): "' +
            file.getName() +
            '" (' +
            mime +
            ')'
        )

        var fileText = extractFileContentText(file, services)
        var metadata = analyzeDocumentWithAi(
          file.getName(),
          fileText,
          config,
          services
        )

        if (metadata) {
          // 3. Sync Executive Summary & Drive Link to GitHub self-private FIRST.
          // If GitHub sync fails, leave file unindexed for subsequent retries.
          var githubSuccess = true
          if (config.githubToken) {
            var notePath = getNotePathForDomain(
              metadata.canonicalDomain || '01_Household',
              metadata.subLabel
            )
            if (notePath) {
              var dateStr = Utilities.formatDate(
                file.getLastUpdated(),
                'GMT',
                'yyyy-MM-dd'
              )
              var entryMd = formatDriveIngestionEntry(
                dateStr,
                metadata.title || file.getName(),
                file.getUrl(),
                metadata.summary,
                metadata.tags,
                metadata.people,
                config.userAccountEmail
              )
              githubSuccess = appendMarkdownEntryToGitHubRepo(
                notePath,
                entryMd,
                'feat(drive-ingest): ' + file.getName()
              )
            } else {
              console.warn(
                '[processDriveFilesWithAiIngester] No GitHub note path for canonicalDomain "' +
                  metadata.canonicalDomain +
                  '" (file: ' +
                  file.getName() +
                  '); skipping indexing so it can be retried.'
              )
              githubSuccess = false
            }
          }

          if (!githubSuccess) {
            console.warn(
              '[processDriveFilesWithAiIngester] GitHub sync failed; skipping tagging and leaving file for retry: ' +
                file.getName()
            )
            Utilities.sleep(2000)
            continue
          }

          // 4. Apply Dual-Layer Metadata Tags. Only increment processed counter
          // if [AI_INDEXED] is successfully persisted.
          var tagged = applyDualLayerTagsToDriveFile(file, metadata, services)
          if (!tagged) {
            console.warn(
              '[processDriveFilesWithAiIngester] Tagging failed; leaving file for retry: ' +
                file.getName()
            )
            Utilities.sleep(2000)
            continue
          }

          console.log(
            '[processDriveFilesWithAiIngester] Successfully tagged & indexed file in-place: ' +
              file.getName()
          )
          processedCount++
        }
      } catch (fileErr) {
        console.warn(
          '[processDriveFilesWithAiIngester] Failed processing file "' +
            file.getName() +
            '": ' +
            fileErr.message
        )
      }

      Utilities.sleep(2000)
    }

    if (files && files.hasNext()) {
      try {
        props.setProperty(
          'DRIVE_INGESTER_CONTINUATION_TOKEN',
          files.getContinuationToken()
        )
      } catch (tokenSaveErr) {
        console.warn(
          '[processDriveFilesWithAiIngester] Failed to save continuation token: ' +
            tokenSaveErr.message
        )
      }
    } else {
      try {
        props.deleteProperty('DRIVE_INGESTER_CONTINUATION_TOKEN')
      } catch (e) {}
    }
  } catch (err) {
    console.error(
      '[processDriveFilesWithAiIngester] Exception during Drive file iteration: ' +
        err.message
    )
  } finally {
    lock.releaseLock()
  }

  console.log(
    '[processDriveFilesWithAiIngester] Execution run complete. Inspected ' +
      inspectedCount +
      ' file(s), Tagged ' +
      processedCount +
      ' document(s).'
  )
}

/**
 * Creates an automatic Cloud Trigger that runs Drive Ingestion every 15 minutes.
 */
function setupFifteenMinuteDriveTrigger() {
  stopAllDriveTriggers()
  ScriptApp.newTrigger('processDriveFilesWithAiIngester')
    .timeBased()
    .everyMinutes(15)
    .create()
  console.log(
    '[setupFifteenMinuteDriveTrigger] Established 15-minute recurring cloud trigger for Drive Ingester.'
  )
}

/**
 * Clears only this ingester's own time-driven triggers, leaving unrelated
 * project automation intact.
 */
function stopAllDriveTriggers() {
  var triggers = ScriptApp.getProjectTriggers()
  var removed = 0
  for (var i = 0; i < triggers.length; i++) {
    if (
      triggers[i].getHandlerFunction() === 'processDriveFilesWithAiIngester'
    ) {
      ScriptApp.deleteTrigger(triggers[i])
      removed++
    }
  }
  console.log(
    '[stopAllDriveTriggers] Removed ' +
      removed +
      ' processDriveFilesWithAiIngester trigger(s).'
  )
}

/**
 * Extracts plain text content from a Drive file up to 3000 characters.
 * @param {object} file - Drive file object
 * @param {object} services - Object with DocumentApp and MimeType references
 * @returns {string} Extracted text or filename fallback
 */
function extractFileContentText(file, services) {
  const DocApp = services?.DocumentApp || DocumentApp
  const Mime = services?.MimeType || MimeType
  try {
    const mime = file.getMimeType()
    if (mime === Mime.GOOGLE_DOCS) {
      return DocApp.openById(file.getId())
        .getBody()
        .getText()
        .substring(0, 3000)
    } else if (mime === Mime.PLAIN_TEXT) {
      return file.getBlob().getDataAsString().substring(0, 3000)
    }
  } catch (e) {
    console.warn(
      '[extractFileContentText] Could not extract text from file ' +
        file.getName() +
        ': ' +
        e.message
    )
  }
  return file.getName()
}

/**
 * Analyzes document text with Gemini API and returns classification metadata.
 * @param {string} fileName - Document file name
 * @param {string} fileText - Extracted document text
 * @param {object} config - Configuration object with canonicalDomains and geminiApiKey
 * @param {object} services - Object with UrlFetchApp and Utilities references
 * @returns {object|null} Classification metadata or null on failure
 */
function analyzeDocumentWithAi(fileName, fileText, config, services) {
  const FetchApp = services?.UrlFetchApp || UrlFetchApp
  const Utils = services?.Utilities || Utilities
  const prompt =
    'Analyze this document and determine its canonical domain out of: ' +
    JSON.stringify(config.canonicalDomains) +
    '.\n\n' +
    'MANDATORY HYBRID TAG DECOMPOSITION RULE:\n' +
    "For every compound/hyphenated tag (e.g. 'smart-home', 'service-receipt', 'credit-card', 'cloud-server'), you MUST also include each individual word component ('smart', 'home', 'service', 'receipt', 'credit', 'card', 'cloud', 'server') in the tags array.\n\n" +
    'RULE 15 - SMALL BUSINESS, ARTISANAL CRAFT & HOBBY SALES:\n' +
    "Classify small business and artisanal craft vendor inventories, wholesale price lists, invoices, and sales receipts under '01_Household' (sub-label 'Projects/Business') or '02_Finance_Legal' (sub-label 'Finance/Purchases' if pure purchase receipt/invoice).\n\n" +
    'RULE 16 - TAX FORMS, CHARITABLE DONATIONS & COURT ORDERS:\n' +
    "Classify tax forms (1095-C, 1098, W2, tax returns), charitable donation receipts, court orders, and legal work orders under '02_Finance_Legal' (sub-labels 'Finance/Taxes', 'Finance/Charitable-Donations', or 'Finance/Legal').\n\n" +
    'RULE 18 - CAR RENTALS & TRAVEL RESERVATION CONFIRMATIONS:\n' +
    "Classify car rental agreements, Hertz/Avis/Enterprise check-ins, airline tickets, hotel reservations, and travel itineraries under '01_Household' (sub-label 'Household/Travel') or '03_Vehicles' (sub-label 'Vehicles/Rental-Cars').\n\n" +
    'DOCUMENT FILE NAME: ' +
    fileName +
    '\n' +
    'DOCUMENT TEXT SNIPPET: ' +
    fileText +
    '\n\n' +
    'Return JSON ONLY:\n' +
    '{\n' +
    '  "canonicalDomain": "01_Household",\n' +
    '  "subLabel": "Household/Travel",\n' +
    '  "title": "Short Document Title",\n' +
    '  "people": ["Full Name 1", "Full Name 2"],\n' +
    '  "organization": ["Org / Institution Name"],\n' +
    '  "tags": ["compound-tag", "compound", "tag", "person-name", "person", "name"],\n' +
    '  "summary": "2 sentence executive summary of document contents."\n' +
    '}'

  const payload = {
    contents: [
      {
        parts: [{ text: prompt }],
      },
    ],
  }

  const endpoints = [
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent',
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent',
  ]

  for (const endpoint of endpoints) {
    const url = endpoint + '?key=' + config.geminiApiKey
    const options = {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    }

    try {
      const response = FetchApp.fetch(url, options)
      const statusCode = response.getResponseCode()
      const jsonText = response.getContentText()

      if (statusCode === 200) {
        const resData = JSON.parse(jsonText)
        const textOutput = resData.candidates?.[0]?.content?.parts?.[0]?.text
        if (textOutput) {
          const parsedObj = extractJsonSubstring(textOutput)
          if (parsedObj) {
            console.log(
              '[analyzeDocumentWithAi] Success using endpoint: ' + endpoint
            )
            return parsedObj
          }
        }
      } else if (statusCode === 429) {
        const delayMs = parseRetryDelayMs(response)
        console.warn(
          '[analyzeDocumentWithAi] Endpoint ' +
            endpoint +
            ' HTTP 429 Rate Limit: sleeping ' +
            delayMs / 1000 +
            's...'
        )
        Utils.sleep(delayMs)
      }
    } catch (err) {
      console.warn(
        '[analyzeDocumentWithAi] Exception on endpoint ' +
          endpoint +
          ': ' +
          err.message
      )
    }
  }

  return null
}

/**
 * Applies dual-layer metadata tagging:
 * Layer 1: Native Drive File Description ([AI_INDEXED] tag block)
 * Layer 2: Embedded YAML front-matter header in Google Docs
 *
 * @param {object} file - Drive file object
 * @param {object} metadata - Classification metadata from AI analysis
 * @param {object} services - Object with DocumentApp, MimeType, and Utilities references
 * @returns {boolean} True if Layer 1 ([AI_INDEXED]) persisted, false otherwise
 */
function applyDualLayerTagsToDriveFile(file, metadata, services) {
  const DocApp = services?.DocumentApp || DocumentApp
  const Mime = services?.MimeType || MimeType
  const Utils = services?.Utilities || Utilities
  const tagsList = Array.isArray(metadata?.tags) ? metadata.tags : []
  const peopleList = Array.isArray(metadata?.people) ? metadata.people : []
  const orgList = Array.isArray(metadata?.organization)
    ? metadata.organization
    : []
  const tagsStr = tagsList.join(', ')
  const peopleStr = peopleList.join(', ')
  const domainStr = metadata?.canonicalDomain || ''
  const sublabelStr = metadata?.subLabel || ''

  // Layer 1: Native Drive File Description Metadata Tagging
  try {
    const currDesc = file.getDescription() || ''
    if (!currDesc.includes('[AI_INDEXED]')) {
      const tagBlock =
        '[AI_INDEXED] [AI_DOMAIN: ' +
        domainStr +
        '] sublabel: ' +
        sublabelStr +
        ' | people: ' +
        peopleStr +
        ' | tags: ' +
        tagsStr
      const newDesc = currDesc ? currDesc + '\n\n' + tagBlock : tagBlock
      file.setDescription(newDesc)
      console.log(
        '[applyDualLayerTagsToDriveFile] Set File Description metadata tags on: ' +
          file.getName()
      )
    }
  } catch (e) {
    console.error(
      '[applyDualLayerTagsToDriveFile] Layer 1 failed; [AI_INDEXED] NOT persisted for ' +
        file.getName() +
        ': ' +
        e.message
    )
    return false
  }

  // Layer 2: Embedded Document Front-Matter Header (Google Docs)
  try {
    if (file.getMimeType() === Mime.GOOGLE_DOCS) {
      const doc = DocApp.openById(file.getId())
      const body = doc.getBody()

      const yamlHeader =
        '---\n' +
        'domain: ' +
        JSON.stringify(domainStr) +
        '\n' +
        'sublabel: ' +
        JSON.stringify(sublabelStr) +
        '\n' +
        'people: ' +
        JSON.stringify(peopleList) +
        '\n' +
        'organization: ' +
        JSON.stringify(orgList) +
        '\n' +
        'tags: ' +
        JSON.stringify(tagsList) +
        '\n' +
        'created: ' +
        Utils.formatDate(file.getLastUpdated(), 'GMT', 'yyyy-MM-dd') +
        '\n' +
        '---\n\n'

      const text = body.getText()
      if (text.trim().indexOf('---') !== 0) {
        body.insertParagraph(0, yamlHeader)
        console.log(
          '[applyDualLayerTagsToDriveFile] Embedded YAML front-matter header into Google Doc: ' +
            file.getName()
        )
      }
    }
  } catch (e) {
    console.warn(
      '[applyDualLayerTagsToDriveFile] Layer 2 (front-matter) failed for ' +
        file.getName() +
        ' (marker already persisted): ' +
        e.message
    )
  }

  return true
}

/**
 * Extracts JSON object from text that may contain markdown code fences.
 * @param {string} text - Text containing JSON
 * @returns {object|null} Parsed JSON object or null
 */
function extractJsonSubstring(text) {
  if (!text) return null
  text = text
    .replace(/```json/gi, '')
    .replace(/```/gi, '')
    .trim()

  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start !== -1 && end !== -1 && end > start) {
    const rawJson = text.substring(start, end + 1)
    try {
      return JSON.parse(rawJson)
    } catch (e) {
      console.warn('[extractJsonSubstring] JSON parse error:', e.message)
    }
  }
  return null
}

/**
 * Parses Retry-After header from HTTP response to determine backoff delay.
 * @param {object} response - HTTP response object with headers
 * @returns {number} Delay in milliseconds, capped at 30 seconds
 */
function parseRetryDelayMs(response) {
  const headers = response?.getHeaders?.() || {}
  const retryHeader = headers['Retry-After'] || headers['retry-after']
  if (retryHeader) {
    const seconds = Number.parseInt(retryHeader, 10)
    if (!Number.isNaN(seconds) && seconds > 0) {
      return Math.min(seconds * 1000, 30000)
    }
  }
  return 5000
}

/**
 * Maps canonical domain to GitHub notes file path.
 * @param {string} domain - Canonical domain identifier (e.g., '01_Household')
 * @param {string} _subLabel - Sub-label for additional context (unused in v1)
 * @returns {string|null} Path to markdown file or null if domain not found
 */
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
  return map[domain] || null
}

/**
 * Formats a Drive ingestion entry as Markdown with document metadata and summary.
 * @param {string} dateStr - ISO date string
 * @param {string} title - Document title
 * @param {string} driveUrl - Drive file URL
 * @param {string} summaryText - AI-generated summary
 * @param {string[]} tagsList - Array of classification tags
 * @param {string[]} peopleList - Array of people mentioned in document
 * @param {string|null} accountEmail - Email account that processed the file
 * @returns {string} Formatted markdown entry
 */
function formatDriveIngestionEntry(
  dateStr,
  title,
  driveUrl,
  summaryText,
  tagsList,
  peopleList,
  accountEmail
) {
  const escapedTitle = (title || '')
    .replaceAll('\\', '\\\\')
    .replaceAll('[', String.raw`\[`)
    .replaceAll(']', String.raw`\]`)
  let entry =
    '\n### ' + dateStr + ' — [' + escapedTitle + '](' + driveUrl + ')\n'
  if (accountEmail) {
    entry += '- **Account**: ' + accountEmail + '\n'
  }
  const people = Array.isArray(peopleList) ? peopleList : []
  if (people.length > 0) {
    entry += '- **People**: ' + people.join(', ') + '\n'
  }
  const tags = Array.isArray(tagsList) ? tagsList : []
  if (tags.length > 0) {
    entry += '- **Tags**: `' + tags.join('`, `') + '`\n'
  }
  if (summaryText) {
    entry +=
      '- **Summary**:\n' +
      summaryText
        .trim()
        .split(/\r?\n/)
        .map((l) => '  > ' + l)
        .join('\n') +
      '\n'
  }
  return entry
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    processDriveFilesWithAiIngester: processDriveFilesWithAiIngester,
    setupFifteenMinuteDriveTrigger: setupFifteenMinuteDriveTrigger,
    stopAllDriveTriggers: stopAllDriveTriggers,
    extractFileContentText: extractFileContentText,
    analyzeDocumentWithAi: analyzeDocumentWithAi,
    applyDualLayerTagsToDriveFile: applyDualLayerTagsToDriveFile,
    extractJsonSubstring: extractJsonSubstring,
    parseRetryDelayMs: parseRetryDelayMs,
    getNotePathForDomain: getNotePathForDomain,
    formatDriveIngestionEntry: formatDriveIngestionEntry,
  }
}
