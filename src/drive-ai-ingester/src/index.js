/**
 * Drive AI Ingester - Extracted testable logic with service injection.
 * These functions accept GAS services as parameters to enable Jest unit testing.
 */

/**
 * Extracts plain text content from a Drive file up to 3000 characters.
 * @param {object} file - Drive file object (injected, can be mocked in tests)
 * @param {object} services - Object with DocumentApp and MimeType references
 * @returns {string} Extracted text or filename fallback
 */
function extractFileContentText(file, services) {
  const { DocumentApp, MimeType } = services
  try {
    const mime = file.getMimeType()
    if (mime === MimeType.GOOGLE_DOCS) {
      return DocumentApp.openById(file.getId())
        .getBody()
        .getText()
        .substring(0, 3000)
    } else if (mime === MimeType.PLAIN_TEXT) {
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
  const { UrlFetchApp, Utilities } = services
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
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent',
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
      const response = UrlFetchApp.fetch(url, options)
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
        Utilities.sleep(delayMs)
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
 * Tags a Drive file in place through its Drive description only:
 *   [AI_INDEXED] [AI_DOMAIN: <domain>] sublabel: ... | people: ... | organization: ... | tags: ...
 * The document body is never modified. Earlier versions also inserted a YAML
 * front-matter block at the top of Google Docs, which changed what every
 * collaborator sees, bumped "last modified" on documents nobody edited, and
 * duplicated the description (Drive full-text search already indexes it).
 *
 * @param {object} file - Drive file object
 * @param {object} metadata - Classification metadata from AI analysis
 * @param {object} [_services] - Unused; kept for call-site compatibility
 * @returns {boolean} True if the [AI_INDEXED] marker persisted, false otherwise
 */
function applyDualLayerTagsToDriveFile(file, metadata, _services) {
  const tagsList = Array.isArray(metadata?.tags) ? metadata.tags : []
  const peopleList = Array.isArray(metadata?.people) ? metadata.people : []
  const orgList = Array.isArray(metadata?.organization)
    ? metadata.organization
    : []
  const domainStr = metadata?.canonicalDomain || ''
  const sublabelStr = metadata?.subLabel || ''

  try {
    const currDesc = file.getDescription() || ''
    if (!currDesc.includes('[AI_INDEXED]')) {
      const tagBlock =
        '[AI_INDEXED] [AI_DOMAIN: ' +
        domainStr +
        '] sublabel: ' +
        sublabelStr +
        ' | people: ' +
        peopleList.join(', ') +
        (orgList.length ? ' | organization: ' + orgList.join(', ') : '') +
        ' | tags: ' +
        tagsList.join(', ')
      const newDesc = currDesc ? currDesc + '\n\n' + tagBlock : tagBlock
      file.setDescription(newDesc)
      console.log(
        '[applyDualLayerTagsToDriveFile] Set File Description metadata tags on: ' +
          file.getName()
      )
    }
  } catch (e) {
    console.error(
      '[applyDualLayerTagsToDriveFile] [AI_INDEXED] NOT persisted for ' +
        file.getName() +
        ': ' +
        e.message
    )
    return false
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
 * Returns the log-shard suffix ("2026-Q4" or "2026-11") for an entry date, or ''.
 * @param {string|Date} entryDate - "yyyy-MM-dd" string or Date
 * @param {string} mode - "quarterly" or "monthly"
 * @returns {string}
 */
function noteLogShardSuffix_(entryDate, mode) {
  let year = 0
  let month = 0
  if (entryDate instanceof Date && !Number.isNaN(entryDate.getTime())) {
    year = entryDate.getUTCFullYear()
    month = entryDate.getUTCMonth() + 1
  } else {
    const m = /^(\d{4})-(\d{2})/.exec(String(entryDate || ''))
    if (m) {
      year = Number(m[1])
      month = Number(m[2])
    }
  }
  if (!year || month < 1 || month > 12) return ''
  if (mode === 'monthly') return year + '-' + String(month).padStart(2, '0')
  return year + '-Q' + Math.ceil(month / 3)
}

/**
 * Maps canonical domain to the GitHub note that receives its log entries.
 * With the NOTE_LOG_SHARDING Script Property set to "quarterly" or "monthly",
 * entries go to <domain>/activity/<shard>.md (same layout as the Gmail classifier).
 * @param {string} domain - Canonical domain identifier (e.g., '01_Household')
 * @param {string} _subLabel - Sub-label for additional context (unused)
 * @param {string|Date} [entryDate] - Entry date used to pick the shard
 * @returns {string|null} Path to markdown file or null if domain not found
 */
function getNotePathForDomain(domain, _subLabel, entryDate) {
  const map = {
    '01_Household': '01_Household/index.md',
    '02_Finance_Legal': '02_Finance_Legal/index.md',
    '03_Vehicles': '03_Vehicles/index.md',
    '04_Family_Health': '04_Family_Health/index.md',
    '05_Tech_Infrastructure': '05_Tech_Infrastructure/index.md',
    '06_Work_Career': '06_Work_Career/index.md',
    '07_Community_NonProfit': '07_Community_NonProfit/index.md',
  }
  const base = map[domain] || null
  let mode = ''
  try {
    if (typeof PropertiesService !== 'undefined') {
      mode = String(
        PropertiesService.getScriptProperties().getProperty(
          'NOTE_LOG_SHARDING'
        ) || ''
      )
        .trim()
        .toLowerCase()
    }
  } catch (e) {
    mode = ''
  }
  if (base && (mode === 'quarterly' || mode === 'monthly')) {
    const suffix = noteLogShardSuffix_(entryDate, mode)
    if (suffix) return domain + '/activity/' + suffix + '.md'
  }
  return base
}

/**
 * True when the file sits (at any depth) under a folder named after a
 * canonical domain (e.g. "02_Finance_Legal"), so only the household's filing
 * tree is ingested, never arbitrary documents elsewhere in Drive.
 * @param {object} file - Drive file
 * @param {string[]} canonicalNames - Canonical domain folder names
 * @param {object} [cache] - Per-run map of folderId -> boolean
 * @returns {boolean}
 */
function isInCanonicalFolderTree_(file, canonicalNames, cache) {
  const memo = cache || {}
  const names = canonicalNames || []
  function check(folder, depth) {
    if (!folder || depth > 10) return false
    const id = typeof folder.getId === 'function' ? folder.getId() : ''
    if (id && Object.prototype.hasOwnProperty.call(memo, id)) return memo[id]
    let result = names.indexOf(folder.getName()) !== -1
    if (!result) {
      const parents = folder.getParents()
      while (!result && parents && parents.hasNext()) {
        result = check(parents.next(), depth + 1)
      }
    }
    if (id) memo[id] = result
    return result
  }
  try {
    const parents = file.getParents()
    while (parents && parents.hasNext()) {
      if (check(parents.next(), 0)) return true
    }
  } catch (e) {
    console.warn(
      '[isInCanonicalFolderTree_] Could not read parents: ' + e.message
    )
  }
  return false
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
 * @param {string} [fileId] - Drive file ID; adds an idempotency marker
 * @returns {string} Formatted markdown entry
 */
function formatDriveIngestionEntry(
  dateStr,
  title,
  driveUrl,
  summaryText,
  tagsList,
  peopleList,
  accountEmail,
  fileId
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
  if (fileId) {
    entry += '<!-- source: drive file=' + fileId + ' -->\n'
  }
  return entry
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    extractFileContentText,
    analyzeDocumentWithAi,
    applyDualLayerTagsToDriveFile,
    extractJsonSubstring,
    parseRetryDelayMs,
    getNotePathForDomain,
    formatDriveIngestionEntry,
    noteLogShardSuffix_,
    isInCanonicalFolderTree_,
  }
}
