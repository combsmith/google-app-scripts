/**
 * Configuration schema for Gemini AI Semantic Email Classifier & Auto-Filter Engine
 * Supports Multi-Account Household Deployment (Option A)
 */

function getAiClassifierConfig() {
  var props = PropertiesService.getScriptProperties()

  return {
    geminiApiKey: props.getProperty('GEMINI_API_KEY') || '',
    githubToken: props.getProperty('GITHUB_PAT') || '',
    githubRepoOwner: props.getProperty('GITHUB_REPO_OWNER') || 'don-petry',
    githubRepoName: props.getProperty('GITHUB_REPO_NAME') || 'self-private',
    userAccountEmail:
      Session.getEffectiveUser().getEmail() ||
      props.getProperty('USER_ACCOUNT_EMAIL') ||
      'household-member@gmail.com',
    customPromptRules: props.getProperty('CUSTOM_PROMPT_RULES') || '',
    auditDigestEmail: props.getProperty('AUDIT_DIGEST_EMAIL') || '',
    auditLookbackDays: parseInt(
      props.getProperty('AUDIT_LOOKBACK_DAYS') || '2',
      10
    ),
    processedLabel: 'Processed',
    unprocessedQuery: 'in:inbox -label:Processed',
    autoFilterConfidenceThreshold: 0.95,
    modelEndpoint:
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent',

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
