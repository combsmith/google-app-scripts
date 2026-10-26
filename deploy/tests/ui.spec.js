// @ts-check
'use strict'

/**
 * Playwright end-to-end tests for deploy/index.html.
 *
 * External dependencies are fully mocked:
 *   - Google Identity Services (GIS) script blocked via page.route() and
 *     replaced with a synchronous mock injected via addInitScript.
 *   - GitHub raw file requests intercepted via page.route().
 *   - Apps Script REST API requests intercepted via page.route().
 */

const { test, expect } = require('@playwright/test')
const path = require('path')

const PAGE_URL = `file://${path.resolve(__dirname, '..', 'index.html')}`

// ── GIS OAuth mock ────────────────────────────────────────────────────────────

/**
 * Injected into the browser before any page scripts run.
 * Replaces google.accounts.oauth2 with a synchronous stub.
 *
 * Modes (controlled via window.__authMode):
 *   'success' – immediately calls callback with a fake access_token
 *   'failure' – immediately calls callback with an error
 */
function injectGisMock() {
  window.__authMode = 'success'
  window.__clientIdUsed = null

  window.google = {
    accounts: {
      oauth2: {
        initTokenClient(config) {
          window.__clientIdUsed = config.client_id
          return {
            requestAccessToken() {
              if (window.__authMode === 'success') {
                config.callback({ access_token: 'mock-access-token-xyz' })
              } else {
                config.callback({ error: 'access_denied' })
              }
            },
          }
        },
      },
    },
  }
}

// ── Route helpers ─────────────────────────────────────────────────────────────

/** Sets up routes for a complete, successful deploy flow. */
async function mockSuccessfulDeploy(page) {
  // GitHub raw source files
  await page.route('https://raw.githubusercontent.com/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/plain',
      body: '// @version 1.0.0\n// mock script source\nfunction main() {}',
    })
  })

  // Apps Script REST API — project creation, content upload, and content read
  await page.route('https://script.googleapis.com/**', async (route) => {
    const url = route.request().url()
    const method = route.request().method()

    if (method === 'POST' && url.endsWith('/projects')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ scriptId: 'mock-project-id-abc' }),
      })
    } else if (method === 'GET' && url.includes('/content')) {
      // Return project content for saveConfig GET request
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          files: [
            { name: 'appsscript', type: 'JSON', source: '{}' },
            { name: 'config', type: 'SERVER_JS', source: '// config' },
            {
              name: 'code',
              type: 'SERVER_JS',
              source: '// @version 1.0.0\n// code',
            },
          ],
        }),
      })
    } else if (method === 'PUT' && url.includes('/content')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({}),
      })
    } else if (method === 'GET' && url.includes('/projects/')) {
      // GET project metadata (for idempotency check)
      const scriptId = url.split('/projects/')[1].split('/')[0]
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ scriptId, title: 'Mock Project' }),
      })
    } else {
      await route.continue()
    }
  })
}

/** Clicks Sign in. */
async function signIn(page) {
  await page.locator('#btn-signin').click()
}

// ── Test suite ────────────────────────────────────────────────────────────────

