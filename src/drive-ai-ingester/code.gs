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

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    processDriveFilesWithAiIngester: processDriveFilesWithAiIngester,
    setupFifteenMinuteDriveTrigger: setupFifteenMinuteDriveTrigger,
    stopAllDriveTriggers: stopAllDriveTriggers,
  }
}
