/**
 * Configuration schema for Gemini AI Semantic Email Classifier & Auto-Filter Engine
 * Supports Multi-Account Household Deployment (Option A)
 */

function getAiClassifierConfig() {
  var props =
    typeof PropertiesService !== 'undefined' &&
    PropertiesService &&
    typeof PropertiesService.getScriptProperties === 'function'
      ? PropertiesService.getScriptProperties()
      : null
  var getProp = function (key) {
    return props && typeof props.getProperty === 'function'
      ? props.getProperty(key)
      : null
  }
  var modelName = getProp('GEMINI_MODEL') || 'gemini-2.5-flash'

  // Automatically upgrade deprecated models (gemini-1.5, gemini-2.0) to gemini-2.5-flash
  if (
    !modelName ||
    modelName === 'gemini-2.0-flash' ||
    modelName.indexOf('gemini-1.5') !== -1 ||
    modelName.indexOf('gemini-2.0') !== -1
  ) {
    modelName = 'gemini-2.5-flash'
  }

  var customEndpoint = getProp('GEMINI_ENDPOINT') || ''
  if (
    customEndpoint &&
    (customEndpoint.indexOf('gemini-1.5') !== -1 ||
      customEndpoint.indexOf('gemini-2.0') !== -1)
  ) {
    customEndpoint = ''
  }

  var userEmail = null
  try {
    if (
      typeof Session !== 'undefined' &&
      Session &&
      typeof Session.getEffectiveUser === 'function' &&
      Session.getEffectiveUser() &&
      typeof Session.getEffectiveUser().getEmail === 'function'
    ) {
      userEmail = Session.getEffectiveUser().getEmail()
    }
  } catch (e) {
    // Session access might be restricted in certain scopes
  }

  var rawLookback = getProp('AUDIT_LOOKBACK_DAYS')
  var parsedLookback = Number.parseInt(rawLookback || '2', 10)
  var auditLookbackDays =
    Number.isNaN(parsedLookback) || parsedLookback <= 0 ? 2 : parsedLookback

  var rawThreshold = getProp('AUTO_FILTER_THRESHOLD')
  var parsedThreshold = Number.parseFloat(
    rawThreshold !== null && rawThreshold !== undefined && rawThreshold !== ''
      ? rawThreshold
      : '0.95'
  )
  var autoFilterConfidenceThreshold = Number.isNaN(parsedThreshold)
    ? 0.95
    : Math.min(1, Math.max(0, parsedThreshold))

  return {
    geminiApiKey: getProp('GEMINI_API_KEY') || '',
    geminiModel: modelName,
    familyEmails: getProp('FAMILY_EMAILS') || '',
    githubToken: getProp('GITHUB_PAT') || '',
    githubRepoOwner: getProp('GITHUB_REPO_OWNER') || '',
    githubRepoName: getProp('GITHUB_REPO_NAME') || '',
    driveRootFolderName: getProp('DRIVE_ROOT_FOLDER_NAME') || '',
    userAccountEmail:
      userEmail ||
      getProp('USER_ACCOUNT_EMAIL') ||
      'household-member@gmail.com',
    customPromptRules: getProp('CUSTOM_PROMPT_RULES') || '',
    auditDigestEmail: getProp('AUDIT_DIGEST_EMAIL') || '',
    auditLookbackDays: auditLookbackDays,
    processedLabel: getProp('PROCESSED_LABEL') || 'Processed',
    retryLabel: getProp('RETRY_LABEL') || 'AI/Needs-Retry',
    manualReviewLabel: getProp('MANUAL_REVIEW_LABEL') || 'AI/Manual-Review',
    unprocessedQuery:
      getProp('UNPROCESSED_QUERY') ||
      'label:AI/Needs-Retry OR (in:inbox -label:Processed -label:AI/Manual-Review) OR (newer_than:14d -label:Processed -label:AI/Manual-Review -from:me)',
    autoFilterConfidenceThreshold: autoFilterConfidenceThreshold,
    modelEndpoint:
      customEndpoint ||
      'https://generativelanguage.googleapis.com/v1beta/models/' +
        modelName +
        ':generateContent',

    // 7 Canonical Domain Folders & Label Tree
    canonicalDomains: [
      '01_Household',
      '02_Finance_Legal',
      '03_Vehicles',
      '04_Family_Health',
      '05_Tech_Infrastructure',
      '06_Work_Career',
      '07_Community_NonProfit',
    ],
  }
}

function getClassifierConfig() {
  return getAiClassifierConfig()
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { getAiClassifierConfig, getClassifierConfig }
}
