/**
 * Gmail to Drive processing utilities.
 *
 * Designed to be testable outside of Google Apps Script by accepting
 * objects that match the minimal interfaces used.
 */

const { getCleanBody, getFileHash } = require('../../gas-utils')

/**
 * Remove existing thread content from the document by finding the separator
 * containing the given thread ID and deleting all paragraphs from the previous
 * thread separator (or start of the document) through that separator (inclusive).
 *
 * @param {Object} body - Document body object
 * @param {string} threadId - The thread ID to search for
 * @returns {boolean} True if thread was found and removed, false otherwise
 */
function removeExistingThread(body, threadId) {
  if (!threadId) return false

  const paragraphs = body.getParagraphs()
  const threadMarker = `[THREAD:${threadId}]`

  // Find the separator containing this thread ID
  let threadSeparatorIndex = -1
  for (let i = 0; i < paragraphs.length; i++) {
    const text = paragraphs[i].getText()
    if (text.includes(threadMarker)) {
      threadSeparatorIndex = i
      break
    }
  }

  if (threadSeparatorIndex === -1) {
    console.log('[removeExistingThread] Thread not found:', threadId)
    return false // Thread not found in document
  }

  console.log(
    '[removeExistingThread] Found thread separator at paragraph',
    threadSeparatorIndex
  )

  // Find the start of this thread's content (search backwards from thread separator to previous thread separator or start)
  let threadStartIndex = 0
  for (let i = threadSeparatorIndex - 1; i >= 0; i--) {
    const text = paragraphs[i].getText()
    // Stop when we hit another thread separator (indicated by [THREAD:])
    if (text.includes('[THREAD:')) {
      threadStartIndex = i + 1 // Start after the previous thread separator
      break
    }
  }

  console.log(
    '[removeExistingThread] Removing paragraphs from',
    threadStartIndex,
    'to',
    threadSeparatorIndex
  )

  // Remove all paragraphs from threadStartIndex to threadSeparatorIndex (inclusive)
  // Remove in reverse order to avoid index shifting issues
  for (let i = threadSeparatorIndex; i >= threadStartIndex; i--) {
    const para = paragraphs[i]
    para.removeFromParent()
  }

  console.log('[removeExistingThread] Successfully removed thread:', threadId)
  return true
}

/**
 * Determine whether an attachment already exists in the folder by comparing
 * file size (fast fail) then SHA-256 hash against every existing file of the same name.
 *
 * @param {Object} existingFiles - Drive file iterator (from getFilesByName)
 * @param {Object} newFileBlob - Blob of the incoming attachment
 * @returns {boolean} True if an exact-content duplicate exists
 */
function isDuplicateAttachment(existingFiles, newFileBlob) {
  // Try getBytes() for GAS blobs, bytes property for test mocks, empty buffer as fallback.
  const newFileBytes = newFileBlob.getBytes
    ? newFileBlob.getBytes()
    : newFileBlob.bytes || Buffer.from('')
  const newFileLength = newFileBytes.length
  const newFileHash = getFileHash(newFileBlob)

  let existingCount = 0
  while (existingFiles.hasNext()) {
    existingCount++
    const existingFile = existingFiles.next()
    console.log(
      '[processMessageToDoc] Comparing with existing file',
      existingCount
    )

    // Compare sizes first (fast fail)
    if (existingFile.getSize() !== newFileLength) {
      console.log('[processMessageToDoc] Size mismatch - different file')
      continue
    }

    console.log('[processMessageToDoc] Size match, checking hash')
    if (getFileHash(existingFile.getBlob()) === newFileHash) {
      console.log('[processMessageToDoc] Hash match - duplicate detected')
      return true
    }
    console.log('[processMessageToDoc] Hash mismatch - different content')
  }
  return false
}

/**
 * Resolve a name conflict for a new attachment. If a file with the same name
 * already exists, append a timestamp before the extension and rename the blob.
 *
 * @param {Object} folder - Drive folder object
 * @param {string} fileName - Original attachment name
 * @param {Object} newFileBlob - Blob to rename in place
 * @param {Object} options - Optional GAS services (Utilities, Session)
 * @returns {string} The final (possibly renamed) file name
 */
