/**
 * Configuration schema for Google Drive AI Ingestion Engine
 * Monitors 7 Canonical Folders, applies Dual-Layer Hybrid Tags, and syncs to GitHub.
 */

function getDriveIngesterConfig() {
  var props = PropertiesService.getScriptProperties()
  var userEmail = null
  try {
    userEmail =
      Session.getEffectiveUser().getEmail() ||
      props.getProperty('USER_ACCOUNT_EMAIL') ||
      null
  } catch (e) {
    userEmail = props.getProperty('USER_ACCOUNT_EMAIL') || null
  }

  return {
    geminiApiKey: props.getProperty('GEMINI_API_KEY') || '',
    githubToken: props.getProperty('GITHUB_PAT') || '',
    githubRepoOwner: props.getProperty('GITHUB_REPO_OWNER') || '',
    githubRepoName: props.getProperty('GITHUB_REPO_NAME') || '',
    userAccountEmail: userEmail,

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

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { getDriveIngesterConfig: getDriveIngesterConfig }
}
