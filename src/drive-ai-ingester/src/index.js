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
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent',
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:generateContent',
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent',
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent',
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent',
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent',
  ]

  for (let e = 0; e < endpoints.length; e++) {
    const url = endpoints[e] + '?key=' + config.geminiApiKey
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
        if (
          resData.candidates &&
          resData.candidates[0] &&
          resData.candidates[0].content &&
          resData.candidates[0].content.parts &&
          resData.candidates[0].content.parts[0]
        ) {
          const textOutput = resData.candidates[0].content.parts[0].text
          const parsedObj = extractJsonSubstring(textOutput)
          if (parsedObj) {
            console.log(
              '[analyzeDocumentWithAi] Success using endpoint: ' + endpoints[e]
            )
            return parsedObj
          }
        }
      } else if (statusCode === 429) {
        const delayMs = parseRetryDelayMs(response)
        console.warn(
          '[analyzeDocumentWithAi] Endpoint ' +
            endpoints[e] +
            ' HTTP 429 Rate Limit: sleeping ' +
            delayMs / 1000 +
            's...'
        )
        Utilities.sleep(delayMs)
      }
    } catch (err) {
      console.warn(
        '[analyzeDocumentWithAi] Exception on endpoint ' +
          endpoints[e] +
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
  const { DocumentApp, MimeType, Utilities } = services
  const tagsStr = (metadata.tags || []).join(', ')
  const peopleStr = (metadata.people || []).join(', ')
  const domainStr = metadata.canonicalDomain || ''
  const sublabelStr = metadata.subLabel || ''

  // Layer 1: Native Drive File Description Metadata Tagging
  try {
    const currDesc = file.getDescription() || ''
    if (currDesc.indexOf('[AI_INDEXED]') === -1) {
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
    if (file.getMimeType() === MimeType.GOOGLE_DOCS) {
      const doc = DocumentApp.openById(file.getId())
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
        JSON.stringify(metadata.people || []) +
        '\n' +
        'organization: ' +
        JSON.stringify(metadata.organization || []) +
        '\n' +
        'tags: ' +
        JSON.stringify(metadata.tags || []) +
        '\n' +
        'created: ' +
        Utilities.formatDate(file.getLastUpdated(), 'GMT', 'yyyy-MM-dd') +
        '\n' +
        '---\n\n'

      const text = body.getText()
      if (text.indexOf('---') !== 0) {
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
    const seconds = parseInt(retryHeader, 10)
    if (!isNaN(seconds) && seconds > 0) {
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
  let entry = '\n### ' + dateStr + ' — [' + title + '](' + driveUrl + ')\n'
  if (accountEmail) {
    entry += '- **Account**: ' + accountEmail + '\n'
  }
  if (peopleList && peopleList.length > 0) {
    entry += '- **People**: ' + peopleList.join(', ') + '\n'
  }
  if (tagsList && tagsList.length > 0) {
    entry += '- **Tags**: `' + tagsList.join('`, `') + '`\n'
  }
  if (summaryText) {
    entry += '- **Summary**:\n  > ' + summaryText.trim() + '\n'
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
  }
}