function resolveAttachmentName(folder, fileName, newFileBlob, options) {
  if (!folder.getFilesByName(fileName).hasNext()) {
    return fileName
  }

  console.log('[processMessageToDoc] Name conflict detected, adding timestamp')
  const { Utilities, Session } = options
  const timeTag =
    Utilities && Session
      ? Utilities.formatDate(
          new Date(),
          Session.getScriptTimeZone(),
          '_HHmmssSSS'
        )
      : '_' + Date.now()
  const renamed = fileName.replace(/(\.[\w-]+)$/i, timeTag + '$1')
  const finalName = renamed === fileName ? fileName + timeTag : renamed

  if (newFileBlob.setName) {
    newFileBlob.setName(finalName)
  }
  console.log('[processMessageToDoc] Renamed to:', finalName)
  return finalName
}

/**
 * Process a single attachment: check for duplicates, save to Drive if new, and
 * insert a reference paragraph in the document. Returns the updated index.
 *
 * @param {Object} att - Attachment blob from Gmail message
 * @param {Object} body - Document body object
 * @param {Object} folder - Drive folder object
 * @param {number} currentIndex - Current paragraph insertion index
 * @param {Object} options - GAS services passed through (Logger, Utilities, Session)
 * @param {number} attIndex - Zero-based index of this attachment (for logging)
 * @param {number} totalCount - Total number of attachments (for logging)
 * @returns {number} Updated paragraph insertion index
 */
function processSingleAttachment(
  att,
  body,
  folder,
  currentIndex,
  options,
  attIndex,
  totalCount
) {
  const { Logger } = options
  console.log(
    '[processMessageToDoc] Processing attachment',
    attIndex + 1,
    'of',
    totalCount,
    ':',
    att.getName()
  )
  const fileName = att.getName()
  // In GAS environment, copyBlob() creates a copy; in test environment, att itself is the blob
  const newFileBlob = att.copyBlob ? att.copyBlob() : att
  const existingFiles = folder.getFilesByName(fileName)
  console.log(
    '[processMessageToDoc] Checking for existing files named:',
    fileName
  )
  if (isDuplicateAttachment(existingFiles, newFileBlob)) {
    if (Logger) Logger.log('Skipping exact duplicate: ' + fileName)
    console.log('[processMessageToDoc] Skipping duplicate:', fileName)
    body.insertParagraph(currentIndex++, '- [DUPLICATE SKIPPED] ' + fileName)
  } else {
    const finalName = resolveAttachmentName(
      folder,
      fileName,
      newFileBlob,
      options
    )
    console.log('[processMessageToDoc] Saving new file:', finalName)
    const file = folder.createFile(newFileBlob)
    body.insertParagraph(currentIndex++, '- ' + file.getName())
    console.log('[processMessageToDoc] File saved successfully')
  }
  return currentIndex
}

/**
 * Process a single message and prepend its content to the document body.
 * Returns the number of paragraphs inserted.
 *
 * @param {Object} message - Gmail message object
 * @param {Object} body - Document body object
 * @param {Object} folder - Drive folder object
 * @param {Object} options - Optional settings (DocumentApp, Utilities, Logger, Session for GAS)
 * @returns {number} Number of paragraphs inserted
 */
function processMessageToDoc(message, body, folder, options = {}) {
  const { DocumentApp, Utilities, Logger } = options

  const subject = message.getSubject()
  const rawContent = message.getPlainBody()
  const cleanContent = getCleanBody(rawContent)
  const timestamp = message.getDate()

  if (Logger) {
    Logger.log('Processing: ' + subject)
  }
  console.log('[processMessageToDoc] Processing message:', subject)

  let currentIndex = 0

  // Insert subject
  const subjectText = 'Subject: ' + (subject || '(No Subject)')
  const headingPara = body.insertParagraph(currentIndex++, subjectText)

  // Try to set heading style (GAS only)
  if (DocumentApp) {
    try {
      headingPara.setHeading(DocumentApp.ParagraphHeading.HEADING_3)
    } catch (e) {
      const style = {}
      style[DocumentApp.Attribute.BOLD] = true
      headingPara.setAttributes(style)
    }
  }

  // Insert date and content
  body.insertParagraph(currentIndex++, 'Date: ' + timestamp)
  body.insertParagraph(currentIndex++, cleanContent)

  // Process attachments
  const attachments = message.getAttachments()
  console.log('[processMessageToDoc] Found', attachments.length, 'attachments')

  if (attachments.length > 0) {
    body.insertParagraph(currentIndex++, '[Attachments]:')
    attachments.forEach((att, attIndex) => {
      currentIndex = processSingleAttachment(
        att,
        body,
        folder,
        currentIndex,
        options,
        attIndex,
        attachments.length
      )
    })
  }

  // Insert separator - use thread separator for bottom message (oldest, first in sorted array) if threadId provided
  const { threadId, isBottomMessage } = options
  if (threadId && isBottomMessage) {
    const separator = `------------------------------[THREAD:${threadId}]`
    body.insertParagraph(currentIndex++, separator)
    console.log('[processMessageToDoc] Added thread separator:', threadId)
  } else {
    body.insertParagraph(currentIndex++, '------------------------------')
  }

  // Pause in GAS environment to prevent crashes
  if (Utilities) {
    Utilities.sleep(500)
  }

  return currentIndex
}

