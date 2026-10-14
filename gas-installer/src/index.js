/**
 * Gas Installer – pure utility functions.
 *
 * Extracted from Code.gs so they can be unit-tested in Jest without
 * requiring any Google Apps Script runtime globals.
 */

'use strict'

const GITHUB_API_BASE =
  'https://api.github.com/repos/combsmith/google-app-scripts/contents/src'

const APPS_SCRIPT_API_BASE = 'https://script.googleapis.com/v1'

/**
 * Maps a filename extension to the Apps Script REST API `type` enum value.
 *
 * @param {string} filename
 * @returns {'SERVER_JS'|'HTML'|null} `null` when the file type is not
 *   supported and should be skipped.
 */
function getFileType(filename) {
  if (!filename || typeof filename !== 'string') return null
  if (filename.endsWith('.gs')) return 'SERVER_JS'
  if (filename.endsWith('.html')) return 'HTML'
  return null
}

/**
 * Filters and maps a GitHub Contents API items array to the minimal set of
 * fields needed to subsequently fetch each file's raw content.
 *
 * Only file-type items with a `.gs` or `.html` extension are kept.
 * The returned `name` has its extension stripped so it is ready for the
 * Apps Script API (which expects bare names like `'code'`, `'Index'`).
 *
 * @param {Array} items - Raw array from the GitHub Contents API response.
 * @returns {Array<{name: string, type: string, download_url: string}>}
 */
function filterGithubItems(items) {
  if (!Array.isArray(items)) return []
  return items
    .filter(
      (item) =>
        item?.type === 'file' &&
        typeof item.name === 'string' &&
        item.download_url
    )
    .map((item) => ({
      name: item.name.replace(/\.(gs|html)$/, ''),
      type: getFileType(item.name),
      download_url: item.download_url,
    }))
    .filter((item) => item.type !== null)
}

/**
 * Builds the `appsscript.json` manifest file descriptor that must be
 * included in every `projects.updateContent` payload.
 *
 * @returns {{name: string, type: string, source: string}}
 */
function buildManifestFile() {
  return {
    name: 'appsscript',
    type: 'JSON',
    source: JSON.stringify(
      {
        timeZone: 'America/New_York',
        dependencies: {},
        exceptionLogging: 'STACKDRIVER',
        runtimeVersion: 'V8',
      },
      null,
      2
    ),
  }
}

/**
 * Assembles the complete `files` array for the Apps Script REST API
 * `projects.updateContent` call.  Always prepends the `appsscript.json`
 * manifest so the project is well-formed.
 *
 * @param {Array<{name: string, type: string, source: string}>} sourceFiles
 *   File descriptors (type already set to `'SERVER_JS'` or `'HTML'`).
 * @returns {Array<{name: string, type: string, source: string}>}
 * @throws {Error} When `sourceFiles` is not a non-empty array.
 */
function buildDeploymentPayload(sourceFiles) {
  if (!Array.isArray(sourceFiles) || sourceFiles.length === 0) {
    throw new Error('sourceFiles must be a non-empty array')
  }
  return [buildManifestFile(), ...sourceFiles]
}

module.exports = {
  GITHUB_API_BASE,
  APPS_SCRIPT_API_BASE,
  getFileType,
  filterGithubItems,
  buildManifestFile,
  buildDeploymentPayload,
}