test.describe('deploy index.html', () => {
  test.beforeEach(async ({ page }) => {
    // Block the real GIS script so it cannot overwrite our mock
    await page.route('https://accounts.google.com/**', (route) => route.abort())

    // Mock Google APIs (Calendar + userinfo + Drive)
    await page.route('https://www.googleapis.com/**', async (route) => {
      const url = route.request().url()
      if (url.includes('calendarList')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            items: [
              { id: 'primary@gmail.com', summary: 'Primary', primary: true },
              { id: 'work@group.calendar', summary: 'Work' },
              { id: 'family@group.calendar', summary: 'Family' },
            ],
          }),
        })
      } else if (url.includes('userinfo')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ email: 'testuser@gmail.com' }),
        })
      } else if (url.includes('drive/v3/files')) {
        // Default: no existing projects found
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ files: [] }),
        })
      } else {
        await route.continue()
      }
    })

    // Mock Gmail API (separate domain)
    await page.route('https://gmail.googleapis.com/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          labels: [
            { name: 'receipts', type: 'user' },
            { name: 'receipts-archived', type: 'user' },
            { name: 'invoices', type: 'user' },
            { name: 'INBOX', type: 'system' },
          ],
        }),
      })
    })

    // Inject the synchronous GIS mock before page scripts run
    await page.addInitScript(injectGisMock)

    await page.goto(PAGE_URL)
  })

  // ── Page structure ──────────────────────────────────────────────────────────

  test('has correct page title', async ({ page }) => {
    await expect(page).toHaveTitle('Deploy Google Apps Scripts')
  })

  test('renders heading and subtitle', async ({ page }) => {
    await expect(page.locator('h1')).toContainText('Deploy Google Apps Scripts')
    await expect(page.locator('header p')).toContainText('Deploy a script')
  })

  test('Step 2 is hidden before sign-in', async ({ page }) => {
    await expect(page.locator('#step2-card')).toBeHidden()
  })

  test('Step 2 appears after sign-in', async ({ page }) => {
    await signIn(page)
    await expect(page.locator('#step2-card')).toBeVisible()
  })

  test('renders step badges including hidden steps', async ({ page }) => {
    const badges = page.locator('.step-badge')
    // All 3 badges exist in the DOM
    await expect(badges).toHaveCount(3)
    await expect(badges.nth(0)).toHaveText('1')
    await expect(badges.nth(1)).toHaveText('2')
    await expect(badges.nth(2)).toHaveText('3')
    // Only Steps 1 and 2 are visible; Step 3 badge is inside hidden card
    await expect(page.locator('#step3-card')).toBeHidden()
  })

  test('renders sign-in button', async ({ page }) => {
    await expect(page.locator('#btn-signin')).toBeVisible()
    await expect(page.locator('#btn-signin')).toContainText(
      'Sign in with Google'
    )
  })

  // ── Step 3 hidden on load ─────────────────────────────────────────────────

  test('Step 3 card is hidden on page load', async ({ page }) => {
    await expect(page.locator('#step3-card')).toBeHidden()
    // Verify it uses display:none
    const display = await page
      .locator('#step3-card')
      .evaluate((el) => el.style.display)
    expect(display).toBe('none')
  })

  test('Step 3 appears after sign-in when projects exist in Google Drive', async ({
    page,
  }) => {
    // Override the default Drive API mock to return existing projects
    await page.route(
      'https://www.googleapis.com/drive/v3/files**',
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            files: [
              {
                id: 'drive-gmail-123',
                name: 'Petry-Projects \u2013 Gmail to Drive By Labels',
              },
              {
                id: 'drive-sheets-456',
                name: 'Petry-Projects \u2013 Calendar to Sheets',
              },
              {
                id: 'drive-briefing-789',
                name: 'Petry-Projects \u2013 Calendar to Briefing Doc',
              },
            ],
          }),
        })
      }
    )

    await signIn(page)
    // Wait for loadExistingDeployments (Drive API) to complete
    await expect(page.locator('#step3-card')).toBeVisible({ timeout: 10000 })
    await expect(page.locator('#btn-configure-drive-gmail-123')).toBeVisible()
    await expect(page.locator('#btn-configure-drive-sheets-456')).toBeVisible()
    await expect(
      page.locator('#btn-configure-drive-briefing-789')
    ).toBeVisible()
    // Step 2 should show 3 "Deployed" badges
    await expect(page.locator('.deploy-badge')).toHaveCount(3)
  })

  test('Step 3 stays hidden after sign-in when no projects in Drive', async ({
    page,
  }) => {
    // Default mock returns empty files array; wait for the Drive lookup to
    // actually complete rather than sleeping for a fixed interval.
    const driveLookup = page.waitForResponse(
      (resp) => resp.url().includes('drive/v3/files') && resp.ok()
    )
    await signIn(page)
    await driveLookup
    await expect(page.locator('#step3-card')).toBeHidden()
  })

  test('shows Update available badge when deployed version is outdated', async ({
    page,
  }) => {
    // Drive returns a project; content has old version
    await page.route(
      'https://www.googleapis.com/drive/v3/files**',
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            files: [
              {
                id: 'old-version-id',
                name: 'Petry-Projects \u2013 Gmail to Drive By Labels',
              },
            ],
          }),
        })
      }
    )
    await page.route('https://script.googleapis.com/**', async (route) => {
      const url = route.request().url()
      if (url.includes('/content')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            files: [
              {
                name: 'code',
                type: 'SERVER_JS',
                source: '// @version 0.9.0\nfunction main() {}',
              },
            ],
          }),
        })
      } else if (url.includes('/projects/')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ scriptId: 'old-version-id' }),
        })
      } else {
        await route.continue()
      }
    })

    await signIn(page)
    // Wait for version check to complete
    await expect(
      page.locator('.deploy-badge:has-text("Update available")')
    ).toBeVisible({ timeout: 10000 })
    // Update button should be visible in Step 3 card
    await expect(page.locator('#btn-update-old-version-id')).toBeVisible()
  })

  test('shows Deployed badge when version is current', async ({ page }) => {
    await page.route(
      'https://www.googleapis.com/drive/v3/files**',
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            files: [
              {
                id: 'current-id',
                name: 'Petry-Projects \u2013 Gmail to Drive By Labels',
              },
            ],
          }),
        })
      }
    )
    await page.route('https://script.googleapis.com/**', async (route) => {
      const url = route.request().url()
      if (url.includes('/content')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            files: [
              {
                name: 'code',
                type: 'SERVER_JS',
                source: '// @version 1.0.0\nfunction main() {}',
              },
            ],
          }),
        })
      } else if (url.includes('/projects/')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ scriptId: 'current-id' }),
        })
      } else {
        await route.continue()
      }
    })

    await signIn(page)
    await expect(
      page.locator('.deploy-badge:has-text("Deployed")')
    ).toBeVisible({ timeout: 10000 })
    // Update button should be hidden
    await expect(page.locator('#btn-update-current-id')).toBeHidden()
  })

  // ── Step 2 structure ──────────────────────────────────────────────────────

  test('Step 2 deploy button is inside the Step 2 card', async ({ page }) => {
    await signIn(page)
    const step2Card = page.locator('#step2-card')
    await expect(step2Card.locator('#btn-deploy')).toBeVisible()
    await expect(step2Card.locator('h2')).toContainText('Choose scripts')
  })

  // ── renderScriptList ────────────────────────────────────────────────────────

  test('script list is populated after sign-in', async ({ page }) => {
    await signIn(page)
    const checkboxes = page.locator('#script-list input[type="checkbox"]')
    await expect(checkboxes).toHaveCount(3)
  })

  test('script list shows Gmail to Drive By Labels option', async ({
    page,
  }) => {
    await signIn(page)
    await expect(
      page.locator('#script-list input[value="gmail-to-drive-by-labels"]')
    ).toBeVisible()
    await expect(page.locator('#script-list')).toContainText(
      'Gmail to Drive By Labels'
    )
  })

  test('script list shows Calendar to Sheets option', async ({ page }) => {
    await signIn(page)
    await expect(
      page.locator('#script-list input[value="calendar-to-sheets"]')
    ).toBeVisible()
    await expect(page.locator('#script-list')).toContainText(
      'Calendar to Sheets'
    )
  })

  // ── setDeployEnabled ────────────────────────────────────────────────────────

  test('deploy button is disabled on load', async ({ page }) => {
    await expect(page.locator('#btn-deploy')).toBeDisabled()
  })

  test('deploy button remains disabled after sign-in without script selection', async ({
    page,
  }) => {
    await signIn(page)
    await expect(page.locator('#btn-deploy')).toBeDisabled()
  })

  test('deploy button enables after sign-in with script selected', async ({
    page,
  }) => {
    await signIn(page)
    await page
      .locator('#script-list input[value="gmail-to-drive-by-labels"]')
      .click()
    await expect(page.locator('#btn-deploy')).toBeEnabled()
  })

  // ── handleSignIn ────────────────────────────────────────────────────────────

  test('handleSignIn uses the hardcoded Petry-Projects client ID', async ({
    page,
  }) => {
    await signIn(page)
    const clientId = await page.evaluate(() => window.__clientIdUsed)
    expect(clientId).toBe(
      '873060687431-smmudbpd5rlogt0r7immp0u3tdqb2t3p.apps.googleusercontent.com'
    )
  })

  test('successful sign-in shows signed-in indicator in auth-status span', async ({
    page,
  }) => {
    await signIn(page)
    await expect(page.locator('#auth-status')).toContainText('Signed in')
  })

  test('successful sign-in updates sign-in button text', async ({ page }) => {
    await signIn(page)
    await expect(page.locator('#btn-signin')).toContainText('Signed in')
  })

  test('handleSignIn with OAuth error shows error status', async ({ page }) => {
    await page.evaluate(() => {
      window.__authMode = 'failure'
    })
    await signIn(page)
    await expect(page.locator('.status-error')).toContainText('Sign-in failed')
    await expect(page.locator('.status-error')).toContainText('access_denied')
  })

  // ── handleDeploy – guard paths ──────────────────────────────────────────────

  test('handleDeploy shows error when called without an access token', async ({
    page,
  }) => {
    // Force-show Step 2 and enable button without signing in
    await page.evaluate(() => {
      document.getElementById('step2-card').style.display = ''
      document.getElementById('btn-deploy').disabled = false
    })
    await page
      .locator('#script-list input[value="gmail-to-drive-by-labels"]')
      .click()
    await page.evaluate(() => window.handleDeploy())
    await expect(page.locator('.status-error')).toContainText('sign in first')
  })

  // ── handleDeploy – success flow ─────────────────────────────────────────────

  test('handleDeploy success shows status-ok after deploy', async ({
    page,
  }) => {
    await mockSuccessfulDeploy(page)
    await signIn(page)
    await page
      .locator('#script-list input[value="gmail-to-drive-by-labels"]')
      .click()
    await page.locator('#btn-deploy').click()

    await expect(page.locator('.status-ok')).toBeVisible()
  })

  test('handleDeploy success shows the script name in the message', async ({
    page,
  }) => {
    await mockSuccessfulDeploy(page)
    await signIn(page)
    await page
      .locator('#script-list input[value="gmail-to-drive-by-labels"]')
      .click()
    await page.locator('#btn-deploy').click()
    await expect(page.locator('.status-ok')).toContainText(
      'Gmail to Drive By Labels'
    )
  })

  test('handleDeploy success shows link to the new Apps Script project in Step 3', async ({
    page,
  }) => {
    await mockSuccessfulDeploy(page)
    await signIn(page)
    await page
      .locator('#script-list input[value="gmail-to-drive-by-labels"]')
      .click()
    await page.locator('#btn-deploy').click()

    await expect(page.locator('.status-ok')).toBeVisible()
    // Result link appears in Step 3 card
    const step3Link = page.locator('#step3-card .result-link')
    await expect(step3Link).toHaveAttribute(
      'href',
      'https://script.google.com/d/mock-project-id-abc/edit'
    )
    await expect(step3Link).toHaveAttribute('target', '_blank')
  })

  test('Step 3 appears after successful deploy with Configure buttons', async ({
    page,
  }) => {
    await mockSuccessfulDeploy(page)
    await signIn(page)
    await page
      .locator('#script-list input[value="gmail-to-drive-by-labels"]')
      .click()
    await page.locator('#btn-deploy').click()
    await page.waitForSelector('.status-ok')

    await expect(page.locator('#step3-card')).toBeVisible()
    await expect(
      page.locator('#btn-configure-mock-project-id-abc')
    ).toBeVisible()
  })

  test('Step 3 shows a card for each deployed script', async ({ page }) => {
    let projectIdCounter = 0
    await page.route('https://raw.githubusercontent.com/**', async (route) => {
      await route.fulfill({ status: 200, body: '// code' })
    })
    await page.route('https://script.googleapis.com/**', async (route) => {
      const url = route.request().url()
      const method = route.request().method()
      if (method === 'POST' && url.endsWith('/projects')) {
        projectIdCounter++
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ scriptId: `project-${projectIdCounter}` }),
        })
      } else if (method === 'PUT' && url.includes('/content')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({}),
        })
      } else {
        await route.continue()
      }
    })

    await signIn(page)
    await page
      .locator('#script-list input[value="gmail-to-drive-by-labels"]')
      .click()
    await page.locator('#script-list input[value="calendar-to-sheets"]').click()
    await page.locator('#btn-deploy').click()
    await page.waitForSelector('.status-ok')

    // Two configure buttons — one per deployed script
    await expect(page.locator('#btn-configure-project-1')).toBeVisible()
    await expect(page.locator('#btn-configure-project-2')).toBeVisible()
  })

  test('Configure button toggles config form visibility', async ({ page }) => {
    await mockSuccessfulDeploy(page)
    await signIn(page)
    await page
      .locator('#script-list input[value="gmail-to-drive-by-labels"]')
      .click()
    await page.locator('#btn-deploy').click()
    await page.waitForSelector('.status-ok')

    const configForm = page.locator('#config-form-mock-project-id-abc')
    // Config form is hidden initially
    await expect(configForm).toBeHidden()

    // Click Configure to expand
    await page.locator('#btn-configure-mock-project-id-abc').click()
    await expect(configForm).toBeVisible()

    // Click again to collapse
    await page.locator('#btn-configure-mock-project-id-abc').click()
    await expect(configForm).toBeHidden()
  })

  test('gmail-to-drive config form renders all fields and saves', async ({
    page,
  }) => {
    await mockSuccessfulDeploy(page)
    await signIn(page)
    await page
      .locator('#script-list input[value="gmail-to-drive-by-labels"]')
      .click()
    await page.locator('#btn-deploy').click()
    await page.waitForSelector('.status-ok')
    await page.locator('#btn-configure-mock-project-id-abc').click()

    const form = page.locator('#config-form-mock-project-id-abc')
    // Labels are dropdowns (populated from Gmail API mock)
    await expect(form.locator('[data-key="triggerLabel"]')).toBeVisible()
    await expect(form.locator('[data-key="processedLabel"]')).toBeVisible()
    await expect(form.locator('[data-key="docId"]')).toBeVisible()
    await expect(form.locator('[data-key="folderId"]')).toBeVisible()

    await form.locator('[data-key="triggerLabel"]').selectOption('receipts')
    await form
      .locator('[data-key="processedLabel"]')
      .selectOption('receipts-archived')
    await form.locator('[data-key="docId"]').fill('doc-abc')
    await form.locator('[data-key="folderId"]').fill('folder-xyz')
    await form.locator('.btn-primary').click()
    await expect(form.locator('.btn-primary')).toContainText('Saved')
  })

  test('calendar-to-sheets config form renders all fields and saves', async ({
    page,
  }) => {
    let projectIdCounter = 0
    await page.route('https://raw.githubusercontent.com/**', async (route) => {
      await route.fulfill({ status: 200, body: '// code' })
    })
    await page.route('https://script.googleapis.com/**', async (route) => {
      const url = route.request().url()
      const method = route.request().method()
      if (method === 'POST' && url.endsWith('/projects')) {
        projectIdCounter++
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ scriptId: `sheets-proj-${projectIdCounter}` }),
        })
      } else if (method === 'GET' && url.includes('/content')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            files: [{ name: 'config', type: 'SERVER_JS', source: '// config' }],
          }),
        })
      } else if (method === 'PUT' && url.includes('/content')) {
        await route.fulfill({ status: 200, body: '{}' })
      } else if (method === 'GET' && url.includes('/projects/')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ scriptId: 'sheets-proj-1' }),
        })
      } else {
        await route.continue()
      }
    })
    await signIn(page)
    await page.locator('#script-list input[value="calendar-to-sheets"]').click()
    await page.locator('#btn-deploy').click()
    await page.waitForSelector('.status-ok')

    const configBtn = page.locator('[id^="btn-configure-sheets"]')
    await configBtn.click()

    const form = page.locator('[id^="config-form-sheets"]')
    await expect(form.locator('[data-key="calendarId"]')).toBeVisible()
    await expect(form.locator('input[data-key="spreadsheetId"]')).toBeVisible()
    await expect(form.locator('input[data-key="sheetName"]')).toBeVisible()

    await form.locator('input[data-key="spreadsheetId"]').fill('ss-123')
    await form.locator('.btn-primary').click()
    await expect(form.locator('.btn-primary')).toContainText('Saved')
  })

  test('calendar-to-briefing-doc config form renders all fields and saves', async ({
    page,
  }) => {
    let projectIdCounter = 0
    await page.route('https://raw.githubusercontent.com/**', async (route) => {
      await route.fulfill({ status: 200, body: '// code' })
    })
    await page.route('https://script.googleapis.com/**', async (route) => {
      const url = route.request().url()
      const method = route.request().method()
      if (method === 'POST' && url.endsWith('/projects')) {
        projectIdCounter++
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            scriptId: `briefing-proj-${projectIdCounter}`,
          }),
        })
      } else if (method === 'GET' && url.includes('/content')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            files: [{ name: 'config', type: 'SERVER_JS', source: '// config' }],
          }),
        })
      } else if (method === 'PUT' && url.includes('/content')) {
        await route.fulfill({ status: 200, body: '{}' })
      } else if (method === 'GET' && url.includes('/projects/')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ scriptId: 'briefing-proj-1' }),
        })
      } else {
        await route.continue()
      }
    })
    await signIn(page)
    await page
      .locator('#script-list input[value="calendar-to-briefing-doc"]')
      .click()
    await page.locator('#btn-deploy').click()
    await page.waitForSelector('.status-ok')

    const configBtn = page.locator('[id^="btn-configure-briefing"]')
    await configBtn.click()

    const form = page.locator('[id^="config-form-briefing"]')
    await expect(form.locator('[data-key="email"]')).toBeVisible()
    await expect(form.locator('[data-key="subject"]')).toBeVisible()
    await expect(form.locator('[data-key="frequency"]')).toBeVisible()
    await expect(form.locator('[data-key="lookaheadDays"]')).toBeVisible()

    await form.locator('[data-key="email"]').fill('user@test.com')
    await form.locator('.btn-primary').click()
    await expect(form.locator('.btn-primary')).toContainText('Saved')
  })

  test('handleDeploy renders a per-script card with Deployed successfully', async ({
    page,
  }) => {
    await mockSuccessfulDeploy(page)
    await signIn(page)
    await page
      .locator('#script-list input[value="gmail-to-drive-by-labels"]')
      .click()
    await page.locator('#btn-deploy').click()
    await page.waitForSelector('.status-ok')
    // Status area shows "Deployed successfully" per project
    await expect(page.locator('.status-ok')).toContainText(
      'Deployed successfully'
    )
  })

  test('deploy button resets to "Deploy to my account" after successful deploy', async ({
    page,
  }) => {
    await mockSuccessfulDeploy(page)
    await signIn(page)
    await page.locator('#script-list input[value="calendar-to-sheets"]').click()
    await page.locator('#btn-deploy').click()
    await page.waitForSelector('.status-ok')
    await expect(page.locator('#btn-deploy')).toHaveText('Deploy to my account')
  })

  test('deploy button shows "Re-deploy" when a deployed script is re-checked', async ({
    page,
  }) => {
    await mockSuccessfulDeploy(page)
    await signIn(page)
    await page.locator('#script-list input[value="calendar-to-sheets"]').click()
    await page.locator('#btn-deploy').click()
    await page.waitForSelector('.status-ok')
    // Script list re-rendered with "Deployed" badge; re-check the script
    await page.locator('#script-list input[value="calendar-to-sheets"]').click()
    await expect(page.locator('#btn-deploy')).toHaveText(
      'Re-deploy to my account'
    )
  })

  // ── fetchScriptFiles – URL construction ─────────────────────────────────────

  test('fetchScriptFiles fetches code.gs and config.gs from the correct GitHub URL', async ({
    page,
  }) => {
    const capturedUrls = []
    await page.route('https://raw.githubusercontent.com/**', async (route) => {
      capturedUrls.push(route.request().url())
      await route.fulfill({ status: 200, body: '// code' })
    })
    await page.route('https://script.googleapis.com/**', async (route) => {
      const url = route.request().url()
      if (route.request().method() === 'POST' && url.endsWith('/projects')) {
        await route.fulfill({
          status: 200,
          body: JSON.stringify({ scriptId: 'id' }),
        })
      } else if (url.includes('/content')) {
        await route.fulfill({ status: 200, body: '{}' })
      } else {
        await route.continue()
      }
    })

    await signIn(page)
    await page
      .locator('#script-list input[value="gmail-to-drive-by-labels"]')
      .click()
    await page.locator('#btn-deploy').click()
    await page.waitForSelector('.status-ok')

    expect(
      capturedUrls.some((u) => u.includes('gmail-to-drive-by-labels/code.gs'))
    ).toBe(true)
    expect(
      capturedUrls.some((u) => u.includes('gmail-to-drive-by-labels/config.gs'))
    ).toBe(true)
  })

  test('handleDeploy includes appsscript manifest in content upload', async ({
    page,
  }) => {
    let uploadBody = null
    await page.route('https://raw.githubusercontent.com/**', async (route) => {
      await route.fulfill({ status: 200, body: '// code' })
    })
    await page.route('https://script.googleapis.com/**', async (route) => {
      const url = route.request().url()
      const method = route.request().method()
      if (method === 'POST' && url.endsWith('/projects')) {
        await route.fulfill({
          status: 200,
          body: JSON.stringify({ scriptId: 'id' }),
        })
      } else if (method === 'PUT' && url.includes('/content')) {
        uploadBody = JSON.parse(route.request().postData())
        await route.fulfill({ status: 200, body: '{}' })
      } else {
        await route.continue()
      }
    })

    await signIn(page)
    await page
      .locator('#script-list input[value="gmail-to-drive-by-labels"]')
      .click()
    await page.locator('#btn-deploy').click()
    await page.waitForSelector('.status-ok')

    expect(uploadBody).not.toBeNull()
    const manifest = uploadBody.files.find((f) => f.name === 'appsscript')
    expect(manifest).toBeDefined()
    expect(manifest.type).toBe('JSON')
    const parsed = JSON.parse(manifest.source)
    expect(parsed).toHaveProperty('runtimeVersion', 'V8')
    expect(parsed).toHaveProperty('executionApi', { access: 'MYSELF' })
    expect(parsed).not.toHaveProperty('oauthScopes')
  })

  test('handleDeploy includes setup.gs with hourly trigger in content upload', async ({
    page,
  }) => {
    let uploadBody = null
    await page.route('https://raw.githubusercontent.com/**', async (route) => {
      await route.fulfill({ status: 200, body: '// code' })
    })
    await page.route('https://script.googleapis.com/**', async (route) => {
      const url = route.request().url()
      const method = route.request().method()
      if (method === 'POST' && url.endsWith('/projects')) {
        await route.fulfill({
          status: 200,
          body: JSON.stringify({ scriptId: 'id' }),
        })
      } else if (method === 'PUT' && url.includes('/content')) {
        uploadBody = JSON.parse(route.request().postData())
        await route.fulfill({ status: 200, body: '{}' })
      } else {
        await route.continue()
      }
    })

    await signIn(page)
    await page
      .locator('#script-list input[value="gmail-to-drive-by-labels"]')
      .click()
    await page.locator('#btn-deploy').click()
    await page.waitForSelector('.status-ok')

    expect(uploadBody).not.toBeNull()
    const setupFile = uploadBody.files.find((f) => f.name === 'setup')
    expect(setupFile).toBeDefined()
    expect(setupFile.type).toBe('SERVER_JS')
    expect(setupFile.source).toContain('storeEmailsAndAttachments')
    expect(setupFile.source).toContain('ScriptApp.newTrigger')
    expect(setupFile.source).toContain('everyHours(1)')
  })

  test('handleDeploy includes correct trigger function for calendar-to-sheets', async ({
    page,
  }) => {
    let uploadBody = null
    await page.route('https://raw.githubusercontent.com/**', async (route) => {
      await route.fulfill({ status: 200, body: '// code' })
    })
    await page.route('https://script.googleapis.com/**', async (route) => {
      const url = route.request().url()
      const method = route.request().method()
      if (method === 'POST' && url.endsWith('/projects')) {
        await route.fulfill({
          status: 200,
          body: JSON.stringify({ scriptId: 'id' }),
        })
      } else if (method === 'PUT' && url.includes('/content')) {
        uploadBody = JSON.parse(route.request().postData())
        await route.fulfill({ status: 200, body: '{}' })
      } else {
        await route.continue()
      }
    })

    await signIn(page)
    await page.locator('#script-list input[value="calendar-to-sheets"]').click()
    await page.locator('#btn-deploy').click()
    await page.waitForSelector('.status-ok')

    const setupFile = uploadBody.files.find((f) => f.name === 'setup')
    expect(setupFile).toBeDefined()
    expect(setupFile.type).toBe('SERVER_JS')
    expect(setupFile.source).toContain('syncAllCalendarsToSheetsGAS')
    expect(setupFile.source).toContain('ScriptApp.newTrigger')
    expect(setupFile.source).toContain('everyHours(1)')
  })

  test('handleDeploy success shows configure instructions in status', async ({
    page,
  }) => {
    await mockSuccessfulDeploy(page)
    await signIn(page)
    await page
      .locator('#script-list input[value="gmail-to-drive-by-labels"]')
      .click()
    await page.locator('#btn-deploy').click()
    await expect(page.locator('.status-ok')).toContainText(
      'configure each script'
    )
  })

  test('handleDeploy reuses stored project on redeploy without creating a new one', async ({
    page,
  }) => {
    // Pre-seed localStorage with an existing deployment
    await page.evaluate(() => {
      localStorage.setItem(
        'gas_copilot_deployed',
        JSON.stringify({
          'gmail-to-drive-by-labels\nPetry-Projects – Gmail to Drive By Labels':
            'existing-script-id',
        })
      )
    })

    let projectCreated = false
    let verifiedExisting = false

    await page.route('https://raw.githubusercontent.com/**', async (route) => {
      await route.fulfill({ status: 200, body: '// code' })
    })
    await page.route('https://script.googleapis.com/**', async (route) => {
      const url = route.request().url()
      const method = route.request().method()
      if (method === 'GET' && url.includes('/projects/existing-script-id')) {
        verifiedExisting = true
        await route.fulfill({
          status: 200,
          body: JSON.stringify({
            scriptId: 'existing-script-id',
            title: 'Petry-Projects – Gmail to Drive By Labels',
          }),
        })
      } else if (method === 'POST' && url.endsWith('/projects')) {
        projectCreated = true
        await route.fulfill({
          status: 200,
          body: JSON.stringify({ scriptId: 'new-id' }),
        })
      } else if (method === 'PUT' && url.includes('/content')) {
        await route.fulfill({ status: 200, body: '{}' })
      } else {
        await route.continue()
      }
    })

    await signIn(page)
    await page
      .locator('#script-list input[value="gmail-to-drive-by-labels"]')
      .click()
    await page.locator('#btn-deploy').click()
    await page.waitForSelector('.status-ok')

    expect(verifiedExisting).toBe(true)
    expect(projectCreated).toBe(false)
    await expect(page.locator('#step3-card .result-link')).toHaveAttribute(
      'href',
      'https://script.google.com/d/existing-script-id/edit'
    )
  })

  test('handleDeploy creates new project if stored project was deleted', async ({
    page,
  }) => {
    await page.evaluate(() => {
      localStorage.setItem(
        'gas_copilot_deployed',
        JSON.stringify({
          'gmail-to-drive-by-labels\nPetry-Projects – Gmail to Drive By Labels':
            'deleted-script-id',
        })
      )
    })

    let projectCreated = false

    await page.route('https://raw.githubusercontent.com/**', async (route) => {
      await route.fulfill({ status: 200, body: '// code' })
    })
    await page.route('https://script.googleapis.com/**', async (route) => {
      const url = route.request().url()
      const method = route.request().method()
      if (method === 'GET' && url.includes('/projects/deleted-script-id')) {
        // Simulate project not found
        await route.fulfill({
          status: 404,
          body: JSON.stringify({ error: { message: 'Not found' } }),
        })
      } else if (method === 'POST' && url.endsWith('/projects')) {
        projectCreated = true
        await route.fulfill({
          status: 200,
          body: JSON.stringify({ scriptId: 'new-fallback-id' }),
        })
      } else if (method === 'PUT' && url.includes('/content')) {
        await route.fulfill({ status: 200, body: '{}' })
      } else {
        await route.continue()
      }
    })

    await signIn(page)
    await page
      .locator('#script-list input[value="gmail-to-drive-by-labels"]')
      .click()
    await page.locator('#btn-deploy').click()
    await page.waitForSelector('.status-ok')

    expect(projectCreated).toBe(true)
    await expect(page.locator('#step3-card .result-link')).toHaveAttribute(
      'href',
      'https://script.google.com/d/new-fallback-id/edit'
    )
  })

  // ── handleDeploy – failure flows ────────────────────────────────────────────

  test('handleDeploy shows error when GitHub source file fetch fails', async ({
    page,
  }) => {
    await page.route('https://raw.githubusercontent.com/**', async (route) => {
      await route.fulfill({ status: 404, body: 'Not Found' })
    })
    await signIn(page)
    await page
      .locator('#script-list input[value="gmail-to-drive-by-labels"]')
      .click()
    await page.locator('#btn-deploy').click()
    await expect(page.locator('.status-error')).toContainText(
      'Deployment failed'
    )
  })

  test('handleDeploy shows error when project creation fails with API error message', async ({
    page,
  }) => {
    await page.route('https://raw.githubusercontent.com/**', async (route) => {
      await route.fulfill({ status: 200, body: '// code' })
    })
    await page.route('https://script.googleapis.com/**', async (route) => {
      await route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { message: 'The caller does not have permission' },
        }),
      })
    })
    await signIn(page)
    await page
      .locator('#script-list input[value="gmail-to-drive-by-labels"]')
      .click()
    await page.locator('#btn-deploy').click()
    await expect(page.locator('.status-error')).toContainText(
      'The caller does not have permission'
    )
    // Copyable error detail block is shown
    await expect(
      page.locator('.status-error details .error-detail')
    ).toContainText('The caller does not have permission')
    await expect(page.locator('.status-error .copy-btn')).toBeAttached()
  })

  test('handleDeploy shows enable-API link when Apps Script API is not enabled', async ({
    page,
  }) => {
    await page.route('https://raw.githubusercontent.com/**', async (route) => {
      await route.fulfill({ status: 200, body: '// code' })
    })
    await page.route('https://script.googleapis.com/**', async (route) => {
      await route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({
          error: {
            message:
              'User has not enabled the Apps Script API. Enable it by visiting https://script.google.com/home/usersettings then retry.',
          },
        }),
      })
    })
    await signIn(page)
    await page
      .locator('#script-list input[value="gmail-to-drive-by-labels"]')
      .click()
    await page.locator('#btn-deploy').click()
    await expect(page.locator('.status-error')).toContainText('Apps Script API')
    await expect(
      page.locator(
        '.status-error a[href="https://script.google.com/home/usersettings"]'
      )
    ).toBeVisible()
  })

  test('apiFetch shows HTTP status code when error body is not valid JSON', async ({
    page,
  }) => {
    await page.route('https://raw.githubusercontent.com/**', async (route) => {
      await route.fulfill({ status: 200, body: '// code' })
    })
    await page.route('https://script.googleapis.com/**', async (route) => {
      await route.fulfill({
        status: 500,
        contentType: 'text/plain',
        body: 'Internal Server Error',
      })
    })
    await signIn(page)
    await page
      .locator('#script-list input[value="gmail-to-drive-by-labels"]')
      .click()
    await page.locator('#btn-deploy').click()
    await expect(page.locator('.status-error')).toContainText('HTTP 500')
  })

  test('handleDeploy shows error when content upload fails', async ({
    page,
  }) => {
    await page.route('https://raw.githubusercontent.com/**', async (route) => {
      await route.fulfill({ status: 200, body: '// code' })
    })
    await page.route('https://script.googleapis.com/**', async (route) => {
      const url = route.request().url()
      const method = route.request().method()
      if (method === 'POST' && url.endsWith('/projects')) {
        await route.fulfill({
          status: 200,
          body: JSON.stringify({ scriptId: 'new-id' }),
        })
      } else if (method === 'PUT' && url.includes('/content')) {
        await route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({
            error: { message: 'Invalid content payload' },
          }),
        })
      } else {
        await route.continue()
      }
    })
    await signIn(page)
    await page
      .locator('#script-list input[value="gmail-to-drive-by-labels"]')
      .click()
    await page.locator('#btn-deploy').click()
    await expect(page.locator('.status-error')).toContainText(
      'Invalid content payload'
    )
  })

  test('deploy button resets to "Deploy to my account" after failed deploy', async ({
    page,
  }) => {
    await page.route('https://raw.githubusercontent.com/**', async (route) => {
      await route.fulfill({ status: 404, body: 'Not Found' })
    })
    await signIn(page)
    await page
      .locator('#script-list input[value="gmail-to-drive-by-labels"]')
      .click()
    await page.locator('#btn-deploy').click()
    await page.waitForSelector('.status-error')
    await expect(page.locator('#btn-deploy')).toHaveText('Deploy to my account')
  })

  // ── escapeHtml ──────────────────────────────────────────────────────────────

  test('escapeHtml escapes HTML entities in error messages', async ({
    page,
  }) => {
    await page.route('https://raw.githubusercontent.com/**', async (route) => {
      await route.fulfill({ status: 200, body: '// code' })
    })
    await page.route('https://script.googleapis.com/**', async (route) => {
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { message: '<b>Quota</b> exceeded & "limit"' },
        }),
      })
    })
    await signIn(page)
    await page
      .locator('#script-list input[value="gmail-to-drive-by-labels"]')
      .click()
    await page.locator('#btn-deploy').click()
    await page.waitForSelector('.status-error')

    // textContent shows the decoded literal characters
    const text = await page.locator('#status-msg').textContent()
    expect(text).toContain('<b>Quota</b> exceeded & "limit"')

    // innerHTML must use HTML entities — no injected raw tags
    const html = await page.locator('#status-msg').innerHTML()
    expect(html).toContain('&lt;b&gt;')
    expect(html).not.toContain('<b>Quota</b>')
  })

  test('Copy error copies the stack trace verbatim and never parses it as HTML (#595)', async ({
    page,
  }) => {
    const stack =
      'Error: bad <tag> at foo (<anonymous>)\n' +
      '    at List<T>.get (<anonymous>)\n' +
      '<script>window.__pwned=1</script>' +
      '<img src=x onerror="window.__pwned=1">'

    // Stub the clipboard so the test can read what was written.
    await page.evaluate(() => {
      window.__copied = []
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: (text) => {
            window.__copied.push(text)
            return Promise.resolve()
          },
        },
      })
    })

    await page.evaluate((errStack) => {
      const err = new Error('bad <tag>')
      err.stack = errStack
      showStatus('error', buildDeployErrorHtml(err))
    }, stack)

    await page.locator('.status-error details summary').click()
    await page.locator('.status-error .copy-btn').click()
    await expect.poll(() => page.evaluate(() => window.__copied.length)).toBe(1)

    expect(await page.evaluate(() => window.__copied[0])).toBe(stack)

    // Control: a detached <img> with this payload does fire onerror here, so a
    // re-parse would have set __pwned before __control is set.
    await page.evaluate(() => {
      const d = document.createElement('div')
      d.innerHTML = '<img src=x onerror="window.__control=1">'
    })
    await page.waitForFunction(() => window.__control === 1)
    expect(await page.evaluate(() => window.__pwned)).toBeUndefined()
  })

  // ── showStatus type classes ─────────────────────────────────────────────────

  test('error sign-in response shows status-error class', async ({ page }) => {
    await page.evaluate(() => {
      window.__authMode = 'failure'
    })
    await page.locator('#btn-signin').click()
    await expect(page.locator('#status-msg.status-error')).toBeVisible()
  })

  test('status-info banner meets WCAG AA contrast (>= 4.5:1)', async ({
    page,
  }) => {
    const contrast = await page.evaluate(() => {
      const el = document.createElement('div')
      el.className = 'status-msg status-info'
      el.textContent = 'sample'
      document.body.appendChild(el)
      const cs = getComputedStyle(el)
      const fg = cs.color
      const bg = cs.backgroundColor
      el.remove()

      const channels = (s) =>
        ((s || '').match(/\d+(\.\d+)?/g) || []).map(Number)
      const luminance = ([r, g, b]) => {
        const lin = [r, g, b].map((v) => {
          v /= 255
          return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
        })
        return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]
      }
      const l1 = luminance(channels(fg))
      const l2 = luminance(channels(bg))
      const lighter = Math.max(l1, l2)
      const darker = Math.min(l1, l2)
      return (lighter + 0.05) / (darker + 0.05)
    })
    expect(contrast).toBeGreaterThanOrEqual(4.5)
  })

  test('successful deploy shows status-ok class', async ({ page }) => {
    await mockSuccessfulDeploy(page)
    await signIn(page)
    await page
      .locator('#script-list input[value="gmail-to-drive-by-labels"]')
      .click()
    await page.locator('#btn-deploy').click()
    await expect(page.locator('#status-msg.status-ok')).toBeVisible()
  })

  test('status area is hidden on load', async ({ page }) => {
    await expect(page.locator('#status-area')).toBeHidden()
  })

  test('status area becomes visible after an action', async ({ page }) => {
    await page.evaluate(() => {
      window.__authMode = 'failure'
    })
    await page.locator('#btn-signin').click()
    await expect(page.locator('#status-area')).toBeVisible()
  })

  // ── Multi-select (checkboxes) ───────────────────────────────────────────────

  test('script list uses checkboxes not radio buttons', async ({ page }) => {
    await expect(
      page.locator('#script-list input[type="checkbox"]')
    ).toHaveCount(3)
    await expect(page.locator('#script-list input[type="radio"]')).toHaveCount(
      0
    )
  })

  test('deploy button enables after sign-in with multiple scripts checked', async ({
    page,
  }) => {
    await signIn(page)
    await page
      .locator('#script-list input[value="gmail-to-drive-by-labels"]')
      .click()
    await page.locator('#script-list input[value="calendar-to-sheets"]').click()
    await expect(page.locator('#btn-deploy')).toBeEnabled()
  })

  test('deploy button re-disables when all scripts are unchecked', async ({
    page,
  }) => {
    await signIn(page)
    await page
      .locator('#script-list input[value="gmail-to-drive-by-labels"]')
      .click()
    await expect(page.locator('#btn-deploy')).toBeEnabled()
    // Uncheck the only selected script
    await page
      .locator('#script-list input[value="gmail-to-drive-by-labels"]')
      .click()
    await expect(page.locator('#btn-deploy')).toBeDisabled()
  })

  test('deploy button stays enabled when one of two checked scripts is unchecked', async ({
    page,
  }) => {
    await signIn(page)
    await page
      .locator('#script-list input[value="gmail-to-drive-by-labels"]')
      .click()
    await page.locator('#script-list input[value="calendar-to-sheets"]').click()
    await expect(page.locator('#btn-deploy')).toBeEnabled()
    // Uncheck one — should remain enabled because one is still checked
    await page.locator('#script-list input[value="calendar-to-sheets"]').click()
    await expect(page.locator('#btn-deploy')).toBeEnabled()
  })

  test('deploying multiple scripts creates a project for each', async ({
    page,
  }) => {
    let createProjectCallCount = 0
    await page.route('https://raw.githubusercontent.com/**', async (route) => {
      await route.fulfill({ status: 200, body: '// code' })
    })
    await page.route('https://script.googleapis.com/**', async (route) => {
      const url = route.request().url()
      const method = route.request().method()
      if (method === 'POST' && url.endsWith('/projects')) {
        createProjectCallCount++
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            scriptId: `mock-id-${createProjectCallCount}`,
          }),
        })
      } else if (method === 'PUT' && url.includes('/content')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({}),
        })
      } else {
        await route.continue()
      }
    })

    await signIn(page)
    await page
      .locator('#script-list input[value="gmail-to-drive-by-labels"]')
      .click()
    await page.locator('#script-list input[value="calendar-to-sheets"]').click()
    await page.locator('#btn-deploy').click()
    await page.waitForSelector('.status-ok')

    // Two POST /projects calls — one per script
    expect(createProjectCallCount).toBe(2)
  })

  test('deploying multiple scripts shows a result link for each in Step 3', async ({
    page,
  }) => {
    let projectIdCounter = 0
    await page.route('https://raw.githubusercontent.com/**', async (route) => {
      await route.fulfill({ status: 200, body: '// code' })
    })
    await page.route('https://script.googleapis.com/**', async (route) => {
      const url = route.request().url()
      const method = route.request().method()
      if (method === 'POST' && url.endsWith('/projects')) {
        projectIdCounter++
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ scriptId: `project-${projectIdCounter}` }),
        })
      } else if (method === 'PUT' && url.includes('/content')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({}),
        })
      } else {
        await route.continue()
      }
    })

    await signIn(page)
    await page
      .locator('#script-list input[value="gmail-to-drive-by-labels"]')
      .click()
    await page.locator('#script-list input[value="calendar-to-sheets"]').click()
    await page.locator('#btn-deploy').click()
    await page.waitForSelector('.status-ok')

    // Links in Step 3 cards
    const step3Links = page.locator('#step3-card .result-link')
    await expect(step3Links).toHaveCount(2)
    await expect(step3Links.nth(0)).toHaveAttribute(
      'href',
      'https://script.google.com/d/project-1/edit'
    )
    await expect(step3Links.nth(1)).toHaveAttribute(
      'href',
      'https://script.google.com/d/project-2/edit'
    )
  })

  test('multi-script deploy uses Petry-Projects prefix for each project title', async ({
    page,
  }) => {
    const capturedTitles = []
    await page.route('https://raw.githubusercontent.com/**', async (route) => {
      await route.fulfill({ status: 200, body: '// code' })
    })
    await page.route('https://script.googleapis.com/**', async (route) => {
      const url = route.request().url()
      const method = route.request().method()
      if (method === 'POST' && url.endsWith('/projects')) {
        const body = JSON.parse(route.request().postData() || '{}')
        capturedTitles.push(body.title)
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ scriptId: 'x' }),
        })
      } else if (method === 'PUT' && url.includes('/content')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({}),
        })
      } else {
        await route.continue()
      }
    })

    await signIn(page)
    await page
      .locator('#script-list input[value="gmail-to-drive-by-labels"]')
      .click()
    await page.locator('#script-list input[value="calendar-to-sheets"]').click()
    await page.locator('#btn-deploy').click()
    await page.waitForSelector('.status-ok')

    expect(capturedTitles).toContain(
      'Petry-Projects – Gmail to Drive By Labels'
    )
    expect(capturedTitles).toContain('Petry-Projects – Calendar to Sheets')
  })

  // ── Step 3 – Post-deploy configuration ──────────────────────────────────────

  test('confirmSetupDone replaces setup section with trigger activated message', async ({
    page,
  }) => {
    await mockSuccessfulDeploy(page)
    await signIn(page)
    await page
      .locator('#script-list input[value="gmail-to-drive-by-labels"]')
      .click()
    await page.locator('#btn-deploy').click()
    await page.waitForSelector('.status-ok')

    // Click Configure to expand the form
    await page.locator('#btn-configure-mock-project-id-abc').click()

    // Click Save Configuration
    await page.locator('#config-form-mock-project-id-abc .btn-primary').click()

    // Wait for setup section to become visible
    await expect(
      page.locator('#setup-section-mock-project-id-abc')
    ).toBeVisible()

    // Click the "Done — I ran setup()" button
    await page
      .locator('#setup-section-mock-project-id-abc button:has-text("Done")')
      .click()

    // Verify it now shows "Trigger previously activated"
    await expect(
      page.locator('#setup-section-mock-project-id-abc')
    ).toContainText('Trigger previously activated')
  })

  test('handleDeploy shows trigger already activated when setup previously confirmed', async ({
    page,
  }) => {
    // Pre-seed setup confirmation in localStorage so the CTA is skipped
    await mockSuccessfulDeploy(page)
    await page.evaluate(() => {
      localStorage.setItem(
        'gas_copilot_setup_done',
        JSON.stringify({ 'mock-project-id-abc': true })
      )
    })
    await signIn(page)
    await page
      .locator('#script-list input[value="gmail-to-drive-by-labels"]')
      .click()
    await page.locator('#btn-deploy').click()
    await page.waitForSelector('.status-ok')

    // Click Configure to open form, then Save to trigger showSetupCta
    await page.locator('#btn-configure-mock-project-id-abc').click()
    await page.locator('#config-form-mock-project-id-abc .btn-primary').click()

    // Since setup was already confirmed, it should show "previously activated"
    await expect(
      page.locator('#setup-section-mock-project-id-abc')
    ).toContainText('Trigger previously activated')
  })

  test('single-script deploy uses Petry-Projects prefix for project title', async ({
    page,
  }) => {
    let capturedTitle = null
    await page.route('https://raw.githubusercontent.com/**', async (route) => {
      await route.fulfill({ status: 200, body: '// code' })
    })
    await page.route('https://script.googleapis.com/**', async (route) => {
      const url = route.request().url()
      const method = route.request().method()
      if (method === 'POST' && url.endsWith('/projects')) {
        const body = JSON.parse(route.request().postData() || '{}')
        capturedTitle = body.title
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ scriptId: 'x' }),
        })
      } else if (method === 'PUT' && url.includes('/content')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({}),
        })
      } else {
        await route.continue()
      }
    })

    await signIn(page)
    await page
      .locator('#script-list input[value="gmail-to-drive-by-labels"]')
      .click()
    await page.locator('#btn-deploy').click()
    await page.waitForSelector('.status-ok')

    expect(capturedTitle).toBe('Petry-Projects – Gmail to Drive By Labels')
  })

  test('briefing doc deploy success shows deployed status', async ({
    page,
  }) => {
    await mockSuccessfulDeploy(page)
    await signIn(page)
    await page
      .locator('#script-list input[value="calendar-to-briefing-doc"]')
      .click()
    await page.locator('#btn-deploy').click()
    await expect(page.locator('.status-ok')).toContainText('deployed')
  })
})