/**
 * Process multiple messages from a thread, prepending them to the document.
 * Messages are sorted by date (oldest first) so newest appear at top.
 * If a threadId is provided, any existing content for that thread will be removed first,
 * and the last message separator will be replaced with a thread separator containing the ID.
 *
 * @param {Array} messages - Array of Gmail message objects
 * @param {Object} body - Document body object
 * @param {Object} folder - Drive folder object
 * @param {Object} options - Optional settings (threadId, DocumentApp, Utilities, Logger, Session for GAS)
 * @returns {number} Total number of messages processed
 */
function processMessagesToDoc(messages, body, folder, options = {}) {
  const { threadId } = options

  // If threadId is provided, remove any existing content for this thread
  if (threadId) {
    removeExistingThread(body, threadId)
  }

  // Sort messages by date (oldest first) so when we prepend (insert at index 0),
  // the newest messages end up at the top of the document
  const sortedMessages = messages.slice().sort(function (a, b) {
    return a.getDate().getTime() - b.getDate().getTime()
  })

  sortedMessages.forEach((message, msgIndex) => {
    console.log(
      '[processMessagesToDoc] Processing message',
      msgIndex + 1,
      'of',
      sortedMessages.length
    )
    // The first message in sorted array (oldest) will be inserted last and end up at bottom
    // So it should get the thread separator
    const isBottomMessage = msgIndex === 0
    processMessageToDoc(message, body, folder, { ...options, isBottomMessage })
  })

  // Add a clear separator between threads (after all messages in a thread are processed)
  if (sortedMessages.length > 0) {
    body.insertParagraph(0, '==============================')
  }

  return sortedMessages.length
}

/**
 * Sort threads by their last message date in reverse chronological order (newest first).
 * This ensures threads are always processed in the correct order regardless of how
 * the Gmail API returns them or when they were labeled.
 *
 * @param {Array} threads - Array of Gmail thread objects
 * @returns {Array} Sorted array of threads (newest first)
 */
/**
 * Sort threads by last message date (oldest first) for prepend-based processing.
 * Since messages are prepended at index 0, sorting oldest-first ensures the newest
 * thread is processed last and ends up at the top of the document.
 *
 * @param {Array} threads - Array of Gmail thread objects
 * @returns {Array} Sorted array of threads (oldest first)
 */
function sortThreadsByLastMessageDate(threads) {
  return threads.slice().sort(function (a, b) {
    const aMessages = a.getMessages()
    const bMessages = b.getMessages()
    const aLastDate = aMessages[aMessages.length - 1].getDate().getTime()
    const bLastDate = bMessages[bMessages.length - 1].getDate().getTime()
    return aLastDate - bLastDate // Ascending order (oldest first)
  })
}

/**
 * Main function to process all configurations.
 * Reads settings and processes each label group.
 *
 * @param {Array} configs - Array of configuration objects
 * @param {Function} processLabelGroupFn - Function to process each label group
 */
function storeEmailsAndAttachments(configs, processLabelGroupFn) {
  console.log('[storeEmailsAndAttachments] Starting email processing')
  console.log(
    '[storeEmailsAndAttachments] Processing',
    configs.length,
    'configurations'
  )

  configs.forEach((config, index) => {
    console.log(
      '[storeEmailsAndAttachments] Processing config',
      index + 1,
      'of',
      configs.length,
      ':',
      config.triggerLabel
    )
    processLabelGroupFn(config)
  })
  console.log('[storeEmailsAndAttachments] Completed all processing')
}

