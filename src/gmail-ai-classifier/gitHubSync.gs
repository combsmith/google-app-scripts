/**
 * Native Google Apps Script GitHub Sync Module (Auto-Create & Long Document Aware)
 * Calls GitHub REST API via UrlFetchApp to commit Markdown entries directly to a configured GitHub repository.
 *
 * Features:
 * - Auto-creates missing target markdown files on GitHub (HTTP 404 handling)
 * - SHA Collision & Retry Guard (catches HTTP 409 API conflicts & retries)
 * - Section-Aware Targeted Insertion (inserts entries into Section 3 log blocks)
 * - Idempotency Guard (skips duplicate entries)
 */

var GITHUB_SYNC_RULE6_PATTERNS_ = [
  [/\S \? \S/, "' ? ' between words (was an em dash or a · separator)"],
  [/\?\?/, "'??' (was a multi-codepoint emoji)"],
  [/[A-Za-z]\?[A-Za-z]/, "'?' inside a word (was a curly apostrophe)"],
  [/\uFFFD/, 'U+FFFD replacement character'],
]

/** Refuse to write an entry that already shows mojibake. */
function assertClean_(text, what) {
  if (!text) return
  var stripped = String(text).replace(/https?:\/\/\S+/g, '')
  for (var i = 0; i < GITHUB_SYNC_RULE6_PATTERNS_.length; i++) {
    if (GITHUB_SYNC_RULE6_PATTERNS_[i][0].test(stripped)) {
      throw new Error(
        'Rule 6: refusing to write ' +
          what +
          ' — ' +
          GITHUB_SYNC_RULE6_PATTERNS_[i][1]
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
 * Resolves GitHub repository owner and name lazily from services, ScriptProperties, config, or environment.
 */
function resolveGitHubRepoTarget_(services) {
  var propsService =
    (services && services.PropertiesService) ||
    (typeof PropertiesService !== 'undefined' ? PropertiesService : null)
  var scriptProps =
    propsService && typeof propsService.getScriptProperties === 'function'
      ? propsService.getScriptProperties()
      : null
  var getProp = function (key) {
    return scriptProps && typeof scriptProps.getProperty === 'function'
      ? scriptProps.getProperty(key)
      : null
  }

  var cfgOwner = ''
  var cfgName = ''
  try {
    if (typeof getAiClassifierConfig === 'function') {
      var cfg = getAiClassifierConfig()
      cfgOwner = (cfg && cfg.githubRepoOwner) || ''
      cfgName = (cfg && cfg.githubRepoName) || ''
    }
  } catch (e) {
    // Ignore config resolution errors in restricted scopes
  }

  var envOwner =
    typeof process !== 'undefined' &&
    process &&
    process.env &&
    process.env.GITHUB_REPO_OWNER
      ? process.env.GITHUB_REPO_OWNER
      : ''
  var envName =
    typeof process !== 'undefined' &&
    process &&
    process.env &&
    process.env.GITHUB_REPO_NAME
      ? process.env.GITHUB_REPO_NAME
      : ''

  var repoOwner =
    (services && services.githubRepoOwner) ||
    getProp('GITHUB_REPO_OWNER') ||
    cfgOwner ||
    envOwner ||
    ''
  var repoName =
    (services && services.githubRepoName) ||
    getProp('GITHUB_REPO_NAME') ||
    cfgName ||
    envName ||
    ''

  return { repoOwner: repoOwner.trim(), repoName: repoName.trim() }
}

/**
 * Appends a Progressive Disclosure entry to a target markdown file via GitHub REST API.
 * Automatically creates the file with valid front-matter if it does not exist yet (HTTP 404).
 */
function appendMarkdownEntryToGitHubRepo(
  filePath,
  entryMd,
  commitMessage,
  services
) {
  var props =
    (services && services.PropertiesService) ||
    (typeof PropertiesService !== 'undefined' ? PropertiesService : null)
  var scriptProps =
    props && typeof props.getScriptProperties === 'function'
      ? props.getScriptProperties()
      : null
  var githubToken =
    scriptProps && typeof scriptProps.getProperty === 'function'
      ? scriptProps.getProperty('GITHUB_PAT')
      : null
  if (!githubToken) {
    console.log(
      '[gitHubSync] GITHUB_PAT ScriptProperty not set. Skipping GitHub commit.'
    )
    recordGitHubSyncStatus_(services, 'NO_TOKEN', filePath)
    return false
  }

  var sleepFn =
    (services && services.sleepFn) ||
    function (ms) {
      if (
        typeof Utilities !== 'undefined' &&
        Utilities &&
        typeof Utilities.sleep === 'function'
      ) {
        Utilities.sleep(ms)
      }
    }

  var maxRetries = 3
  var result = false
  for (var attempt = 1; attempt <= maxRetries; attempt++) {
    result = executeGitHubCommit(
      filePath,
      entryMd,
      commitMessage,
      githubToken,
      services
    )
    if (result === true || result === 'IDEMPOTENT_SKIP') {
      recordGitHubSyncStatus_(
        services,
        result === true ? 'OK' : 'IDEMPOTENT_SKIP',
        filePath
      )
      return true
    }
    // Configuration and size failures cannot succeed on retry.
    if (result === 'NOT_CONFIGURED' || result === 'FILE_TOO_LARGE') {
      break
    }
    console.log(
      '[gitHubSync] Retry attempt',
      attempt,
      'of',
      maxRetries,
      'for',
      filePath
    )
    sleepFn(1000 * attempt)
  }

  console.error(
    '[gitHubSync] Failed to commit entry to GitHub after',
    attempt > maxRetries ? maxRetries : attempt,
    'attempts:',
    filePath
  )
  recordGitHubSyncStatus_(
    services,
    typeof result === 'string' ? result : 'FAILED',
    filePath
  )
  return false
}

/**
 * Records the outcome of the latest GitHub sync attempt in the
 * GITHUB_SYNC_LAST_STATUS ScriptProperty ("<ISO time> <STATUS> <path>"), so a
 * silent outage (expired PAT, unset repo, oversized note) is visible in
 * Project Settings instead of only in execution logs. Best effort.
 */
function recordGitHubSyncStatus_(services, status, filePath) {
  try {
    var propsService =
      (services && services.PropertiesService) ||
      (typeof PropertiesService !== 'undefined' ? PropertiesService : null)
    var scriptProps =
      propsService && typeof propsService.getScriptProperties === 'function'
        ? propsService.getScriptProperties()
        : null
    if (scriptProps && typeof scriptProps.setProperty === 'function') {
      scriptProps.setProperty(
        'GITHUB_SYNC_LAST_STATUS',
        new Date().toISOString() + ' ' + status + ' ' + (filePath || '')
      )
    }
  } catch (e) {
    // Status breadcrumbs must never break ingestion
  }
}

/** Returns the `<!-- source: ... -->` idempotency marker in an entry, or ''. */
function extractEntrySourceMarker_(entryMd) {
  var m = /<!-- source: [^\n]*? -->/.exec(String(entryMd || ''))
  return m ? m[0] : ''
}

/**
 * Performs a single commit transaction via GitHub REST API with 404 Auto-Create & 409 SHA retry handling.
 */
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

  var target = resolveGitHubRepoTarget_(services)
  if (!target.repoOwner || !target.repoName) {
    console.warn(
      '[gitHubSync] GITHUB_REPO_OWNER or GITHUB_REPO_NAME not configured. Skipping GitHub commit.'
    )
    return 'NOT_CONFIGURED'
  }

  var urlFetchApp =
    (services && services.UrlFetchApp) ||
    (typeof UrlFetchApp !== 'undefined' ? UrlFetchApp : null)
  var utils =
    (services && services.Utilities) ||
    (typeof Utilities !== 'undefined' ? Utilities : null)

  var encodedPath = String(filePath)
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/')
  var url =
    'https://api.github.com/repos/' +
    encodeURIComponent(target.repoOwner) +
    '/' +
    encodeURIComponent(target.repoName) +
    '/contents/' +
    encodedPath
  var headers = {
    Authorization: 'Bearer ' + githubToken,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'Google-Apps-Script',
  }

  try {
    var getOptions = {
      method: 'get',
      headers: headers,
      muteHttpExceptions: true,
    }
    var res = urlFetchApp.fetch(url, getOptions)
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
      var dateStr =
        utils && typeof utils.formatDate === 'function'
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
      var fileData = JSON.parse(res.getContentText())
      sha = fileData.sha
      // Files over 1 MB come back with encoding "none" and empty content.
      // Decoding that as "" and PUTting would replace the whole note with a
      // single entry, so refuse instead.
      var reportedSize = Number(fileData.size) || 0
      if (
        fileData.encoding === 'none' ||
        (!fileData.content && reportedSize > 0)
      ) {
        console.error(
          '[gitHubSync] ' +
            filePath +
            ' is over the GitHub Contents API 1 MB read limit (size ' +
            reportedSize +
            '); refusing to overwrite it. Shard the log (NOTE_LOG_SHARDING) or archive older entries.'
        )
        return 'FILE_TOO_LARGE'
      }
      if (reportedSize > 800000) {
        console.warn(
          '[gitHubSync] ' +
            filePath +
            ' is ' +
            reportedSize +
            ' bytes, approaching the 1 MB Contents API limit.'
        )
      }
      // GitHub Contents API wraps Base64 in newlines every 60 chars; strip them
      // before decoding since some decoders reject embedded whitespace.
      rawContent = utils
        .newBlob(
          utils.base64Decode((fileData.content || '').replace(/[\r\n]/g, ''))
        )
        .getDataAsString()
      if (!rawContent && reportedSize > 0) {
        console.error(
          '[gitHubSync] Decoded ' +
            filePath +
            ' to empty text despite size ' +
            reportedSize +
            '; refusing to overwrite it.'
        )
        return 'FILE_TOO_LARGE'
      }

      // Idempotency: entries carrying a source marker are keyed on the source
      // message; legacy entries fall back to exact-text matching.
      var marker = extractEntrySourceMarker_(entryMd)
      var alreadyPresent = marker
        ? rawContent.indexOf(marker) !== -1
        : rawContent.indexOf(entryMd.trim()) !== -1 ||
          (commitMessage && rawContent.indexOf(commitMessage) !== -1)
      if (alreadyPresent) {
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

    var base64Updated = utils.base64Encode(
      utils.newBlob(updatedContent).getBytes()
    )

    // Validate the ACTUAL Base64 round trip at the payload boundary: decode what
    // we are about to PUT and confirm no non-ASCII character was flattened to
    // '?'.
    var renderedContent = utils
      .newBlob(utils.base64Decode(base64Updated))
      .getDataAsString()
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

    var putRes = urlFetchApp.fetch(url, putOptions)
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
  // Shard files (<domain>/activity/2026-Q4.md) are titled after their domain
  // and period rather than the generic "activity" folder.
  if (parts.length > 2 && topic === 'activity') {
    return (
      parts[parts.length - 3] +
      ' activity log ' +
      parts[parts.length - 1].replace(/\.[^.]+$/, '')
    )
  }
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

  var section3Marker = '## 3. Ingested Activity'
  var section3Index = fullContent.indexOf(section3Marker)
  var detailsMarker = '</details>'
  // Scope the </details> search to the Activity Log section so earlier
  // collapsible blocks (Layer 1/2 summaries) are never targeted. Fall back to
  // the first </details> only when the note has no Section 3 marker.
  var detailsIndex =
    section3Index !== -1
      ? fullContent.indexOf(detailsMarker, section3Index)
      : fullContent.indexOf(detailsMarker)

  if (detailsIndex !== -1) {
    return (
      fullContent.substring(0, detailsIndex) +
      newEntry +
      '\n' +
      fullContent.substring(detailsIndex)
    )
  }

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
    resolveGitHubRepoTarget_: resolveGitHubRepoTarget_,
    recordGitHubSyncStatus_: recordGitHubSyncStatus_,
    extractEntrySourceMarker_: extractEntrySourceMarker_,
    assertClean_: assertClean_,
    assertNoAsciiReplacement_: assertNoAsciiReplacement_,
    RULE6_PATTERNS: GITHUB_SYNC_RULE6_PATTERNS_,
  }
}
