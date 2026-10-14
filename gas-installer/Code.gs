/**
 * Gas Installer — Google Apps Script Web App
 *
 * Serves an HTML frontend that lets a signed-in Google user choose one of the
 * scripts in this repository and deploy it as a new Apps Script project in
 * their own account.
 *
 * Deploy this file (together with Index.html and appsscript.json) as a Web App
 * with:
 *   Execute as: User accessing the web app
 *   Who has access: Anyone
 */

var GITHUB_API_BASE =
  'https://api.github.com/repos/combsmith/google-app-scripts/contents/src'
var APPS_SCRIPT_API = 'https://script.googleapis.com/v1'

/**
 * Entry point — serves the installer HTML page.
 *
 * @param {Object} e - The event object passed by the Apps Script runtime.
 * @returns {HtmlOutput}
 */
function doGet(e) {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Google Apps Script Installer')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
}

/**
 * Fetches all `.gs` and `.html` files from the GitHub folder for the given
 * script and returns them as an array ready for the Apps Script REST API.
 *
 * @param {string} scriptFolderName - The subfolder name under `src/` in the
 *   repository (e.g. `'gmail-to-drive-by-labels'`).
 * @returns {Array<{name: string, type: string, source: string}>}
 *   `type` is `'SERVER_JS'` for `.gs` files and `'HTML'` for `.html` files.
 *   `name` has the extension stripped (Apps Script API convention).
 * @throws {Error} On GitHub API errors or failed file fetches.
 */
function getFilesFromGithub(scriptFolderName) {
  var url = GITHUB_API_BASE + '/' + scriptFolderName
  var listResponse = UrlFetchApp.fetch(url, {
    headers: { 'User-Agent': 'gas-installer/1.0' },
    muteHttpExceptions: true,
  })

  if (listResponse.getResponseCode() !== 200) {
    throw new Error(
      'GitHub API error ' +
        listResponse.getResponseCode() +
        ': ' +
        listResponse.getContentText()
    )
  }

  var items = JSON.parse(listResponse.getContentText())
  var files = []

  for (var i = 0; i < items.length; i++) {
    var item = items[i]
    if (item.type !== 'file') continue

    // Determine GAS file type from extension
    var fileType = null
    if (/\.gs$/.test(item.name)) {
      fileType = 'SERVER_JS'
    } else if (/\.html$/.test(item.name)) {
      fileType = 'HTML'
    }
    if (!fileType) continue

    var rawResponse = UrlFetchApp.fetch(item.download_url, {
      headers: { 'User-Agent': 'gas-installer/1.0' },
      muteHttpExceptions: true,
    })

    if (rawResponse.getResponseCode() !== 200) {
      throw new Error(
        'Failed to fetch ' + item.name + ': ' + rawResponse.getResponseCode()
      )
    }

    files.push({
      name: item.name.replace(/\.(gs|html)$/, ''),
      type: fileType,
      source: rawResponse.getContentText(),
    })
  }

  return files
}

/**
 * Creates a new Apps Script project and uploads the source files fetched from
 * GitHub.
 *
 * Called from the frontend via `google.script.run`.
 *
 * @param {string} projectName - Display name for the new Apps Script project.
 * @param {string} scriptFolderName - The subfolder name under `src/` in the
 *   repository (e.g. `'calendar-to-sheets'`).
 * @returns {string} The `scriptId` of the newly created project.
 * @throws {Error} On any API failure.
 */
function deployScript(projectName, scriptFolderName) {
  var token = ScriptApp.getOAuthToken()
  var authHeaders = {
    Authorization: 'Bearer ' + token,
    'Content-Type': 'application/json',
  }

  // 1. Fetch source files from GitHub
  var sourceFiles = getFilesFromGithub(scriptFolderName)

  // 2. Create the new project
  var createResponse = UrlFetchApp.fetch(APPS_SCRIPT_API + '/projects', {
    method: 'post',
    headers: authHeaders,
    payload: JSON.stringify({ title: projectName }),
    muteHttpExceptions: true,
  })

  if (createResponse.getResponseCode() !== 200) {
    throw new Error(
      'Failed to create project: ' +
        createResponse.getResponseCode() +
        ' ' +
        createResponse.getContentText()
    )
  }

  var project = JSON.parse(createResponse.getContentText())
  var scriptId = project.scriptId

  // 3. Build the deployment payload: manifest + source files
  var manifest = {
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

  var payload = { files: [manifest].concat(sourceFiles) }

  // 4. Upload the files
  var contentResponse = UrlFetchApp.fetch(
    APPS_SCRIPT_API + '/projects/' + scriptId + '/content',
    {
      method: 'put',
      headers: authHeaders,
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    }
  )

  if (contentResponse.getResponseCode() !== 200) {
    throw new Error(
      'Failed to upload files: ' +
        contentResponse.getResponseCode() +
        ' ' +
        contentResponse.getContentText()
    )
  }

  return scriptId
}