/**
 * Processes a single configuration group (Label -> Doc + Folder).
 * Extracts threads from trigger label, processes them, and moves to processed label.
 *
 * @param {Object} config - Configuration object with triggerLabel, processedLabel, docId, folderId
 * @param {Object} services - GAS services object with GmailApp, DocumentApp, DriveApp, Logger, Utilities, Session
 * @param {Object} helperFns - Helper functions object with getCleanBody, getFileHash, removeExistingThreadFromDoc
 */
function processLabelGroup(config, services, helperFns) {
  const { GmailApp, DocumentApp, DriveApp, Logger, Utilities, Session } =
    services
  const { getCleanBody, getFileHash, removeExistingThreadFromDoc } = helperFns

  console.log(
    '[processLabelGroup] Starting processing for:',
    config.triggerLabel
  )
  const triggerLabelName = config.triggerLabel
  const processedLabelName = config.processedLabel

  // 1. Validate Labels
  console.log('[processLabelGroup] Looking up trigger label:', triggerLabelName)
  const triggerLabel = GmailApp.getUserLabelByName(triggerLabelName)
  let processedLabel = GmailApp.getUserLabelByName(processedLabelName)

  // Create processed label if it doesn't exist
  if (!processedLabel) {
    console.log(
      '[processLabelGroup] Processed label not found, creating:',
      processedLabelName
    )
    try {
      processedLabel = GmailApp.createLabel(processedLabelName)
      console.log('[processLabelGroup] Created label:', processedLabelName)
    } catch (e) {
      Logger.log('Could not create label: ' + processedLabelName)
      console.error('[processLabelGroup] Error creating label:', e.message)
    }
  }

  if (!triggerLabel) {
    Logger.log('Trigger label not found: ' + triggerLabelName)
    console.error(
      '[processLabelGroup] Trigger label not found:',
      triggerLabelName
    )
    return
  }

  // 2. Get Threads
  console.log(
    '[processLabelGroup] Retrieving threads for label:',
    triggerLabelName
  )
  const threads = triggerLabel.getThreads()
  if (!threads || threads.length === 0) {
    Logger.log('No emails found for: ' + triggerLabelName)
    console.log(
      '[processLabelGroup] No threads found for label:',
      triggerLabelName
    )
    return
  }
  console.log('[processLabelGroup] Found', threads.length, 'threads to process')

  // Sort threads by last message date (newest first) to ensure reverse chronological order
  // This handles cases where Gmail API returns threads in random order or when older threads are labeled
  const sortedThreads = sortThreadsByLastMessageDate(threads)
  console.log(
    '[processLabelGroup] Sorted threads by last message date (newest first)'
  )

  // 3. Open Destination Doc and Folder
  console.log(
    '[processLabelGroup] Opening doc:',
    config.docId,
    'and folder:',
    config.folderId
  )
  let doc, body, folder
  try {
    doc = DocumentApp.openById(config.docId)
    body = doc.getBody()
    folder = DriveApp.getFolderById(config.folderId)
    console.log('[processLabelGroup] Successfully opened doc and folder')
  } catch (e) {
    Logger.log(
      'Error opening Doc or Folder. Check IDs in Config.gs. Error: ' + e.message
    )
    console.error('[processLabelGroup] Error opening Doc/Folder:', e.message)
    return
  }

  // 4. Process Emails
  let totalMessages = 0
  sortedThreads.forEach((thread, threadIndex) => {
    const messages = thread.getMessages()
    const threadId = thread.getId()
    console.log(
      '[processLabelGroup] Thread',
      threadIndex + 1,
      'has',
      messages.length,
      'messages, ID:',
      threadId
    )

    // Remove existing thread content if it already exists in the document
    removeExistingThreadFromDoc(body, threadId)

    // Sort messages by date (oldest first) so when we prepend (insert at index 0),
    // the newest messages end up at the top of the document
    messages.sort(function (a, b) {
      return a.getDate().getTime() - b.getDate().getTime()
    })

    messages.forEach((message, msgIndex) => {
      totalMessages++
      const subject = message.getSubject()
      const rawContent = message.getPlainBody()

      // Clean Content (removes replies, quote lines, and legal footers)
      const cleanContent = getCleanBody(rawContent)
      console.log(
        '[processLabelGroup] Cleaned content length:',
        cleanContent.length,
        'chars (from',
        rawContent.length,
        ')'
      )

      const timestamp = message.getDate()

      Logger.log('Processing: ' + subject)
      console.log(
        '[processLabelGroup] Processing message',
        msgIndex + 1,
        ':',
        subject
      )

      // --- A. Prepend Text to Doc (insert at top, newest first) ---
      // Note: currentIndex starts at 0 for each message, so each new message
      // is inserted at the top of the document, pushing previous content down.
      // This ensures the most recent emails appear first.
      let currentIndex = 0

      const subjectText = 'Subject: ' + (subject || '(No Subject)')
      const headingPara = body.insertParagraph(currentIndex++, subjectText)

      // Try to set heading, fallback to bold if Doc is busy
      try {
        headingPara.setHeading(DocumentApp.ParagraphHeading.HEADING_3)
      } catch (e) {
        const style = {}
        style[DocumentApp.Attribute.BOLD] = true
        headingPara.setAttributes(style)
      }

      body.insertParagraph(currentIndex++, 'Date: ' + timestamp)
      body.insertParagraph(currentIndex++, cleanContent)

      // --- B. Save Attachments (CONTENT-BASED DEDUPLICATION) ---
      const attachments = message.getAttachments()
      console.log(
        '[processLabelGroup] Found',
        attachments.length,
        'attachments'
      )
      if (attachments.length > 0) {
        body.insertParagraph(currentIndex++, '[Attachments]:')

        attachments.forEach((att, attIndex) => {
          console.log(
            '[processLabelGroup] Processing attachment',
            attIndex + 1,
            'of',
            attachments.length,
            ':',
            att.getName()
          )
          let fileName = att.getName()
          const newFileBlob = att.copyBlob()
          let isDuplicate = false

          // 1. Get all files in folder with this name
          const existingFiles = folder.getFilesByName(fileName)
          console.log(
            '[processLabelGroup] Checking for existing files named:',
            fileName
          )

          let existingCount = 0
          while (existingFiles.hasNext()) {
            existingCount++
            const existingFile = existingFiles.next()
            console.log(
              '[processLabelGroup] Comparing with existing file',
              existingCount
            )

            // 2. Fast Fail: Compare sizes first
            if (existingFile.getSize() === newFileBlob.getBytes().length) {
              console.log('[processLabelGroup] Size match, checking hash')

              // 3. Deep Check: Compare SHA-256 Hashes (The "Fingerprint")
              const existingHash = getFileHash(existingFile.getBlob())
              const newHash = getFileHash(newFileBlob)

              if (existingHash === newHash) {
                console.log(
                  '[processLabelGroup] Hash match - duplicate detected'
                )
                isDuplicate = true
                break // Stop checking, we found the twin
              } else {
                console.log(
                  '[processLabelGroup] Hash mismatch - different content'
                )
              }
            } else {
              console.log('[processLabelGroup] Size mismatch - different file')
            }
          }

          if (isDuplicate) {
            Logger.log('Skipping exact duplicate: ' + fileName)
            console.log('[processLabelGroup] Skipping duplicate:', fileName)
            body.insertParagraph(
              currentIndex++,
              '- [DUPLICATE SKIPPED] ' + fileName
            )
          } else {
            // It's a new file (or a file with same name but different content)

            // If name exists but content is different, rename to avoid overwrite
            if (folder.getFilesByName(fileName).hasNext()) {
              console.log(
                '[processLabelGroup] Name conflict detected, adding timestamp'
              )
              const timeTag = Utilities.formatDate(
                new Date(),
                Session.getScriptTimeZone(),
                '_HHmmss'
              )
              // Insert timestamp before the file extension
              let newName = fileName.replace(/(\.[\w-]+)$/i, timeTag + '$1')
              // Fallback if regex fails (files without extension)
              if (newName === fileName) newName += timeTag

              newFileBlob.setName(newName)
              fileName = newName // Update for log
              console.log('[processLabelGroup] Renamed to:', fileName)
            }

            console.log('[processLabelGroup] Saving new file:', fileName)
            const file = folder.createFile(newFileBlob)
            body.insertParagraph(currentIndex++, '- ' + file.getName())
            console.log('[processLabelGroup] File saved successfully')
          }
        })
      }

      // Add separator - use thread separator for oldest message (first in sorted array)
      const isOldestMessage = msgIndex === 0
      if (isOldestMessage) {
        const threadSeparator =
          '------------------------------[THREAD:' + threadId + ']'
        body.insertParagraph(currentIndex++, threadSeparator)
        console.log(
          '[processLabelGroup] Added thread separator for thread:',
          threadId
        )
      } else {
        body.insertParagraph(currentIndex++, '------------------------------')
      }

      // Pause briefly to allow Google Doc to save (prevents crash)
      Utilities.sleep(500)
    })

    // 5. Cleanup Labels
    console.log('[processLabelGroup] Updating labels for thread')
    triggerLabel.removeFromThread(thread)
    if (processedLabel) processedLabel.addToThread(thread)
  })
  console.log('[processLabelGroup] Processed', totalMessages, 'total messages')
  console.log(
    '[processLabelGroup] Completed processing for:',
    config.triggerLabel
  )
}

