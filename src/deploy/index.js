/**
 * Deployment utilities for Google Apps Script projects.
 *
 * Provides functions for building project content and interacting with the
 * Google Apps Script REST API so that scripts from this repository can be
 * deployed directly from a user's web browser using their Google account.
 *
 * All API-calling functions accept an injectable `fetchFn` parameter so they
 * remain fully testable in Jest without mocking global `fetch`.
 */

'use strict'

const APPS_SCRIPT_API_BASE = 'https://script.googleapis.com/v1'

/**
 * Returns the catalog of deployable scripts included in this repository.
 * Each entry describes the script, its source files (relative to the
 * repository root `src/` directory), and the OAuth scopes it requires.
 *
 * @returns {Array<{id: string, name: string, description: string, files: string[], scopes: string[]}>}
 */
function getScriptCatalog() {
  return [
    {
      id: 'gmail-to-drive-by-labels',
      name: 'Gmail to Drive By Labels',
      description:
        'Automatically archives emails from specific Gmail labels into a ' +
        'Google Doc (text) and a Google Drive Folder (attachments). ' +
        'Features robust text cleaning and smart attachment de-duplication.',
      files: ['code.gs', 'config.gs'],
      scopes: [
        'https://www.googleapis.com/auth/gmail.modify',
        'https://www.googleapis.com/auth/drive',
        'https://www.googleapis.com/auth/documents',
        'https://www.googleapis.com/auth/script.external_request',
      ],
    },
    {
      id: 'calendar-to-sheets',
      name: 'Calendar to Sheets',
      description:
        'Syncs Google Calendar events into a Google Sheet, keeping rows ' +
        'up to date on changes and deletions.',
      files: ['code.gs', 'config.gs'],
      scopes: [
        'https://www.googleapis.com/auth/calendar.readonly',
        'https://www.googleapis.com/auth/spreadsheets',
      ],
    },
    {
      id: 'calendar-to-briefing-doc',
      name: 'Calendar to Briefing Doc',
      description:
        'Generates a weekly calendar briefing and emails it to configured ' +
        'recipients, grouped by day with times, locations, attendees, and ' +
        'conflict warnings. Shows which calendar each event comes from.',
      files: ['code.gs', 'config.gs'],
      scopes: [
        'https://www.googleapis.com/auth/calendar.readonly',
        'https://www.googleapis.com/auth/gmail.send',
      ],
    },
  ]
}

/**
 * Looks up a single script entry from the catalog by its `id`.
 *
 * @param {string} scriptId - The `id` of the script (e.g. 'calendar-to-sheets').
 * @returns {{id: string, name: string, description: string, files: string[], scopes: string[]}|null}
 *   The catalog entry, or `null` if not found.
 */
function getScriptById(scriptId) {
  if (!scriptId) return null
  const catalog = getScriptCatalog()
  return catalog.find((s) => s.id === scriptId) ?? null
}

/**
 * Builds the `files` array expected by the Apps Script REST API
 * (`projects.updateContent`).  Each file object has the shape:
 *   `{ name, type, source }`
 * where `type` is `'SERVER_JS'` for `.gs` files.
 *
 * @param {Array<{name: string, source: string}>} files
 *   File descriptors.  `name` should be the bare filename without extension
 *   (e.g. `'code'`).
 * @returns {{files: Array<{name: string, type: string, source: string}>}}
 * @throws {Error} When `files` is not a non-empty array or any entry is missing
 *   required fields.
 */
function buildProjectContent(files) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('files must be a non-empty array')
  }
  for (const f of files) {
    if (!f || typeof f.name !== 'string' || !f.name) {
      throw new Error('Each file must have a non-empty string name')
    }
    if (typeof f.source !== 'string') {
      throw new TypeError('Each file must have a string source')
    }
  }
  return {
    files: files.map((f) => ({
      name: f.name,
      type: 'SERVER_JS',
      source: f.source,
    })),
  }
}

