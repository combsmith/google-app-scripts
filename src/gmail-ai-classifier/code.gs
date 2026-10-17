/**
 * Main entry point for Gemini AI-Powered Semantic Email Classification and Auto-Filter Engine.
 * Runs natively inside Google Apps Script (V8 runtime).
 */

var GMAIL_AI_CLASSIFIER_VERSION = 'v1.8.0-drive-taxonomy-attachments'

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

    var processedLabel = ensureUserLabel(config.processedLabel, gmail)

    var startTime = Date.now()

    for (var i = 0; i < threads.length; i++) {
      if (Date.now() - startTime > 270000) {
        console.warn(
          '[processEmailsWithAiClassifier] Safety time budget reached (270s); stopping batch gracefully.'
        )
        break
      }
      var thread = threads[i]
      var messages =
        typeof thread.getMessages === 'function' ? thread.getMessages() : []
      if (!messages || messages.length === 0) continue
      var firstMessage = messages[0]
      var sender = firstMessage.getFrom()
      var subject = firstMessage.getSubject()
      var snippet =
        typeof firstMessage.getPlainBody === 'function'
          ? firstMessage.getPlainBody().substring(0, 500)
          : ''
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

      var classification = deterministicRuleClassify_(
        sender,
        subject,
        snippet,
        thread,
        config
      )
      var usedRemoteApi = false
      if (!classification) {
        var classifyFn =
          services.classifyFn ||
          (typeof classifyWithGemini === 'function'
            ? function (s, sub, sn, cfg) {
                return classifyWithGemini(s, sub, sn, cfg, services)
              }
            : null)
        if (classifyFn) {
          classification = classifyFn(sender, subject, snippet, config)
          usedRemoteApi = true
        }
      }
      if (classification) {
        // Clean up any pre-existing conflicting core domain labels, sub-labels, flat labels, and Retention/Permanent
        cleanConflictingLabels(
          thread,
          classification.canonicalDomain,
          classification.subLabel,
          config
        )

        // 1. Single Primary Label Tagging (Sub-label preferred; fallback to domain default sub-label)
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
          var targetLabel = ensureUserLabel(primaryTag, gmail)
          thread.addLabel(targetLabel)
          console.log(
            '[processEmailsWithAiClassifier] Tagged thread with single primary label: ' +
              primaryTag
          )

          // Persist Canonical Attachments to Google Drive along Taxonomy Path
          var utils =
            services.Utilities ||
            (typeof Utilities !== 'undefined' ? Utilities : null)
          var sess =
            services.Session ||
            (typeof Session !== 'undefined' ? Session : null)
          var driveApp =
            services.DriveApp ||
            (typeof DriveApp !== 'undefined' ? DriveApp : null)

          var savedAttachments = persistCanonicalAttachmentsToDrive(
            thread,
            classification,
            config,
            {
              Utilities: utils,
              Session: sess,
              DriveApp: driveApp,
            }
          )

          // Sync Progressive Disclosure Summary to GitHub
          if (config.githubToken) {
            try {
              var notePath = getNotePathForDomain(
                classification.canonicalDomain,
                classification.subLabel
              )
              if (notePath && utils) {
                var dateStr = utils.formatDate(
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
                if (typeof assertNoAsciiReplacement_ === 'function') {
                  assertNoAsciiReplacement_(
                    (subject || '') + (classification.summary || ''),
                    entryMd
                  )
                }
                if (typeof assertClean_ === 'function') {
                  assertClean_(entryMd, 'new entry for ' + notePath)
                }
                if (typeof appendMarkdownEntryToGitHubRepo === 'function') {
                  appendMarkdownEntryToGitHubRepo(
                    notePath,
                    entryMd,
                    'feat(ingestion): ' + subject
                  )
                }
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

        // 2. Action Handling (Trash, Archive, Mark Read)
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

        // 3. Category Tab Shifting (Push to Updates/Promotions/Social/Primary)
        if (classification.category && classification.action !== 'trash') {
          setGmailCategoryTab(thread, classification.category, services.Gmail)
        }

        // Apply Single Global Processed Label
        if (processedLabel) {
          thread.addLabel(processedLabel)
        }
      } else {
        console.warn(
          '[processEmailsWithAiClassifier] Classification failed or returned null; preserving thread unprocessed for retry.'
        )
      }

      if (usedRemoteApi) {
        var utilsService =
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
      } catch (e) {
        // ignore lock release error
      }
    }
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
    } catch (err) {
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
    sLower.indexOf('bcs-lions.org') !== -1 ||
    sLower.indexOf('briarwoodchristianschool.org') !== -1 ||
    sLower.indexOf('mcaabhm.org') !== -1 ||
    sLower.indexOf('jeffersonstate.edu') !== -1
  var isBroadcastSubject = [
    'weekly',
    'newsletter',
    'bulletin',
    'school update',
    'campus update',
    'district update',
    'bcs update',
    'lions update',
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
  var isScarsella = sLower.indexOf('scarsella') !== -1
  var isScarsellaCurriculum =
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

    for (var j = 0; j < existingLabels.length; j++) {
      var lObj = existingLabels[j]
      var lName =
        typeof lObj.getName === 'function' ? lObj.getName() : String(lObj)

      // 1. Strip redundant Retention/Permanent (Inverted Model: blank = permanent)
      if (lName === 'Retention/Permanent') {
        try {
          thread.removeLabel(lObj)
          console.log(
            '[cleanConflictingLabels] Stripped Retention/Permanent: ' + lName
          )
        } catch (err) {
          console.warn(
            '[cleanConflictingLabels] Failed removing label ' +
              lName +
              ': ' +
              err.message
          )
        }
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
          try {
            thread.removeLabel(lObj)
            console.log(
              '[cleanConflictingLabels] Stripped legacy flat label: ' + lName
            )
          } catch (err) {
            console.warn(
              '[cleanConflictingLabels] Failed removing legacy flat label ' +
                lName +
                ': ' +
                err.message
            )
          }
          isLegacy = true
          break
        }
      }
      if (isLegacy) continue

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
        try {
          thread.removeLabel(lObj)
          console.log(
            '[cleanConflictingLabels] Removed domain code label: ' + lName
          )
        } catch (err) {
          console.warn(
            '[cleanConflictingLabels] Failed removing domain code label ' +
              lName +
              ': ' +
              err.message
          )
        }
        continue
      }

      // 6. Clean conflicting sub-labels if they don't match targetSubLabel
      if (
        lName.indexOf('/') !== -1 &&
        lName !== targetSubLabel &&
        lName.indexOf('Archives') === -1 &&
        lName.indexOf('Retention/') === -1
      ) {
        try {
          thread.removeLabel(lObj)
          console.log(
            '[cleanConflictingLabels] Removed conflicting sub-label: ' + lName
          )
        } catch (err) {
          console.warn(
            '[cleanConflictingLabels] Failed removing conflicting sub-label ' +
              lName +
              ': ' +
              err.message
          )
        }
      }
    }
  } catch (e) {
    console.warn('[cleanConflictingLabels] Error cleaning labels: ' + e.message)
  }
}

/**
 * Automatically purges emails older than their category retention policy (2 years for Promotions/Social/Forums).
 * Core household domains (01_Household - 07_Community_NonProfit), Primary, Updates, Starred, and User Replied/Sent threads are 100% EXEMPT.
 */
function purgeExpiredEmailsByRetentionPolicy(customConfig, customServices) {
  console.log(
    '[purgeExpiredEmailsByRetentionPolicy] Starting weekly category retention cleanup...'
  )
  var services = customServices || {}
  var config =
    customConfig ||
    (typeof getAiClassifierConfig === 'function' ? getAiClassifierConfig() : {})

  var gmail =
    services.GmailApp || (typeof GmailApp !== 'undefined' ? GmailApp : null)
  if (!gmail) {
    console.error(
      '[purgeExpiredEmailsByRetentionPolicy] GmailApp service is missing.'
    )
    return { trashedCount: 0, exemptedCount: 0 }
  }

  // Explicitly exclude threads sent by user or containing user replies
  var retentionQuery =
    '(category:promotions OR category:social OR category:forums) older_than:2y -is:starred -from:me'

  var threads = gmail.search(retentionQuery, 0, 50) || []
  console.log(
    '[purgeExpiredEmailsByRetentionPolicy] Found ' +
      threads.length +
      ' expired thread(s) matching 2-year retention query.'
  )

  if (threads.length === 0) {
    return { trashedCount: 0, exemptedCount: 0 }
  }

  var coreDomainLabels = config.canonicalDomains || [
    '01_Household',
    '02_Finance_Legal',
    '03_Vehicles',
    '04_Family_Health',
    '05_Tech_Infrastructure',
    '06_Work_Career',
    '07_Community_NonProfit',
  ]
  var trashedCount = 0
  var exemptedCount = 0

  for (var i = 0; i < threads.length; i++) {
    try {
      var thread = threads[i]
      if (!thread) continue
      var labels =
        typeof thread.getLabels === 'function' ? thread.getLabels() || [] : []
      var isExempt = false

      // Safety Shield 1: Check if thread contains any Core Household Domain label
      // OR any classifier sub-label. Under the strict single-label model a saved
      // core thread often carries ONLY its sub-label (e.g. "Finance/Banking") with
      // the canonical-domain code stripped, so exempting canonical codes alone
      // would let the 2-year purge trash indefinitely-retained core mail. Any
      // user sub-label (contains '/', excluding the ephemeral Retention/* tags)
      // therefore also grants exemption.
      for (var l = 0; l < labels.length; l++) {
        var labelName =
          typeof labels[l].getName === 'function'
            ? labels[l].getName()
            : String(labels[l])
        for (var cd = 0; cd < coreDomainLabels.length; cd++) {
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
        var subj =
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

  console.log(
    '[purgeExpiredEmailsByRetentionPolicy] Retention cleanup complete. Moved ' +
      trashedCount +
      ' expired thread(s) to Trash.'
  )
  return { trashedCount: trashedCount, exemptedCount: exemptedCount }
}

/**
 * Checks if a thread contains any messages sent or replied by the account owner.
 */
function isThreadSentOrRepliedByUser(thread, userEmail) {
  try {
    var primaryEmail = (userEmail || '').toLowerCase()
    if (!primaryEmail || !thread || typeof thread.getMessages !== 'function') {
      return false
    }
    var messages = thread.getMessages() || []
    for (var m = 0; m < messages.length; m++) {
      var msg = messages[m]
      if (!msg || typeof msg.getFrom !== 'function') continue
      var rawFrom = msg.getFrom()
      var fromAddr = (
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
 * Guards destructive actions (trash/archive) behind a strict validation of the
 * parsed Gemini response. Returns true only when the action is a recognized
 * destructive verb AND the response carries a finite confidence at or above the
 * destructive-action minimum. Any malformed, manipulated, or low-confidence
 * response returns false so the thread is preserved in the Inbox.
 */
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
  if (typeof confidence !== 'number' || !isFinite(confidence)) {
    return false
  }
  return confidence >= DESTRUCTIVE_CONFIDENCE_MIN
}

/**
 * Sets up a weekly cloud trigger to run purgeExpiredEmailsByRetentionPolicy every Sunday at 1:00 AM.
 */
function setupWeeklyRetentionTrigger() {
  var triggers = ScriptApp.getProjectTriggers()
  for (var i = 0; i < triggers.length; i++) {
    if (
      triggers[i].getHandlerFunction() === 'purgeExpiredEmailsByRetentionPolicy'
    ) {
      ScriptApp.deleteTrigger(triggers[i])
    }
  }

  ScriptApp.newTrigger('purgeExpiredEmailsByRetentionPolicy')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.SUNDAY)
    .atHour(1)
    .create()

  console.log(
    '[setupWeeklyRetentionTrigger] Established weekly Sunday 1:00 AM retention cleanup trigger.'
  )
}

/**
 * Sets up a daily cloud trigger to run auditEmailClassifications every morning at 6:00 AM.
 */
function setupDailyAuditTrigger() {
  var triggers = ScriptApp.getProjectTriggers()
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'auditEmailClassifications') {
      ScriptApp.deleteTrigger(triggers[i])
    }
  }

  ScriptApp.newTrigger('auditEmailClassifications')
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
function setupFourHourAuditTrigger() {
  var triggers = ScriptApp.getProjectTriggers()
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'auditEmailClassifications') {
      ScriptApp.deleteTrigger(triggers[i])
    }
  }

  ScriptApp.newTrigger('auditEmailClassifications')
    .timeBased()
    .everyHours(4)
    .create()

  console.log(
    '[setupFourHourAuditTrigger] Established 4-hour classification audit trigger.'
  )
}

/**
 * Daily audit routine that inspects recently processed threads for classification anomalies,
 * missing or duplicate domain labels, and potential prompt tuning opportunities.
 * Logs anomalies to console and optionally emails a digest if AUDIT_DIGEST_EMAIL is configured.
 *
 * @param {Object} [customConfig] - Optional override configuration
 * @param {Object} [customServices] - Optional injected services (GmailApp)
 * @returns {Object} report - { scannedCount, flaggedCount, findings, summary }
 */
function auditEmailClassifications(customConfig, customServices) {
  console.log(
    '[auditEmailClassifications] Starting daily classification audit sweep...'
  )
  var services = customServices || {}
  var config =
    customConfig ||
    (typeof getAiClassifierConfig === 'function' ? getAiClassifierConfig() : {})
  var gmail =
    (services && services.GmailApp) ||
    (typeof GmailApp !== 'undefined' ? GmailApp : null)
  var lookback = config.auditLookbackDays || 2
  var query =
    'label:' +
    (config.processedLabel || 'Processed') +
    ' newer_than:' +
    lookback +
    'd'

  var threads =
    gmail && typeof gmail.search === 'function'
      ? gmail.search(query, 0, 50)
      : []
  console.log(
    '[auditEmailClassifications] Found ' +
      threads.length +
      ' processed thread(s) in last ' +
      lookback +
      ' day(s).'
  )

  var report = auditClassifications(threads, config)
  console.log('[auditEmailClassifications] ' + report.summary)

  if (report.flaggedCount > 0) {
    var digest = formatAuditDigest(report)
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
 * Audits a collection of processed Gmail threads for classification anomalies.
 *
 * @param {Array} threads - Array of GmailThread-like objects
 * @param {Object} config - Classifier config
 * @returns {Object} report - { scannedCount, flaggedCount, findings, summary }
 */
function auditClassifications(threads, config) {
  var canonicalDomains = (config && config.canonicalDomains) || [
    '01_Household',
    '02_Finance_Legal',
    '03_Vehicles',
    '04_Family_Health',
    '05_Tech_Infrastructure',
    '06_Work_Career',
    '07_Community_NonProfit',
  ]

  var PROMO_KEYWORDS =
    /\b(sale|\d+% off|deal of the day|clearance|limited time offer|coupon|shop now)\b/i
  var NEWSLETTER_KEYWORDS =
    /\b(weekly digest|daily digest|newsletter|roundup|top stories)\b/i
  var ORDER_KEYWORDS =
    /\b(order confirmation|your order|receipt|payment received|invoice|shipped)\b/i
  var TOS_KEYWORDS =
    /\b(terms of service|privacy policy|terms and conditions|user agreement|arbitration terms)\b/i
  var SURVEY_KEYWORDS =
    /\b(survey|feedback|net promoter|nps|rate your experience|how did we do|review us)\b/i
  var POLITICAL_KEYWORDS =
    /\b(campaign|pac|fundraiser|election|candidate|contribute now|donate to our campaign)\b/i

  var findings = []

  if (!Array.isArray(threads)) {
    return {
      scannedCount: 0,
      flaggedCount: 0,
      findings: [],
      summary: 'No threads to audit.',
    }
  }

  threads.forEach(function (thread) {
    if (!thread) return
    var id =
      typeof thread.getId === 'function' ? thread.getId() : thread.id || ''
    var subject =
      typeof thread.getFirstMessageSubject === 'function'
        ? thread.getFirstMessageSubject()
        : thread.subject || ''

    var sender = ''
    if (typeof thread.getMessages === 'function') {
      var msgs = thread.getMessages()
      if (msgs && msgs.length > 0 && typeof msgs[0].getFrom === 'function') {
        sender = msgs[0].getFrom()
      }
    } else if (thread.sender) {
      sender = thread.sender
    }

    var rawLabels = []
    if (typeof thread.getLabels === 'function') {
      var labelObjs = thread.getLabels() || []
      rawLabels = labelObjs.map(function (l) {
        return typeof l.getName === 'function' ? l.getName() : String(l)
      })
    } else if (Array.isArray(thread.labels)) {
      rawLabels = thread.labels
    }

    var assignedCanonical = []
    rawLabels.forEach(function (l) {
      if (!l || typeof l !== 'string') return
      if (canonicalDomains.indexOf(l) !== -1) {
        if (assignedCanonical.indexOf(l) === -1) assignedCanonical.push(l)
        return
      }
      var match = l.match(/^(0[1-7]_[A-Za-z_]+)/)
      if (match && canonicalDomains.indexOf(match[1]) !== -1) {
        if (assignedCanonical.indexOf(match[1]) === -1) {
          assignedCanonical.push(match[1])
        }
      }
    })

    // Collect any canonical domains represented via sub-labels (e.g. "Finance/Banking" -> "02_Finance_Legal")
    var sublabelDomains = []
    rawLabels.forEach(function (l) {
      var lLower = (l || '').toLowerCase()
      if (
        lLower.indexOf('household/') === 0 &&
        sublabelDomains.indexOf('01_Household') === -1
      ) {
        sublabelDomains.push('01_Household')
      } else if (
        lLower.indexOf('finance/') === 0 &&
        sublabelDomains.indexOf('02_Finance_Legal') === -1
      ) {
        sublabelDomains.push('02_Finance_Legal')
      } else if (
        lLower.indexOf('vehicles/') === 0 &&
        sublabelDomains.indexOf('03_Vehicles') === -1
      ) {
        sublabelDomains.push('03_Vehicles')
      } else if (
        lLower.indexOf('family/') === 0 &&
        sublabelDomains.indexOf('04_Family_Health') === -1
      ) {
        sublabelDomains.push('04_Family_Health')
      } else if (
        lLower.indexOf('tech/') === 0 &&
        sublabelDomains.indexOf('05_Tech_Infrastructure') === -1
      ) {
        sublabelDomains.push('05_Tech_Infrastructure')
      } else if (
        lLower.indexOf('work/') === 0 &&
        sublabelDomains.indexOf('06_Work_Career') === -1
      ) {
        sublabelDomains.push('06_Work_Career')
      } else if (
        (lLower.indexOf('community/') === 0 ||
          lLower.indexOf('projects/') === 0) &&
        sublabelDomains.indexOf('07_Community_NonProfit') === -1
      ) {
        sublabelDomains.push('07_Community_NonProfit')
      }
    })

    sublabelDomains.forEach(function (sd) {
      if (assignedCanonical.indexOf(sd) === -1) {
        assignedCanonical.push(sd)
      }
    })

    var flags = []
    var fullText = (subject + ' ' + sender).toLowerCase()
    var isReceiptOrOrder = ORDER_KEYWORDS.test(fullText)
    var isNonCanonicalStream =
      !isReceiptOrOrder &&
      (rawLabels.some(function (l) {
        return /promotions|social|forums|marketing|promo|deal|newsletter/i.test(
          l
        )
      }) ||
        PROMO_KEYWORDS.test(subject) ||
        NEWSLETTER_KEYWORDS.test(subject) ||
        TOS_KEYWORDS.test(subject) ||
        SURVEY_KEYWORDS.test(subject) ||
        POLITICAL_KEYWORDS.test(subject))

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
      var hasFinanceOrHousehold = assignedCanonical.some(function (l) {
        return (
          l.indexOf('02_Finance_Legal') !== -1 ||
          l.indexOf('01_Household') !== -1 ||
          l.indexOf('03_Vehicles') !== -1
        )
      })
      if (assignedCanonical.length > 0 && !hasFinanceOrHousehold) {
        flags.push(
          'SUSPICIOUS_ROUTING: Purchase/receipt keywords detected but domain is ' +
            assignedCanonical.join(', ') +
            ' instead of 02_Finance_Legal.'
        )
      }
    }

    if (PROMO_KEYWORDS.test(subject) && assignedCanonical.length > 0) {
      var hasMarketingSublabel = rawLabels.some(function (l) {
        return /promo|marketing|deal|coupon/i.test(l)
      })
      if (!hasMarketingSublabel) {
        flags.push(
          'PROMOTIONAL_CONTENT: Promotional sale keywords in subject tagged under core domain ' +
            assignedCanonical.join(', ') +
            ' without marketing sub-label.'
        )
      }
    }

    if (NEWSLETTER_KEYWORDS.test(subject) && assignedCanonical.length > 0) {
      var hasNewsletterSublabel = rawLabels.some(function (l) {
        return /newsletter|digest|news/i.test(l)
      })
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
      assignedCanonical.some(function (l) {
        return l.indexOf('02_Finance_Legal') !== -1
      })
    ) {
      flags.push(
        'COMMERCIAL_TOS_IN_LEGAL: Routine commercial terms of service/privacy policy update tagged under 02_Finance_Legal instead of non-canonical broadcast.'
      )
    }

    // 4. Drive Attachment Persistence & Tagging Check
    var driveApp =
      (config && config.driveApp) ||
      (typeof DriveApp !== 'undefined' ? DriveApp : null)
    if (
      driveApp &&
      assignedCanonical.length === 1 &&
      typeof thread.getMessages === 'function'
    ) {
      var domain = assignedCanonical[0]
      var subLabel =
        rawLabels.find(function (l) {
          if (!l || typeof l !== 'string' || l.indexOf('/') === -1) return false
          if (/^0[1-7]_/.test(l)) {
            return l.indexOf(domain + '/') === 0
          }
          return true
        }) || ''
      var subfolderName = resolveTaxonomySubfolderName(domain, subLabel)
      var msgs = thread.getMessages() || []
      msgs.forEach(function (msg) {
        var atts = getMessageAttachments_(msg)
        atts.forEach(function (att) {
          if (isEligibleAttachment(att)) {
            var attName =
              typeof att.getName === 'function'
                ? att.getName()
                : att.name || 'unnamed'
            try {
              var targetFolder = ensureDriveTaxonomyFolder(
                domain,
                subfolderName,
                driveApp
              )
              var existingFiles = targetFolder.getFilesByName(attName)
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
                var driveFile = existingFiles.next()
                var desc =
                  typeof driveFile.getDescription === 'function'
                    ? driveFile.getDescription()
                    : ''
                if (!desc || desc.indexOf('[AI_INDEXED]') === -1) {
                  flags.push(
                    'UNTAGGED_DRIVE_ATTACHMENT: Attachment "' +
                      attName +
                      '" exists in Drive but lacks [AI_INDEXED] metadata description.'
                  )
                }
              }
            } catch (err) {
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

  var text = '===================================================\n'
  text += '   GMAIL AI CLASSIFICATION AUDIT REPORT\n'
  text += '===================================================\n'
  text += report.summary + '\n\n'

  report.findings.forEach(function (finding, idx) {
    if (!finding) return
    var labelsStr =
      Array.isArray(finding.canonicalLabels) &&
      finding.canonicalLabels.length > 0
        ? finding.canonicalLabels.join(', ')
        : '(none)'
    var flagsList = Array.isArray(finding.flags) ? finding.flags : []

    text +=
      idx + 1 + '. Subject: "' + (finding.subject || '(no subject)') + '"\n'
    text += '   Sender:  ' + (finding.sender || '(unknown)') + '\n'
    text += '   Labels:  ' + labelsStr + '\n'
    text += '   Flags:\n'
    flagsList.forEach(function (f) {
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
 * Creates an automatic Cloud Trigger that runs email classification every 5 minutes 24/7.
 */
function setupFiveMinuteTrigger() {
  stopAllTriggers()
  ScriptApp.newTrigger('processEmailsWithAiClassifier')
    .timeBased()
    .everyMinutes(5)
    .create()
  setupWeeklyRetentionTrigger()
  setupDailyAuditTrigger()
  console.log(
    '[setupFiveMinuteTrigger] Successfully established 5-minute recurring cloud trigger, weekly retention trigger, and daily audit trigger.'
  )
}

/**
 * Clears all active time-driven triggers for this script.
 */
function stopAllTriggers() {
  var triggers = ScriptApp.getProjectTriggers()
  for (var i = 0; i < triggers.length; i++) {
    ScriptApp.deleteTrigger(triggers[i])
  }
  console.log('[stopAllTriggers] All script triggers removed.')
}

function listAvailableGeminiModels(config) {
  var url =
    'https://generativelanguage.googleapis.com/v1beta/models?key=' +
    config.geminiApiKey
  try {
    var response = UrlFetchApp.fetch(url, { muteHttpExceptions: true })
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
  var domains = (config && config.canonicalDomains) || []
  var prompt =
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

function computeStringHash(str, services) {
  if (!str) return ''
  try {
    if (
      services &&
      services.Utilities &&
      typeof services.Utilities.computeDigest === 'function'
    ) {
      var digest = services.Utilities.computeDigest(
        services.Utilities.DigestAlgorithm.MD5,
        str
      )
      return digest
        .map(function (b) {
          return ('0' + (b & 0xff).toString(16)).slice(-2)
        })
        .join('')
    }
    if (
      typeof Utilities !== 'undefined' &&
      Utilities &&
      typeof Utilities.computeDigest === 'function'
    ) {
      var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, str)
      return digest
        .map(function (b) {
          return ('0' + (b & 0xff).toString(16)).slice(-2)
        })
        .join('')
    }
    if (typeof require !== 'undefined') {
      var crypto = require('crypto')
      return crypto.createHash('md5').update(str).digest('hex')
    }
  } catch (e) {
    // Non-blocking fallback
  }
  var hash = 0
  for (var i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i)
    hash |= 0
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
          console.log('[classifyWithGemini] Cache hit for: ' + subject)
          return cachedResult
        }
      } catch (cErr) {
        // Cache read is non-blocking
      }
    }
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
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent',
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent',
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
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

  for (var e = 0; e < endpoints.length; e++) {
    var separator = endpoints[e].indexOf('?') === -1 ? '?' : '&'
    var url =
      endpoints[e] + separator + 'key=' + (config && config.geminiApiKey)
    var options = {
      method: 'post',
      contentType: 'application/json',
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
          if (parsedObj) {
            console.log(
              '[classifyWithGemini] Success using endpoint: ' + endpoints[e]
            )
            if (cache && cacheKey) {
              try {
                cache.put(cacheKey, JSON.stringify(parsedObj), 21600)
              } catch (cPutErr) {
                // Cache write is non-blocking
              }
            }
            return parsedObj
          }
        }
      } else if (statusCode === 429) {
        var delayMs = parseRetryDelayMs(response)
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
    } catch (e) {
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
      var seconds = parseInt(retryHeader, 10)
      if (!isNaN(seconds) && seconds > 0) {
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
            var sec = parseFloat(secStr)
            if (!isNaN(sec) && sec > 0) {
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

function ensureUserLabel(labelName, gmailApp) {
  var app = gmailApp || (typeof GmailApp !== 'undefined' ? GmailApp : null)
  if (!app) return null
  var label = app.getUserLabelByName(labelName)
  if (!label) {
    if (
      typeof Gmail !== 'undefined' &&
      Gmail &&
      Gmail.Users &&
      Gmail.Users.Labels &&
      Gmail.Users.Labels.create
    ) {
      try {
        Gmail.Users.Labels.create(
          {
            name: labelName,
            labelListVisibility: 'labelShow',
            messageListVisibility: 'hide',
          },
          'me'
        )
        label = app.getUserLabelByName(labelName)
      } catch (advancedErr) {
        label = app.createLabel(labelName)
      }
    } else {
      label = app.createLabel(labelName)
    }
    console.log('[ensureUserLabel] Created new label: ' + labelName)
  }
  return label
}

function createGmailFilterRule(senderEmail, targetLabelName) {
  // Decommissioned: Static filter auto-creation causes multi-label collisions,
  // filter bloat, and duplicate rules across multi-purpose senders.
  console.log(
    '[createGmailFilterRule] Permanent filter auto-creation is permanently decommissioned. No-op.'
  )
}

function getNotePathForDomain(domain, subLabel) {
  var map = {
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
      var customMapJson =
        PropertiesService.getScriptProperties().getProperty('CUSTOM_NOTE_PATHS')
      if (customMapJson) {
        var customMap = JSON.parse(customMapJson)
        if (customMap && customMap[domain]) {
          return customMap[domain]
        }
      }
    } catch (e) {
      // Fall through to default map
    }
  }
  return map[domain] || null
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
  var entry = '\n### ' + dateStr + ' — ' + title + '\n'
  entry += '- **Account**: ' + accountEmail + '\n'
  entry += '- **From**: ' + sender + '\n'
  entry += '- **Subject**: ' + subject + '\n'
  if (summaryText) {
    entry += '- **Summary**:\n  > ' + summaryText.trim() + '\n'
  }
  if (attachments && attachments.length > 0) {
    entry += '- **Attachments**:\n'
    for (var a = 0; a < attachments.length; a++) {
      var att = attachments[a]
      if (att && att.name) {
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

/**
 * Computes search date range object ({ after: 'YYYY/MM/DD', before: 'YYYY/MM/DD' }) around a given date string.
 */
function getSearchDateRange_(dateStr, days) {
  var parts = dateStr.split('-')
  var year = parseInt(parts[0], 10)
  var month = parseInt(parts[1], 10) - 1
  var day = parseInt(parts[2], 10)
  var dt = new Date(year, month, day)

  var beforeDt = new Date(dt.getTime() + (days + 1) * 86400000)
  var afterDt = new Date(dt.getTime() - days * 86400000)

  function fmt(d) {
    var y = d.getFullYear()
    var m = ('0' + (d.getMonth() + 1)).slice(-2)
    var da = ('0' + d.getDate()).slice(-2)
    return y + '/' + m + '/' + da
  }
  return { after: fmt(afterDt), before: fmt(beforeDt) }
}

/**
 * Detects evidence of mojibake (UTF-8 flattened to '?') in a line, distinct from
 * a legitimate question mark. A standalone trailing '?' (e.g. "Ready?") is NOT
 * mojibake; a '?' inside a word, a spaced ' ? ' separator, a doubled '??', or a
 * U+FFFD replacement character is.
 */
function hasMojibakeMarker_(text) {
  if (!text) return false
  return (
    /\S \? \S/.test(text) ||
    /\?\?/.test(text) ||
    /[A-Za-z]\?[A-Za-z]/.test(text) ||
    /�/.test(text)
  )
}

/**
 * Searches Gmail for original raw subject and from header corresponding to a damaged entry.
 */
function searchGmailForOriginalHeader_(senderEmail, dateStr, damagedSubject) {
  try {
    var range = getSearchDateRange_(dateStr, 2)
    var query =
      'from:' +
      senderEmail +
      ' after:' +
      range.after +
      ' before:' +
      range.before
    var threads = GmailApp.search(query, 0, 10)
    // Gmail search does not guarantee ordering; sort by last-message date
    // (newest first) so the closest matching thread is selected deterministically.
    threads.sort(function (a, b) {
      return b.getLastMessageDate() - a.getLastMessageDate()
    })
    var normDamaged = damagedSubject.toLowerCase().replace(/[^a-z0-9]/g, '')
    if (!normDamaged) return null

    for (var t = 0; t < threads.length; t++) {
      var messages = threads[t].getMessages()
      for (var m = 0; m < messages.length; m++) {
        var msg = messages[m]
        var realSub = msg.getSubject()
        var normReal = realSub.toLowerCase().replace(/[^a-z0-9]/g, '')
        if (
          normReal === normDamaged ||
          (normDamaged.length > 8 &&
            (normReal.indexOf(normDamaged) !== -1 ||
              normDamaged.indexOf(normReal) !== -1))
        ) {
          return {
            subject: realSub,
            from: msg.getFrom(),
          }
        }
      }
    }
  } catch (e) {
    console.warn('[searchGmailForOriginalHeader_] Search error: ' + e.message)
  }
  return null
}

/**
 * Fetches file content and SHA from GitHub REST API.
 */
function fetchGitHubFileContent_(filePath, token) {
  var url =
    'https://api.github.com/repos/don-petry/self-private/contents/' + filePath
  var options = {
    method: 'get',
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'GoogleAppsScript-Ingester',
    },
    muteHttpExceptions: true,
  }
  var res = UrlFetchApp.fetch(url, options)
  if (res.getResponseCode() === 200) {
    var data = JSON.parse(res.getContentText())
    var rawContent = Utilities.newBlob(
      Utilities.base64Decode(data.content)
    ).getDataAsString()
    return { content: rawContent, sha: data.sha }
  }
  return null
}

/**
 * Commits updated file content to GitHub REST API.
 */
function commitGitHubFileDirect_(
  filePath,
  updatedContent,
  sha,
  commitMessage,
  token
) {
  var url =
    'https://api.github.com/repos/don-petry/self-private/contents/' + filePath
  var encoded = Utilities.base64Encode(
    Utilities.newBlob(updatedContent).getBytes()
  )
  var payload = {
    message: commitMessage,
    content: encoded,
    sha: sha,
  }
  var options = {
    method: 'put',
    contentType: 'application/json',
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'GoogleAppsScript-Ingester',
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  }
  var res = UrlFetchApp.fetch(url, options)
  return res.getResponseCode() === 200 || res.getResponseCode() === 201
}

/**
 * One-time backfill helper that queries Gmail to restore exact original UTF-8
 * Subject and From headers for historical activity log entries that were flattened to '?'.
 */
function backfillOriginalEmailHeaders() {
  console.log(
    '[backfillOriginalEmailHeaders] Starting historical header restoration from Gmail...'
  )
  var config = getAiClassifierConfig()
  if (!config.githubToken) {
    console.error('[backfillOriginalEmailHeaders] GITHUB_PAT is missing.')
    return
  }

  var targetFiles = [
    '01_Household/index.md',
    '02_Finance_Legal/index.md',
    '03_Vehicles/index.md',
    '04_Family_Health/index.md',
    '05_Tech_Infrastructure/index.md',
    '06_Work_Career/index.md',
    '07_Community_NonProfit/index.md',
  ]

  var totalRestored = 0

  for (var f = 0; f < targetFiles.length; f++) {
    var filePath = targetFiles[f]
    console.log('[backfillOriginalEmailHeaders] Processing: ' + filePath)

    var fileData = fetchGitHubFileContent_(filePath, config.githubToken)
    if (!fileData) {
      console.log(
        '[backfillOriginalEmailHeaders] File not found or empty: ' + filePath
      )
      continue
    }

    var lines = fileData.content.split('\n')
    var modified = false
    var fileRestoredCount = 0
    var currentDate = null

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i]
      var dateMatch = line.match(/^#{2,4} (\d{4}-\d{2}-\d{2})/)
      if (dateMatch) {
        currentDate = dateMatch[1]
        continue
      }

      if (
        line.indexOf('- **Subject**:') === 0 &&
        hasMojibakeMarker_(line) &&
        currentDate
      ) {
        var damagedSubject = line.substring('- **Subject**: '.length).trim()

        var fromLine = ''
        for (
          var j = Math.max(0, i - 3);
          j <= Math.min(lines.length - 1, i + 3);
          j++
        ) {
          if (lines[j].indexOf('- **From**:') === 0) {
            fromLine = lines[j].substring('- **From**: '.length).trim()
            break
          }
        }

        var senderEmail = ''
        var emailMatch = fromLine.match(/<([^>]+)>/)
        if (emailMatch) {
          senderEmail = emailMatch[1]
        } else if (fromLine.indexOf('@') !== -1) {
          senderEmail = fromLine
        }

        if (senderEmail) {
          var realEmail = searchGmailForOriginalHeader_(
            senderEmail,
            currentDate,
            damagedSubject
          )
          if (
            realEmail &&
            realEmail.subject &&
            realEmail.subject !== damagedSubject &&
            /[^\x00-\x7F]/.test(realEmail.subject)
          ) {
            // Only restore when the Gmail subject differs from the flattened
            // value AND actually reintroduces non-ASCII content. This prevents a
            // legitimate subject like "Ready?" from being overwritten by a
            // similarly-named-but-different message ("Ready").
            console.log(
              '[backfillOriginalEmailHeaders] Restoring: "' +
                damagedSubject +
                '" -> "' +
                realEmail.subject +
                '"'
            )
            lines[i] = '- **Subject**: ' + realEmail.subject
            modified = true
            fileRestoredCount++
            totalRestored++

            for (
              var k = Math.max(0, i - 3);
              k <= Math.min(lines.length - 1, i + 3);
              k++
            ) {
              if (
                lines[k].indexOf('- **From**:') === 0 &&
                hasMojibakeMarker_(lines[k]) &&
                realEmail.from
              ) {
                lines[k] = '- **From**: ' + realEmail.from
                break
              }
            }
          }
        }
      }
    }

    if (modified) {
      var newContent = lines.join('\n')
      var commitMsg =
        'chore(notes): restore ' +
        fileRestoredCount +
        ' original Gmail headers in ' +
        filePath
      var committed = commitGitHubFileDirect_(
        filePath,
        newContent,
        fileData.sha,
        commitMsg,
        config.githubToken
      )
      if (!committed) {
        console.error(
          '[backfillOriginalEmailHeaders] Failed to commit updates to ' +
            filePath +
            '; not counting ' +
            fileRestoredCount +
            ' header(s) as restored.'
        )
        totalRestored -= fileRestoredCount
        continue
      }
      console.log(
        '[backfillOriginalEmailHeaders] Successfully updated ' +
          filePath +
          ' (' +
          fileRestoredCount +
          ' headers restored).'
      )
    } else {
      console.log(
        '[backfillOriginalEmailHeaders] No damaged headers to restore in ' +
          filePath
      )
    }
  }

  console.log(
    '[backfillOriginalEmailHeaders] Finished header restoration. Total headers restored: ' +
      totalRestored
  )
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

// ---------------------------------------------------------------------------
// Attachment Persistence to Google Drive along Taxonomy Path
// ---------------------------------------------------------------------------

var CANONICAL_TAXONOMY_SUBFOLDERS = {
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

var DEFAULT_DOMAIN_SUBLABEL_MAP = {
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

var SUBLABEL_TO_FOLDER_MAP = {
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
 * Computes MD5 hex digest for a GAS blob.
 */
function getFileHash(blob) {
  if (!blob) return ''
  var bytes = null
  if (typeof blob.getBytes === 'function') {
    bytes = blob.getBytes()
  } else if (blob.bytes) {
    bytes = blob.bytes
  } else if (
    Array.isArray(blob) ||
    (typeof Buffer !== 'undefined' && Buffer.isBuffer(blob))
  ) {
    bytes = blob
  }
  if (!bytes) return ''
  var utils = typeof Utilities !== 'undefined' ? Utilities : null
  if (!utils || typeof utils.computeDigest !== 'function') return ''
  var digest = utils.computeDigest(utils.DigestAlgorithm.MD5, bytes)
  return digest
    .map(function (byte) {
      return ('0' + (byte & 0xff).toString(16)).slice(-2)
    })
    .join('')
}

/**
 * Validates whether an email classification represents a canonical domain.
 * Non-canonical emails (promotions, newsletters, spam) return null/empty for canonicalDomain.
 */
function isCanonicalClassification(classification, config) {
  if (!classification || typeof classification !== 'object') return false
  var domain = classification.canonicalDomain || classification.canonical_label
  if (!domain || typeof domain !== 'string') return false
  var trimmed = domain.trim()
  if (trimmed === '' || trimmed === 'null' || trimmed === 'undefined')
    return false

  var allowedDomains = (config && config.canonicalDomains) || [
    '01_Household',
    '02_Finance_Legal',
    '03_Vehicles',
    '04_Family_Health',
    '05_Tech_Infrastructure',
    '06_Work_Career',
    '07_Community_NonProfit',
  ]

  return allowedDomains.some(function (d) {
    return trimmed === d || trimmed.indexOf(d + '/') === 0
  })
}

/**
 * Resolves the 2nd-level Google Drive taxonomy subfolder name given a canonical domain and sub-label.
 */
function resolveTaxonomySubfolderName(canonicalDomain, subLabel) {
  if (subLabel && typeof subLabel === 'string') {
    var normalized = subLabel.trim().toLowerCase()
    if (SUBLABEL_TO_FOLDER_MAP[normalized]) {
      return SUBLABEL_TO_FOLDER_MAP[normalized]
    }

    if (
      normalized.indexOf('family/kids') === 0 ||
      normalized.indexOf('family/school') === 0
    ) {
      if (
        normalized.indexOf('health') !== -1 ||
        normalized.indexOf('medical') !== -1
      ) {
        return 'Medical_Records'
      }
      return 'Students'
    }
    if (
      normalized.indexOf('family/sisters') === 0 ||
      normalized.indexOf('family/parents') === 0
    ) {
      return 'Family_General'
    }

    var parts = subLabel.split('/')
    var subPart = (parts.length > 1 ? parts[1] : parts[0]).trim()
    var sanitized = subPart.replace(/[-\s]+/g, '_')

    var knownSubfolders = CANONICAL_TAXONOMY_SUBFOLDERS[canonicalDomain] || []
    for (var k = 0; k < knownSubfolders.length; k++) {
      if (knownSubfolders[k].toLowerCase() === sanitized.toLowerCase()) {
        return knownSubfolders[k]
      }
    }

    if (sanitized.length > 0) return sanitized
  }

  var defaults = {
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
  var name = typeof att.getName === 'function' ? att.getName() : att.name || ''
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return { eligible: false, reason: 'MISSING_NAME' }
  }

  var size = 0
  if (typeof att.getSize === 'function') {
    size = att.getSize()
  } else if (typeof att.getBytes === 'function') {
    var bytes = att.getBytes()
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

  var cleanName = name.trim()
  var dotIndex = cleanName.lastIndexOf('.')
  var ext = dotIndex > 0 ? cleanName.slice(dotIndex + 1).toLowerCase() : ''
  var stem = (
    dotIndex > 0 ? cleanName.slice(0, dotIndex) : cleanName
  ).toLowerCase()
  var mimeType = (
    typeof att.getContentType === 'function'
      ? att.getContentType()
      : att.contentType || ''
  ).toLowerCase()

  // 2. Unconditionally blocked non-document extensions
  var BLOCKED_EXTENSIONS = {
    ics: true,
    ical: true,
    ifb: true,
    vcf: true,
    vcard: true,
    html: true,
    htm: true,
    css: true,
    js: true,
    mjs: true,
    json: true,
    xml: true,
    rss: true,
    p7s: true,
    p7m: true,
    p7c: true,
    asc: true,
    sig: true,
    dat: true,
    eml: true,
    msg: true,
    exe: true,
    dmg: true,
    pkg: true,
    bin: true,
    apk: true,
    app: true,
    sh: true,
    bat: true,
    cmd: true,
    msi: true,
    ttf: true,
    woff: true,
    woff2: true,
    eot: true,
    otf: true,
    ico: true,
    gif: true,
  }

  if (BLOCKED_EXTENSIONS[ext]) {
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
  var DOCUMENT_EXTENSIONS = {
    pdf: true,
    docx: true,
    doc: true,
    rtf: true,
    odt: true,
    pages: true,
    xlsx: true,
    xls: true,
    csv: true,
    tsv: true,
    ods: true,
    numbers: true,
    pptx: true,
    ppt: true,
    key: true,
  }

  if (DOCUMENT_EXTENSIONS[ext]) {
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
  var IMAGE_EXTENSIONS = {
    jpg: true,
    jpeg: true,
    png: true,
    heic: true,
    tiff: true,
    tif: true,
    webp: true,
  }

  var isImage = IMAGE_EXTENSIONS[ext] || mimeType.indexOf('image/') === 0

  if (isImage) {
    // 7a. Stricter size threshold: genuine receipt/document photos are virtually always >= 35KB
    if (size < 35 * 1024) {
      return { eligible: false, reason: 'IMAGE_BELOW_SIZE_THRESHOLD (<35KB)' }
    }

    // 7b. Tracking, logo, signature stem blacklist
    var SIGNATURE_STEM_PATTERNS = [
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

    for (var i = 0; i < SIGNATURE_STEM_PATTERNS.length; i++) {
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
    } catch (e) {
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
  } catch (e) {
    // ignore attachment inspection errors
  }
  return baseSnippet
}

function getOrCreateChildFolder_(parentFolder, folderName) {
  var folders = parentFolder.getFoldersByName(folderName)
  if (folders && typeof folders.hasNext === 'function' && folders.hasNext()) {
    return folders.next()
  }
  return parentFolder.createFolder(folderName)
}

/**
 * Idempotently traverses or creates the 2-level Drive taxonomy path (Domain / Subfolder).
 */
function ensureDriveTaxonomyFolder(canonicalDomain, subfolderName, driveApp) {
  var drive = driveApp || (typeof DriveApp !== 'undefined' ? DriveApp : null)
  if (!drive) {
    throw new Error('DriveApp service unavailable')
  }

  var root =
    typeof drive.getRootFolder === 'function' ? drive.getRootFolder() : drive

  if (!root || typeof root.getFoldersByName !== 'function') {
    throw new Error('DriveApp service unavailable or invalid root folder')
  }

  var domainFolder = getOrCreateChildFolder_(root, canonicalDomain)
  if (!subfolderName) return domainFolder

  return getOrCreateChildFolder_(domainFolder, subfolderName)
}

function extractBlobBytes_(blob) {
  if (blob && typeof blob.getBytes === 'function') {
    return blob.getBytes()
  }
  if (blob && blob.bytes) {
    return blob.bytes
  }
  return []
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
 */
function isDuplicateAttachment(existingFiles, newFileBlob, helperFns) {
  if (!existingFiles || typeof existingFiles.hasNext !== 'function') {
    return false
  }
  var hashFn = (helperFns && helperFns.getFileHash) || getFileHash
  var newFileBytes = extractBlobBytes_(newFileBlob)
  var newFileLength = newFileBytes.length
  var newFileHash = hashFn(newFileBlob)

  while (existingFiles.hasNext()) {
    var existingFile = existingFiles.next()
    if (extractFileSize_(existingFile) !== newFileLength) {
      continue
    }

    var existingBlob =
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
 */
function resolveAttachmentName(folder, fileName, newFileBlob, options) {
  var existingFiles =
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

  var utils =
    options && options.Utilities
      ? options.Utilities
      : typeof Utilities !== 'undefined'
        ? Utilities
        : null
  var session =
    options && options.Session
      ? options.Session
      : typeof Session !== 'undefined'
        ? Session
        : null

  var timeTag =
    utils &&
    session &&
    typeof utils.formatDate === 'function' &&
    typeof session.getScriptTimeZone === 'function'
      ? utils.formatDate(new Date(), session.getScriptTimeZone(), '_HHmmssSSS')
      : '_' + Date.now()

  if (typeof timeTag === 'string' && timeTag.indexOf('_') !== 0) {
    timeTag = '_' + timeTag.replace(/[^a-zA-Z0-9]/g, '')
  }

  var renamed = fileName.replace(/(\.[\w-]+)$/i, timeTag + '$1')
  var finalName = renamed === fileName ? fileName + timeTag : renamed

  if (newFileBlob && typeof newFileBlob.setName === 'function') {
    newFileBlob.setName(finalName)
  }
  return finalName
}

/**
 * Persists attached documents from a canonical email thread to Google Drive along
 * the label's taxonomy path, skipping duplicates and strictly ignoring non-canonical emails.
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

  var driveApp =
    services && services.DriveApp
      ? services.DriveApp
      : typeof DriveApp !== 'undefined'
        ? DriveApp
        : null
  if (!driveApp) {
    console.error(
      '[persistCanonicalAttachmentsToDrive] DriveApp is unavailable; cannot persist attachments.'
    )
    return []
  }

  var canonicalDomain =
    classification.canonicalDomain || classification.canonical_label
  var subLabel = classification.subLabel || ''
  var subfolderName = resolveTaxonomySubfolderName(canonicalDomain, subLabel)

  var targetFolder
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

  var messages =
    typeof thread.getMessages === 'function' ? thread.getMessages() : []
  var savedFiles = []
  var helperFns = {
    getFileHash: (services && services.getFileHash) || getFileHash,
  }
  var subject =
    (classification && classification.title) ||
    (typeof thread.getFirstMessageSubject === 'function'
      ? thread.getFirstMessageSubject()
      : thread.subject || '')

  messages.forEach(function (msg) {
    var attachments = getMessageAttachments_(msg)
    attachments.forEach(function (att) {
      if (!isEligibleAttachment(att)) {
        console.log(
          '[persistCanonicalAttachmentsToDrive] Skipped ineligible attachment (signature/tracking pixel or empty): ' +
            (typeof att.getName === 'function' ? att.getName() : 'unnamed')
        )
        return
      }

      var fileName =
        typeof att.getName === 'function' ? att.getName() : att.name
      var newFileBlob =
        typeof att.copyBlob === 'function' ? att.copyBlob() : att
      var existingFiles =
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

      var finalName = resolveAttachmentName(
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
        var file = targetFolder.createFile(newFileBlob)
        var fileId = typeof file.getId === 'function' ? file.getId() : ''
        var fileUrl =
          typeof file.getUrl === 'function'
            ? file.getUrl()
            : 'https://drive.google.com/file/d/' + fileId

        if (typeof file.setDescription === 'function') {
          try {
            var tagDate =
              services &&
              services.Utilities &&
              typeof services.Utilities.formatDate === 'function'
                ? services.Utilities.formatDate(
                    new Date(),
                    'GMT',
                    "yyyy-MM-dd'T'HH:mm:ss'Z'"
                  )
                : new Date().toISOString()
            var tagBlock =
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
            file.setDescription(tagBlock)
          } catch (descErr) {
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
  var allowed = canonicalDomains || [
    '01_Household',
    '02_Finance_Legal',
    '03_Vehicles',
    '04_Family_Health',
    '05_Tech_Infrastructure',
    '06_Work_Career',
    '07_Community_NonProfit',
  ]
  // 1. Direct match on root domain codes (e.g. "01_Household")
  for (var i = 0; i < rawLabels.length; i++) {
    var l = rawLabels[i]
    if (allowed.indexOf(l) !== -1 || /^0[1-7]_/.test(l)) {
      return l
    }
  }
  // 2. Canonical sub-label prefix mapping
  for (var j = 0; j < rawLabels.length; j++) {
    var lName = (rawLabels[j] || '').toLowerCase()
    if (lName.indexOf('household/') === 0) return '01_Household'
    if (lName.indexOf('finance/') === 0) return '02_Finance_Legal'
    if (lName.indexOf('vehicles/') === 0) return '03_Vehicles'
    if (lName.indexOf('family/') === 0) return '04_Family_Health'
    if (lName.indexOf('tech/') === 0) return '05_Tech_Infrastructure'
    if (lName.indexOf('work/') === 0) return '06_Work_Career'
    if (lName.indexOf('community/') === 0 || lName.indexOf('projects/') === 0)
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
  var opts = options || {}
  var isDryRun = opts.dryRun !== false
  var maxThreads = opts.maxThreads || 50

  var cfg =
    config ||
    (typeof getAiClassifierConfig === 'function' ? getAiClassifierConfig() : {})
  var canonicalDomains = cfg.canonicalDomains || [
    '01_Household',
    '02_Finance_Legal',
    '03_Vehicles',
    '04_Family_Health',
    '05_Tech_Infrastructure',
    '06_Work_Career',
    '07_Community_NonProfit',
  ]

  var gmail =
    (services && services.GmailApp) ||
    (typeof GmailApp !== 'undefined' ? GmailApp : null)
  var drive =
    (services && services.DriveApp) ||
    (typeof DriveApp !== 'undefined' ? DriveApp : null)
  var utils =
    (services && services.Utilities) ||
    (typeof Utilities !== 'undefined' ? Utilities : null)

  if (!gmail || !drive) {
    throw new Error(
      'GmailApp and DriveApp services are required for attachment audit/backfill.'
    )
  }

  var defaultCanonicalQuery =
    'has:attachment (label:01_Household OR label:02_Finance_Legal OR label:03_Vehicles OR label:04_Family_Health OR label:05_Tech_Infrastructure OR label:06_Work_Career OR label:07_Community_NonProfit OR label:Household OR label:Finance OR label:Vehicles OR label:Family OR label:Tech OR label:Work OR label:Community)'
  var searchQuery = opts.query || defaultCanonicalQuery

  var threads = []
  if (typeof gmail.search === 'function') {
    threads = gmail.search(searchQuery, 0, maxThreads) || []
  }

  var report = {
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

  var startTime = Date.now()
  var timeBudgetMs = opts.timeBudgetMs || 270000
  var folderCache = {}

  for (var i = 0; i < threads.length; i++) {
    if (Date.now() - startTime > timeBudgetMs) {
      console.warn(
        '[auditAndBackfillCanonicalAttachments] Execution reached time budget safety ceiling; concluding batch cleanly.'
      )
      report.timeBudgetReached = true
      break
    }

    var thread = threads[i]
    if (!thread) continue
    var threadId =
      typeof thread.getId === 'function' ? thread.getId() : thread.id || ''
    var subject =
      typeof thread.getFirstMessageSubject === 'function'
        ? thread.getFirstMessageSubject()
        : thread.subject || ''

    var rawLabels = []
    if (typeof thread.getLabels === 'function') {
      var labelObjs = thread.getLabels() || []
      rawLabels = labelObjs.map(function (l) {
        return typeof l.getName === 'function' ? l.getName() : String(l)
      })
    } else if (Array.isArray(thread.labels)) {
      rawLabels = thread.labels
    }

    var canonicalDomain = resolveCanonicalDomainFromLabels(
      rawLabels,
      canonicalDomains
    )
    if (!canonicalDomain) continue

    var subLabel =
      rawLabels.find(function (l) {
        return l.indexOf('/') !== -1 && l.indexOf(canonicalDomain) === -1
      }) ||
      rawLabels.find(function (l) {
        return l.indexOf('/') !== -1
      }) ||
      ''
    var subfolderName = resolveTaxonomySubfolderName(canonicalDomain, subLabel)

    var folderKey = canonicalDomain + '::' + subfolderName
    var targetFolder = folderCache[folderKey]
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

    var msgs =
      typeof thread.getMessages === 'function'
        ? thread.getMessages()
        : thread.messages || []
    var threadHasEligible = false

    msgs.forEach(function (msg) {
      var atts = getMessageAttachments_(msg)
      atts.forEach(function (att) {
        report.totalAttachmentsInspected++
        var evalResult = evaluateAttachmentEligibility(att)
        if (!evalResult.eligible) {
          report.filteredGarbageCount++
          var reasonKey = evalResult.reason.split(':')[0]
          report.filteredByReason[reasonKey] =
            (report.filteredByReason[reasonKey] || 0) + 1
          return
        }

        threadHasEligible = true
        report.totalEligibleAttachments++
        var fileName =
          typeof att.getName === 'function'
            ? att.getName()
            : att.name || 'unnamed'
        var cleanName = fileName.trim()
        var dotIndex = cleanName.lastIndexOf('.')
        var ext =
          dotIndex > 0 ? cleanName.slice(dotIndex + 1).toLowerCase() : 'other'
        report.eligibleByType[ext] = (report.eligibleByType[ext] || 0) + 1

        var fileSize = extractFileSize_(att)
        if (!fileSize && typeof att.getBytes === 'function') {
          var b = att.getBytes()
          fileSize = b ? b.length : 0
        }
        var fileSizeKb = Math.round((fileSize / 1024) * 10) / 10
        var mimeType =
          typeof att.getContentType === 'function'
            ? att.getContentType()
            : att.contentType || ''

        var newFileBlob =
          typeof att.copyBlob === 'function' ? att.copyBlob() : att

        var existingFiles = targetFolder.getFilesByName(fileName)
        var helperFns = {
          getFileHash: getFileHash,
          Utilities: utils,
        }

        var isDup = isDuplicateAttachment(existingFiles, newFileBlob, helperFns)

        var tagDate =
          utils && typeof utils.formatDate === 'function'
            ? utils.formatDate(new Date(), 'GMT', "yyyy-MM-dd'T'HH:mm:ss'Z'")
            : new Date().toISOString()
        var tagBlock =
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
          var filesIterator = targetFolder.getFilesByName(fileName)
          var foundFile =
            filesIterator &&
            typeof filesIterator.next === 'function' &&
            filesIterator.hasNext()
              ? filesIterator.next()
              : null
          var desc =
            foundFile && typeof foundFile.getDescription === 'function'
              ? foundFile.getDescription()
              : ''

          if (desc && desc.indexOf('[AI_INDEXED]') !== -1) {
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
              } catch (descErr) {
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
              var finalName = resolveAttachmentName(
                targetFolder,
                fileName,
                newFileBlob,
                services
              )
              var createdFile = targetFolder.createFile(newFileBlob)
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
 * Zero-argument convenience runner for dry-run historical attachment audit.
 * Safe to execute directly from Apps Script IDE or scheduled triggers.
 */
function runDryRunAttachmentAudit(options) {
  var opts = Object.assign({ dryRun: true, maxThreads: 50 }, options || {})
  var report = auditAndBackfillCanonicalAttachments(opts)

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
 * Zero-argument convenience runner for live historical attachment backfill.
 * Backfills missing files to Drive taxonomy folders and sets [AI_INDEXED] description.
 */
function runLiveAttachmentBackfill(options) {
  var opts = Object.assign({ dryRun: false, maxThreads: 50 }, options || {})
  var report = auditAndBackfillCanonicalAttachments(opts)
  console.log(
    '[runLiveAttachmentBackfill] Completed backfill: ' +
      report.backfilledCount +
      ' uploaded, ' +
      report.taggedCount +
      ' tagged.'
  )
  return report
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
    (typeof classifyWithGemini === 'function'
      ? function (s, sub, sn, cfg) {
          return classifyWithGemini(s, sub, sn, cfg, services)
        }
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
    snippet = enrichSnippetWithAttachments_(snippet, firstMessage)

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
    var oldDomain = null
    if (typeof resolveCanonicalDomainFromLabels === 'function') {
      oldDomain = resolveCanonicalDomainFromLabels(
        rawLabels,
        cfg.canonicalDomains
      )
    }
    if (!oldDomain) {
      var oldCanonical = rawLabels.filter(function (l) {
        return (
          (cfg.canonicalDomains || []).indexOf(l) !== -1 || /^0[1-7]_/.test(l)
        )
      })
      oldDomain = oldCanonical.length > 0 ? oldCanonical[0] : null
    }
    var oldSubLabel =
      rawLabels.find(function (l) {
        return (
          l.indexOf('/') !== -1 &&
          l !== oldDomain &&
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
        typeof ensureUserLabel === 'function' &&
        typeof thread.addLabel === 'function'
      ) {
        var targetLabel = ensureUserLabel(primaryTag, gmail)
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
        typeof thread.moveToArchive === 'function' &&
        !isThreadSentOrRepliedByUser(thread, cfg.userAccountEmail)
      ) {
        thread.moveToArchive()
      }
      if (
        cfg.processedLabel &&
        typeof ensureUserLabel === 'function' &&
        typeof thread.addLabel === 'function'
      ) {
        var processedLabel = ensureUserLabel(cfg.processedLabel, gmail)
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

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    processEmailsWithAiClassifier: processEmailsWithAiClassifier,
    sweepAllUnreadInboxEmails: sweepAllUnreadInboxEmails,
    purgeExpiredEmailsByRetentionPolicy: purgeExpiredEmailsByRetentionPolicy,
    isThreadSentOrRepliedByUser: isThreadSentOrRepliedByUser,
    setupWeeklyRetentionTrigger: setupWeeklyRetentionTrigger,
    setupFiveMinuteTrigger: setupFiveMinuteTrigger,
    stopAllTriggers: stopAllTriggers,
    classifyWithGemini: classifyWithGemini,
    buildOntologicalPrompt: buildOntologicalPrompt,
    ensureUserLabel: ensureUserLabel,
    createGmailFilterRule: createGmailFilterRule,
    backfillOriginalEmailHeaders: backfillOriginalEmailHeaders,
    getSearchDateRange_: getSearchDateRange_,
    searchGmailForOriginalHeader_: searchGmailForOriginalHeader_,
    cleanConflictingLabels: cleanConflictingLabels,
    setGmailCategoryTab: setGmailCategoryTab,
    isCanonicalClassification: isCanonicalClassification,
    resolveTaxonomySubfolderName: resolveTaxonomySubfolderName,
    evaluateAttachmentEligibility: evaluateAttachmentEligibility,
    isEligibleAttachment: isEligibleAttachment,
    getMessageAttachments_: getMessageAttachments_,
    ensureDriveTaxonomyFolder: ensureDriveTaxonomyFolder,
    isDuplicateAttachment: isDuplicateAttachment,
    resolveAttachmentName: resolveAttachmentName,
    persistCanonicalAttachmentsToDrive: persistCanonicalAttachmentsToDrive,
    auditAndBackfillCanonicalAttachments: auditAndBackfillCanonicalAttachments,
    runDryRunAttachmentAudit: runDryRunAttachmentAudit,
    runLiveAttachmentBackfill: runLiveAttachmentBackfill,
    reclassifyThreadsByQuery: reclassifyThreadsByQuery,
    runRealignmentAudit: runRealignmentAudit,
    getFileHash: getFileHash,
    CANONICAL_TAXONOMY_SUBFOLDERS: CANONICAL_TAXONOMY_SUBFOLDERS,
    SUBLABEL_TO_FOLDER_MAP: SUBLABEL_TO_FOLDER_MAP,
    DEFAULT_DOMAIN_SUBLABEL_MAP: DEFAULT_DOMAIN_SUBLABEL_MAP,
    isRootDomainLabel: isRootDomainLabel,
    getNotePathForDomain: getNotePathForDomain,
    resolveCanonicalDomainFromLabels: resolveCanonicalDomainFromLabels,
    deterministicRuleClassify_: deterministicRuleClassify_,
    enrichSnippetWithAttachments_: enrichSnippetWithAttachments_,
    auditEmailClassifications: auditEmailClassifications,
    auditClassifications: auditClassifications,
    formatAuditDigest: formatAuditDigest,
    setupDailyAuditTrigger: setupDailyAuditTrigger,
    setupFourHourAuditTrigger: setupFourHourAuditTrigger,
    computeStringHash: computeStringHash,
    extractJsonSubstring: extractJsonSubstring,
    parseRetryDelayMs: parseRetryDelayMs,
    listAvailableGeminiModels: listAvailableGeminiModels,
  }
}