/**
 * Rebuild all configured documents.
 *
 * @param {Array} configs - Array of configuration objects
 * @param {Function} rebuildDocFn - Function to rebuild a single doc
 * @returns {boolean} True if all completed, false if paused
 */
function rebuildAllDocs(configs, rebuildDocFn) {
  console.log('[rebuildAllDocs] Starting rebuild process')
  console.log('[rebuildAllDocs] Rebuilding', configs.length, 'configurations')

  let completed = true
  for (let i = 0; i < configs.length; i++) {
    const config = configs[i]
    console.log(
      '[rebuildAllDocs] Rebuilding config',
      i + 1,
      'of',
      configs.length,
      ':',
      config.triggerLabel
    )
    const configCompleted = rebuildDocFn(config)
    if (!configCompleted) {
      console.log(
        '[rebuildAllDocs] Paused due to time constraints. Run rebuildAllDocs() again to continue.'
      )
      completed = false
      break
    }
  }

  if (completed) {
    console.log('[rebuildAllDocs] Rebuild preparation complete.')
    console.log(
      '[rebuildAllDocs] Now run storeEmailsAndAttachments() to reprocess all emails.'
    )
  }

  return completed
}

/**
 * Clear the rebuild target document and advance the persisted state to the
 * email-moving phase. Returns false if the document could not be opened/cleared
 * so the caller can retry on the next execution.
 *
 * @param {Object} config - Configuration object
 * @param {Object} DocumentApp - GAS DocumentApp service
 * @param {Object} properties - PropertiesService user-properties store
 * @param {string} stateKey - Key under which rebuild state is persisted
 * @param {Object} state - Mutable rebuild state object
 * @returns {boolean} True if cleared successfully, false to retry later
 */
