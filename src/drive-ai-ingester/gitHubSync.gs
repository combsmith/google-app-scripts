/**
 * GitHub REST API Sync Helper for Google Apps Script.
 * Performs atomic GET -> PUT markdown updates with 404 auto-initialization.
 */

var RULE6_PATTERNS = [[/\uFFFD/, 'U+FFFD replacement character']]

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
 * Commits an appended markdown entry to GitHub with automatic retry on version
 * conflicts (HTTP 409). Each attempt re-runs the full GET -> merge -> PUT
 * sequence so a stale SHA is refreshed before retrying, preventing a concurrent
 * Gmail/Drive commit from permanently dropping this Drive entry.
 */
function appendMarkdownEntryToGitHubRepo(
  filePath,
  entryContent,
  commitMessage
) {
  var config = getDriveIngesterConfig()
  if (!config.githubToken) {
    console.warn(
      '[gitHubSync] GITHUB_PAT missing in ScriptProperties. Skipping GitHub sync.'
    )
    return false
  }

  var maxRetries = 3
  for (var attempt = 1; attempt <= maxRetries; attempt++) {
    var result = executeGitHubCommit(
      filePath,
      entryContent,
      commitMessage,
      config
    )
    if (result === true || result === 'IDEMPOTENT_SKIP') {
      return true
    }
    if (attempt < maxRetries) {
      console.log(
        '[gitHubSync] Retry attempt ' +
          attempt +
          ' of ' +
          maxRetries +
          ' for ' +
          filePath
      )
      Utilities.sleep(1000 * attempt)
    }
  }

  console.error(
    '[gitHubSync] Failed to commit entry to GitHub after ' +
      maxRetries +
      ' attempts: ' +
      filePath
  )
  return false
}

/**
 * Runs a single GET -> merge -> PUT commit cycle. Returns true on success,
 * 'IDEMPOTENT_SKIP' when the entry already exists, or false on any failure
 * (including HTTP 409, which the caller retries with a refreshed SHA).
 */
function executeGitHubCommit(filePath, entryContent, commitMessage, config) {
  var repoOwner = config.githubRepoOwner || 'don-petry'
  var repoName = config.githubRepoName || 'self-private'
  var url =
    'https://api.github.com/repos/' +
    repoOwner +
    '/' +
    repoName +
    '/contents/' +
    filePath

  var headers = {
    Authorization: 'token ' + config.githubToken,
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'GoogleAppsScript-DriveIngester',
  }

  try {
    var getResponse = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: headers,
      muteHttpExceptions: true,
    })

    var existingContent = ''
    var sha = null
    var statusCode = getResponse.getResponseCode()

    if (statusCode === 200) {
      var fileData = JSON.parse(getResponse.getContentText())
      if (fileData.encoding === 'none' || !fileData.content) {
        console.error(
          '[gitHubSync] File exceeds 1MB (encoding: none), skipping commit to prevent note truncation: ' +
            filePath
        )
        return false
      }
      sha = fileData.sha
      // GitHub returns Base64 wrapped in newlines every 60 chars; strip them
      // before decoding since some decoders reject embedded whitespace.
      var decodedBytes = Utilities.base64Decode(
        (fileData.content || '').replace(/[\r\n]/g, '')
      )
      existingContent = Utilities.newBlob(decodedBytes).getDataAsString()

      // Idempotency: skip when this exact entry is already present.
      if (existingContent.indexOf(entryContent.trim()) !== -1) {
        console.log(
          '[gitHubSync] Idempotent Skip: Entry already exists in ' + filePath
        )
        return 'IDEMPOTENT_SKIP'
      }
    } else if (statusCode === 404) {
      existingContent =
        '---\ntitle: ' +
        filePath.split('/')[0] +
        '\ncreated: ' +
        Utilities.formatDate(new Date(), 'GMT', 'yyyy-MM-dd') +
        '\nnotebook: self-private\nsection: index\n---\n\n## Key References & Logs\n'
    } else {
      console.error(
        '[gitHubSync] GitHub GET HTTP ' +
          statusCode +
          ': ' +
          getResponse.getContentText()
      )
      return false
    }

    var updatedContent = existingContent + '\n' + entryContent

    // Rule 6 Guard: refuse to commit an entry that already shows U+FFFD mojibake.
    assertClean_(entryContent, 'new entry for ' + filePath)

    var encodedContent = Utilities.base64Encode(
      Utilities.newBlob(updatedContent).getBytes()
    )

    // Validate the actual Base64 round trip: decode what we are about to PUT and
    // confirm no non-ASCII character was flattened to '?' at the payload boundary.
    var renderedContent = Utilities.newBlob(
      Utilities.base64Decode(encodedContent)
    ).getDataAsString()
    assertNoAsciiReplacement_(updatedContent, renderedContent)

    var payload = {
      message: commitMessage,
      content: encodedContent,
    }
    if (sha) {
      payload.sha = sha
    }

    var putResponse = UrlFetchApp.fetch(url, {
      method: 'put',
      headers: headers,
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    })

    var putStatus = putResponse.getResponseCode()
    if (putStatus === 200 || putStatus === 201) {
      console.log(
        '[gitHubSync] Successfully committed Markdown update to GitHub: ' +
          filePath
      )
      return true
    } else if (putStatus === 409) {
      console.warn(
        '[gitHubSync] SHA collision (HTTP 409) on file, will retry: ' + filePath
      )
      return false
    } else {
      console.error(
        '[gitHubSync] GitHub PUT HTTP ' +
          putStatus +
          ': ' +
          putResponse.getContentText()
      )
    }
  } catch (err) {
    console.error('[gitHubSync] Exception syncing to GitHub: ' + err.message)
  }
  return false
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    appendMarkdownEntryToGitHubRepo: appendMarkdownEntryToGitHubRepo,
    executeGitHubCommit: executeGitHubCommit,
    assertClean_: assertClean_,
    assertNoAsciiReplacement_: assertNoAsciiReplacement_,
    RULE6_PATTERNS: RULE6_PATTERNS,
  }
}