/**
 * Creates a new Apps Script project via the REST API.
 *
 * @param {Function} fetchFn - A `fetch`-compatible function (injectable for testing).
 * @param {string} accessToken - A valid OAuth 2.0 access token with the
 *   `https://www.googleapis.com/auth/script.projects` scope.
 * @param {string} title - The display title for the new project.
 * @returns {Promise<{scriptId: string, title: string, createTime: string, updateTime: string}>}
 * @throws {Error} On missing arguments or a non-OK HTTP response.
 */
async function createProject(fetchFn, accessToken, title) {
  if (typeof fetchFn !== 'function')
    throw new Error('fetchFn must be a function')
  if (!accessToken) throw new Error('accessToken is required')
  if (!title) throw new Error('title is required')

  const response = await fetchFn(`${APPS_SCRIPT_API_BASE}/projects`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ title }),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Failed to create project: ${response.status} ${text}`)
  }

  return response.json()
}

/**
 * Replaces the source files of an existing Apps Script project.
 *
 * @param {Function} fetchFn - A `fetch`-compatible function (injectable for testing).
 * @param {string} accessToken - A valid OAuth 2.0 access token.
 * @param {string} scriptId - The Apps Script project ID returned by `createProject`.
 * @param {{files: Array<{name: string, type: string, source: string}>}} content
 *   The project content object produced by `buildProjectContent`.
 * @returns {Promise<{files: Array}>} The updated project content as returned by
 *   the API.
 * @throws {Error} On missing arguments or a non-OK HTTP response.
 */
async function updateProjectContent(fetchFn, accessToken, scriptId, content) {
  if (typeof fetchFn !== 'function')
    throw new Error('fetchFn must be a function')
  if (!accessToken) throw new Error('accessToken is required')
  if (!scriptId) throw new Error('scriptId is required')
  if (!content || !Array.isArray(content.files)) {
    throw new Error('content must be an object with a files array')
  }

  const response = await fetchFn(
    `${APPS_SCRIPT_API_BASE}/projects/${scriptId}/content`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(content),
    }
  )

  if (!response.ok) {
    const text = await response.text()
    throw new Error(
      `Failed to update project content: ${response.status} ${text}`
    )
  }

  return response.json()
}

/**
 * High-level helper: creates a new Apps Script project and uploads the
 * provided source files in one call.
 *
 * @param {Function} fetchFn - A `fetch`-compatible function (injectable for testing).
 * @param {string} accessToken - A valid OAuth 2.0 access token with both
 *   `script.projects` and `script.projects.readonly` scopes.
 * @param {string} title - Display title for the project.
 * @param {Array<{name: string, source: string}>} files - File descriptors.
 * @returns {Promise<{scriptId: string, title: string, appsScriptUrl: string}>}
 *   A summary with the new project's ID and a direct link to open it.
 * @throws {Error} On any API or validation failure.
 */
async function deployScript(fetchFn, accessToken, title, files) {
  const project = await createProject(fetchFn, accessToken, title)
  const content = buildProjectContent(files)
  await updateProjectContent(fetchFn, accessToken, project.scriptId, content)
  return {
    scriptId: project.scriptId,
    title: project.title,
    appsScriptUrl: `https://script.google.com/d/${project.scriptId}/edit`,
  }
}

const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1'

/**
 * Creates a new Gmail label in the authenticated user's account.
 *
 * @param {Function} fetchFn - A `fetch`-compatible function (injectable for testing).
 * @param {string} accessToken - A valid OAuth 2.0 access token with the
 *   `https://www.googleapis.com/auth/gmail.labels` scope.
 * @param {string} labelName - The name of the label to create. Nested labels
 *   use `/` as a separator (e.g. `"Projects/receipts"`).
 * @returns {Promise<{id: string, name: string}>} The created label object.
 * @throws {Error} On missing arguments or a non-OK HTTP response.
 */