function clearRebuildDocument(
  config,
  DocumentApp,
  properties,
  stateKey,
  state
) {
  console.log('[rebuildDoc] Clearing document:', config.docId)
  try {
    const doc = DocumentApp.openById(config.docId)
    // Clear all content from the document body in a single operation
    doc.getBody().setText('')
    console.log('[rebuildDoc] Document cleared')

    // Move to next phase
    state.phase = 'move_emails'
    state.processedCount = 0
    properties.setProperty(stateKey, JSON.stringify(state))
    console.log('[rebuildDoc] Saved state, moving to email processing phase')
    return true
  } catch (e) {
    console.error('[rebuildDoc] Error clearing document:', e.message)
    // Try again next time
    return false
  }
}

/**
 * Move threads from the processed label back to the trigger label in a single
 * time-boxed batch, persisting progress. Returns false if the work is not yet
 * complete (time limit reached or threads remain) so the caller can rerun.
 *
 * @param {Object} labels - { triggerLabel, processedLabel } Gmail labels
 * @param {Object} properties - PropertiesService user-properties store
 * @param {string} stateKey - Key under which rebuild state is persisted
 * @param {Object} state - Mutable rebuild state object
 * @param {Object} limits - { startTime, maxExecutionTime, batchSize }
 * @returns {boolean} True if all threads moved, false to rerun
 */
