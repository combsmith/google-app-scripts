/**
 * Native Google Apps Script GitHub Sync Module (Auto-Create & Long Document Aware)
 * Calls GitHub REST API via UrlFetchApp to commit Markdown entries directly to self-private repo.
 *
 * Features:
 * - Auto-creates missing target markdown files on GitHub (HTTP 404 handling)
 * - SHA Collision & Retry Guard (catches HTTP 409 API conflicts & retries)
 * - Section-Aware Targeted Insertion (inserts entries into Section 3 log blocks)
 * - Idempotency Guard (skips duplicate entries)
 */

var GITHUB_REPO_OWNER =
  (typeof getAiClassifierConfig === 'function' &&
    getAiClassifierConfig().githubRepoOwner) ||
  'don-petry'
var GITHUB_REPO_NAME =
  (typeof getAiClassifierConfig === 'function' &&
    getAiClassifierConfig().githubRepoName) ||
  'self-private'

var RULE6_PATTERNS = [
  [/\S \? \S/, "' ? ' between words (was an em dash or a · separator)"],
  [/\?\?/, "'??' (was a multi-codepoint emoji)"],
  [/[A-Za-z]\?[A-Za-z]/, "'?' inside a word (was a curly apostrophe)"],
  [/\uFFFD/, 'U+FFFD replacement character'],
]