async function createGmailLabel(fetchFn, accessToken, labelName) {
  if (typeof fetchFn !== 'function')
    throw new Error('fetchFn must be a function')
  if (!accessToken) throw new Error('accessToken is required')
  if (!labelName) throw new Error('labelName is required')

  const response = await fetchFn(`${GMAIL_API_BASE}/users/me/labels`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: labelName }),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Failed to create Gmail label: ${response.status} ${text}`)
  }

  return response.json()
}

/**
 * Escapes HTML special characters to prevent XSS injection.
 *
 * @param {string|null} str - The string to escape.
 * @returns {string} The escaped string, or empty string if input is null/undefined.
 */
function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#x27;')
}

/**
 * Builds the success banner HTML for a set of deployed projects.
 *
 * @param {Array<{scriptId: string, title: string, catalogId: string}>} deployedProjects
 * @returns {string} HTML string for the success banner.
 */
function buildDeploySuccessHtml(deployedProjects) {
  if (!Array.isArray(deployedProjects)) return ''

  const projectLinksHtml = deployedProjects
    .map((p) => {
      const safeId = escapeHtml(p.scriptId)
      return (
        `<div style="border:1px solid #c8e6c9;border-radius:6px;padding:12px 16px;margin-top:12px;">` +
        `<div style="font-size:13px;font-weight:600;color:#137333;">✅ Deployed successfully</div>` +
        `<a class="result-link" href="https://script.google.com/d/${safeId}/edit" ` +
        `target="_blank" rel="noopener noreferrer" style="margin-top:6px;display:block;">` +
        `${escapeHtml(p.title)} ↗</a>` +
        `</div>`
      )
    })
    .join('')

  const headline =
    deployedProjects.length === 1
      ? 'Script deployed!'
      : `${deployedProjects.length} scripts deployed!`

  return (
    `✅ <strong>${headline}</strong>` +
    `<span style="font-size:13px;color:#137333;display:block;margin-top:4px;">` +
    `Now configure each script below, then activate the trigger.</span>` +
    projectLinksHtml
  )
}

/**
 * Builds the failure banner HTML for a deployment error.
 *
 * @param {Error} err - The error that occurred.
 * @returns {string} HTML string for the error banner.
 */
function buildDeployErrorHtml(err) {
  if (!err) return '❌ Deployment failed: Unknown error'

  const isApiDisabled = err.message?.includes('Apps Script API')
  const errorDetail = err.stack || err.message || String(err)
  const safeErrorDetail = escapeHtml(errorDetail)
  const errorDetailBlock =
    `<details style="margin-top:6px;font-size:12px;">` +
    `<summary style="cursor:pointer;color:#888;">Error detail</summary>` +
    `<div class="error-detail">${safeErrorDetail}</div>` +
    // The browser decodes the escaped attribute, so dataset.copy is already the
    // original text. Never re-parse it as HTML (#595).
    `<button class="copy-btn" data-copy="${safeErrorDetail}"` +
    ` onclick="navigator.clipboard.writeText(this.dataset.copy).catch(()=>{})">` +
    `📋 Copy error</button>` +
    `</details>`

  if (isApiDisabled) {
    return (
      '❌ Deployment failed: User has not enabled the Apps Script API.' +
      '<a href="https://script.google.com/home/usersettings" target="_blank" rel="noopener noreferrer"' +
      ' style="display:block;margin-top:8px;">' +
      '👉 Enable it at script.google.com/home/usersettings' +
      '</a>' +
      '<span style="font-size:12px;color:#888;display:block;margin-top:4px;">' +
      'After enabling, wait a minute then try again.' +
      '</span>' +
      errorDetailBlock
    )
  }

  return (
    `❌ Deployment failed: ${escapeHtml(err.message || String(err))}` +
    errorDetailBlock
  )
}

module.exports = {
  APPS_SCRIPT_API_BASE,
  GMAIL_API_BASE,
  getScriptCatalog,
  getScriptById,
  buildProjectContent,
  createProject,
  updateProjectContent,
  deployScript,
  createGmailLabel,
  escapeHtml,
  buildDeploySuccessHtml,
  buildDeployErrorHtml,
}
