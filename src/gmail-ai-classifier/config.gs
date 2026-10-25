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
  var modelName =
    (props && typeof props.getProperty === 'function'
      ? props.getProperty('GEMINI_MODEL')
      : null) || 'gemini-2.0-flash'

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

  return {
    geminiApiKey:
      (props && typeof props.getProperty === 'function'
        ? props.getProperty('GEMINI_API_KEY')
        : '') || '',
    geminiModel: modelName,
    familyEmails:
      (props && typeof props.getProperty === 'function'
        ? props.getProperty('FAMILY_EMAILS')
        : '') || '',
    githubToken:
      (props && typeof props.getProperty === 'function'
        ? props.getProperty('GITHUB_PAT')
        : '') || '',
    githubRepoOwner:
      (props && typeof props.getProperty === 'function'
        ? props.getProperty('GITHUB_REPO_OWNER')
        : '') || 'don-petry',
    githubRepoName:
      (props && typeof props.getProperty === 'function'
        ? props.getProperty('GITHUB_REPO_NAME')
        : '') || 'self-private',
    userAccountEmail:
      userEmail ||
      (props && typeof props.getProperty === 'function'
        ? props.getProperty('USER_ACCOUNT_EMAIL')
        : null) ||
      'household-member@gmail.com',
    customPromptRules:
      (props && typeof props.getProperty === 'function'
        ? props.getProperty('CUSTOM_PROMPT_RULES')
        : '') || '',
    auditDigestEmail:
      (props && typeof props.getProperty === 'function'
        ? props.getProperty('AUDIT_DIGEST_EMAIL')
        : '') || '',
    auditLookbackDays: parseInt(
      (props && typeof props.getProperty === 'function'
        ? props.getProperty('AUDIT_LOOKBACK_DAYS')
        : null) || '2',
      10
    ),
    processedLabel:
      (props && typeof props.getProperty === 'function'
        ? props.getProperty('PROCESSED_LABEL')
        : '') || 'Processed',
    retryLabel:
      (props && typeof props.getProperty === 'function'
        ? props.getProperty('RETRY_LABEL')
        : '') || 'AI/Needs-Retry',
    manualReviewLabel:
      (props && typeof props.getProperty === 'function'
        ? props.getProperty('MANUAL_REVIEW_LABEL')
        : '') || 'AI/Manual-Review',
    unprocessedQuery:
      (props && typeof props.getProperty === 'function'
        ? props.getProperty('UNPROCESSED_QUERY')
        : null) ||
      'label:AI/Needs-Retry OR (in:inbox -label:Processed -label:AI/Manual-Review)',
    autoFilterConfidenceThreshold: parseFloat(
      (props && typeof props.getProperty === 'function'
        ? props.getProperty('AUTO_FILTER_THRESHOLD')
        : null) || '0.95'
    ),
    modelEndpoint:
      (props && typeof props.getProperty === 'function'
        ? props.getProperty('GEMINI_ENDPOINT')
        : '') ||
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