/** Refuse to write an entry that already shows mojibake. */
function assertClean_(text, what) {
  if (!text) return
  for (var i = 0; i < RULE6_PATTERNS.length; i++) {
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
  var lost = []
  for (var i = 0; i < source.length; i++) {
    var c = source.charAt(i)
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

/**
 * Appends a Progressive Disclosure entry to a target markdown file in self-private via GitHub REST API.
 * Automatically creates the file with valid front-matter if it does not exist yet (HTTP 404).
 */
function appendMarkdownEntryToGitHubRepo(filePath, entryMd, commitMessage) {
  var githubToken =
    PropertiesService.getScriptProperties().getProperty('GITHUB_PAT')
  if (!githubToken) {
    console.log(
      '[gitHubSync] GITHUB_PAT ScriptProperty not set. Skipping GitHub commit.'
    )
    return false
  }

  var maxRetries = 3
  for (var attempt = 1; attempt <= maxRetries; attempt++) {
    var result = executeGitHubCommit(
      filePath,
      entryMd,
      commitMessage,
      githubToken
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
    Utilities.sleep(1000 * attempt)
  }

  console.error(
    '[gitHubSync] Failed to commit entry to GitHub after',
    maxRetries,
    'attempts:',
    filePath
  )
  return false
}

/**
 * Performs a single commit transaction via GitHub REST API with 404 Auto-Create & 409 SHA retry handling.
 */
function executeGitHubCommit(filePath, entryMd, commitMessage, githubToken) {
  if (!filePath || !entryMd) {
    console.warn('[gitHubSync] Missing filePath or entryMd for GitHub commit.')
    return false
  }
  var url =
    'https://api.github.com/repos/' +
    GITHUB_REPO_OWNER +
    '/' +
    GITHUB_REPO_NAME +
    '/contents/' +
    filePath
  var headers = {
    Authorization: 'token ' + githubToken,
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'Google-Apps-Script',
  }

  try {
    var getOptions = {
      method: 'get',
      headers: headers,
      muteHttpExceptions: true,
    }
    var res = UrlFetchApp.fetch(url, getOptions)
    var statusCode = res.getResponseCode()

    var sha = null
    var rawContent = ''

    if (statusCode === 404) {
      // 1. File does not exist on GitHub -> Initialize with standard Front-Matter & 3-Layer Template
      console.log(
        '[gitHubSync] File not found on GitHub (HTTP 404). Initializing new note:',
        filePath
      )
      var topicTitle = extractTopicTitleFromPath(filePath)
      rawContent =
        '---\ntitle: ' +
        topicTitle +
        '\ncreated: ' +
        Utilities.formatDate(new Date(), 'GMT', 'yyyy-MM-dd') +
        '\nnotebook: household\nsection: general\n---\n\n' +
        '# ' +
        topicTitle +
        '\n\n' +
        '## 1. Executive Summary & Active Status\n- Ingested records log.\n\n' +
        '## 2. Key References & Quick Links\n| Topic | Asset |\n| :--- | :--- |\n\n' +
        '## 3. Ingested Activity Logs\n<details open><summary><b>Activity Logs</b></summary>\n</details>\n'
    } else if (statusCode === 200) {
      var fileData = JSON.parse(res.getContentText())
      sha = fileData.sha
      // GitHub Contents API wraps Base64 in newlines every 60 chars; strip them
      // before decoding since some decoders reject embedded whitespace.
      rawContent = Utilities.newBlob(
        Utilities.base64Decode((fileData.content || '').replace(/[\r\n]/g, ''))
      ).getDataAsString()

      // Idempotency Check: Skip if entry already present
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

    // 2. Section-Aware Insertion
    var updatedContent = insertEntryIntoLogSection(rawContent, entryMd)

    // Rule 6 Guards: Refuse to commit if mojibake is detected in new entry or non-ASCII chars were flattened
    assertClean_(entryMd, 'new entry for ' + filePath)

    var base64Updated = Utilities.base64Encode(
      Utilities.newBlob(updatedContent).getBytes()
    )

    // Validate the ACTUAL Base64 round trip at the payload boundary: decode what
    // we are about to PUT and confirm no non-ASCII character was flattened to
    // '?'.
    var renderedContent = Utilities.newBlob(
      Utilities.base64Decode(base64Updated)
    ).getDataAsString()
    assertNoAsciiReplacement_(updatedContent, renderedContent)

    // 3. Commit updated content back to GitHub main branch
    var putPayload = {
      message:
        commitMessage ||
        'feat(ingestion): append ingested document entry via Google Apps Script',
      content: base64Updated,
      branch: 'main',
    }
    if (sha) {
      putPayload.sha = sha
    }

    var putOptions = {
      method: 'put',
      headers: headers,
      contentType: 'application/json',
      payload: JSON.stringify(putPayload),
      muteHttpExceptions: true,
    }

    var putRes = UrlFetchApp.fetch(url, putOptions)
    var putStatus = putRes.getResponseCode()

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

function extractTopicTitleFromPath(filePath) {
  if (!filePath || typeof filePath !== 'string') {
    return 'Ingested Records'
  }
  var trimmed = filePath.trim()
  if (!trimmed || trimmed === '/') {
    return 'Ingested Records'
  }
  var parts = trimmed.split('/').filter(Boolean)
  if (parts.length === 0) {
    return 'Ingested Records'
  }
  var topic = parts.length > 1 ? parts[parts.length - 2] : parts[0]
  // Strip any trailing file extension (e.g. ".md") before title-casing so a
  // single-segment path like "digital-backups.md" becomes "Digital Backups".
  var cleaned = topic.replace(/\.[^.]+$/, '').replace(/-/g, ' ')
  if (!cleaned) return 'Ingested Records'
  return cleaned.replace(/\b\w/g, function (l) {
    return l.toUpperCase()
  })
}

function insertEntryIntoLogSection(fullContent, newEntry) {
  if (!fullContent && !newEntry) return ''
  if (!fullContent) return String(newEntry)
  if (!newEntry) return String(fullContent)

  var detailsMarker = '</details>'
  var detailsIndex = fullContent.indexOf(detailsMarker)

  if (detailsIndex !== -1) {
    return (
      fullContent.substring(0, detailsIndex) +
      newEntry +
      '\n' +
      fullContent.substring(detailsIndex)
    )
  }

  var section3Marker = '## 3. Ingested Activity'
  var section3Index = fullContent.indexOf(section3Marker)

  if (section3Index !== -1) {
    var lineBreakIndex = fullContent.indexOf('\n', section3Index)
    return (
      fullContent.substring(0, lineBreakIndex + 1) +
      newEntry +
      '\n' +
      fullContent.substring(lineBreakIndex + 1)
    )
  }

  return fullContent + '\n' + newEntry
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    appendMarkdownEntryToGitHubRepo: appendMarkdownEntryToGitHubRepo,
    executeGitHubCommit: executeGitHubCommit,
    extractTopicTitleFromPath: extractTopicTitleFromPath,
    insertEntryIntoLogSection: insertEntryIntoLogSection,
    assertClean_: assertClean_,
    assertNoAsciiReplacement_: assertNoAsciiReplacement_,
    RULE6_PATTERNS: RULE6_PATTERNS,
  }
}