function moveProcessedThreads(labels, properties, stateKey, state, limits) {
  const { triggerLabel, processedLabel } = labels
  const { startTime, maxExecutionTime, batchSize } = limits

  console.log('[rebuildDoc] Moving emails from processed to trigger label')
  console.log(
    '[rebuildDoc] Resuming from:',
    state.processedCount,
    'threads processed'
  )

  const threads = processedLabel.getThreads()
  console.log('[rebuildDoc] Found', threads.length, 'threads to move')

  // Process in batches, always from index 0 since we're removing items
  let batchCount = 0
  while (batchCount < batchSize && threads.length > 0) {
    // Check if we're running out of time
    if (Date.now() - startTime > maxExecutionTime) {
      console.log('[rebuildDoc] Approaching time limit, saving progress')
      state.processedCount += batchCount
      properties.setProperty(stateKey, JSON.stringify(state))
      return false // Not complete, run again
    }

    // Always process index 0 since removing items shrinks the array
    const thread = threads[0]
    processedLabel.removeFromThread(thread)
    triggerLabel.addToThread(thread)
    batchCount++

    // Refresh threads array
    threads.splice(0, 1)
  }

  console.log('[rebuildDoc] Moved', batchCount, 'threads in this batch')
  state.processedCount += batchCount

  // Check if we're done. If the local queue is non-empty we hit the batch
  // size limit and can skip the API call — we already know threads remain.
  if (threads.length === 0) {
    const remainingCount = processedLabel.getThreads().length
    if (remainingCount === 0) {
      console.log('[rebuildDoc] All threads moved')
      state.phase = 'complete'
      properties.setProperty(stateKey, JSON.stringify(state))
      return true
    }
    console.log('[rebuildDoc] Still', remainingCount, 'threads remaining')
  } else {
    console.log(
      '[rebuildDoc] Still',
      threads.length,
      'threads remaining in current batch'
    )
  }
  properties.setProperty(stateKey, JSON.stringify(state))
  return false // Not complete, need to run again
}

/**
 * Rebuilds a single document by clearing it and moving processed emails back to trigger label.
 * Uses batching and state tracking to handle large label sets without timing out.
 *
 * @param {Object} config - Configuration object
 * @param {Object} services - GAS services object with GmailApp, DocumentApp, PropertiesService
 * @returns {boolean} True if completed, false if needs to continue in another execution
 */
function rebuildDoc(config, services) {
  const { GmailApp, DocumentApp, PropertiesService } = services
  const maxExecutionTime = 4 * 60 * 1000 // 4 minutes (leaving 2 min buffer for 6 min limit)
  const parsedBatchSize = Number.parseInt(config.batchSize, 10)
  const batchSize = parsedBatchSize > 0 ? parsedBatchSize : 250
  const startTime = Date.now()

  console.log('[rebuildDoc] Starting rebuild for:', config.triggerLabel)

  const triggerLabelName = config.triggerLabel
  const processedLabelName = config.processedLabel
  const stateKey =
    'rebuild_state_' + triggerLabelName.replace(/[^a-zA-Z0-9]/g, '_')

  // 1. Validate and get labels
  console.log('[rebuildDoc] Looking up labels')
  const triggerLabel = GmailApp.getUserLabelByName(triggerLabelName)
  const processedLabel = GmailApp.getUserLabelByName(processedLabelName)

  if (!triggerLabel) {
    console.error('[rebuildDoc] Trigger label not found:', triggerLabelName)
    return true // Nothing to do, consider complete
  }

  if (!processedLabel) {
    console.log(
      '[rebuildDoc] Processed label not found:',
      processedLabelName,
      '- nothing to unarchive'
    )
  }

  // 2. Check if we need to clear the document (only on first run)
  const properties = PropertiesService.getUserProperties()
  const rebuildState = properties.getProperty(stateKey)
  const state = rebuildState ? JSON.parse(rebuildState) : { phase: 'clear_doc' }

  if (
    state.phase === 'clear_doc' &&
    !clearRebuildDocument(config, DocumentApp, properties, stateKey, state)
  ) {
    return false // Clearing failed; retry next execution
  }

  // 3. Move emails from processed back to trigger label (batched)
  if (state.phase === 'move_emails' && processedLabel) {
    const complete = moveProcessedThreads(
      { triggerLabel, processedLabel },
      properties,
      stateKey,
      state,
      { startTime, maxExecutionTime, batchSize }
    )
    if (!complete) {
      return false // Not complete, need to run again
    }
  }

  // If we got here, we're done
  properties.deleteProperty(stateKey)
  console.log('[rebuildDoc] Rebuild complete for:', config.triggerLabel)
  console.log(
    '[rebuildDoc] Run storeEmailsAndAttachments() to reprocess these emails'
  )
  return true
}

module.exports = {
  processMessageToDoc,
  processMessagesToDoc,
  sortThreadsByLastMessageDate,
  removeExistingThread,
  resolveAttachmentName,
  storeEmailsAndAttachments,
  processLabelGroup,
  rebuildAllDocs,
  rebuildDoc,
}
