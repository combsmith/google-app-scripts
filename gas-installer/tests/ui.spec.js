// @ts-check
'use strict'

/**
 * Playwright end-to-end tests for gas-installer/Index.html.
 *
 * The page runs inside the Google Apps Script runtime in production, so
 * `google.script.run` is injected via `addInitScript` before the page's
 * own scripts execute. Tests control the deployment outcome by setting
 * `window.__deployMode` before triggering the button click.
 */

const { test, expect } = require('@playwright/test')
const path = require('path')

const PAGE_URL = `file://${path.resolve(__dirname, '..', 'Index.html')}`

// ── GAS runtime mock ─────────────────────────────────────────────────────────

/**
 * Self-contained function injected into the browser page context.
 *
 * Modes (controlled via window.__deployMode):
 *   'success'              – calls withSuccessHandler with a mock script ID
 *   'failure-with-message' – calls withFailureHandler with { message: '<HTML>' }
 *   'failure-string'       – calls withFailureHandler with a plain string
 *   'pending'              – stores handlers; resolved via window.__triggerSuccess/Failure
 */
function injectGasRuntimeMock() {
  window.__deployMode = 'success'
  window.__lastDeployArgs = null

  window.google = {
    script: {
      run: {
        _success: null,
        _failure: null,
        withSuccessHandler(fn) {
          this._success = fn
          return this
        },
        withFailureHandler(fn) {
          this._failure = fn
          return this
        },
        deployScript(projectName, scriptFolderName) {
          const run = window.google.script.run
          window.__lastDeployArgs = { projectName, scriptFolderName }

          if (window.__deployMode === 'success') {
            setTimeout(
              () => run._success && run._success('mock-script-id-123'),
              20
            )
          } else if (window.__deployMode === 'failure-with-message') {
            setTimeout(
              () =>
                run._failure &&
                run._failure({ message: '<script>alert(1)</script>' }),
              20
            )
          } else if (window.__deployMode === 'failure-string') {
            setTimeout(
              () => run._failure && run._failure('plain string error'),
              20
            )
          } else if (window.__deployMode === 'pending') {
            // Resolved manually from the test via page.evaluate()
            window.__triggerSuccess = (id) => run._success && run._success(id)
            window.__triggerFailure = (err) => run._failure && run._failure(err)
          }
        },
      },
    },
  }
}

// ── Test suite ───────────────────────────────────────────────────────────────

test.describe('gas-installer Index.html', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(injectGasRuntimeMock)
    await page.goto(PAGE_URL)
  })

  // ── Page structure ──────────────────────────────────────────────────────────

  test('has correct page title', async ({ page }) => {
    await expect(page).toHaveTitle('OrganizerBot Installer')
  })

  test('renders heading and subtitle', async ({ page }) => {
    await expect(page.locator('h1')).toContainText('OrganizerBot Installer')
    await expect(page.locator('header p')).toContainText(
      'Select a script, name your project'
    )
  })

  test('renders step badges labelled 1 and 2', async ({ page }) => {
    const badges = page.locator('.step-badge')
    await expect(badges).toHaveCount(2)
    await expect(badges.nth(0)).toHaveText('1')
    await expect(badges.nth(1)).toHaveText('2')
  })

  test('renders both script option labels', async ({ page }) => {
    await expect(page.locator('label[for="script-gmail"] strong')).toHaveText(
      'Gmail to Drive By Labels'
    )
    await expect(
      page.locator('label[for="script-calendar"] strong')
    ).toHaveText('Calendar to Sheets')
  })

  test('both radio buttons are present and unchecked by default', async ({
    page,
  }) => {
    await expect(page.locator('#script-gmail')).toBeVisible()
    await expect(page.locator('#script-calendar')).toBeVisible()
    await expect(page.locator('#script-gmail')).not.toBeChecked()
    await expect(page.locator('#script-calendar')).not.toBeChecked()
  })

  test('renders project title input with placeholder', async ({ page }) => {
    const input = page.locator('#project-title')
    await expect(input).toBeVisible()
    await expect(input).toHaveAttribute('placeholder', 'My Gmail Archiver')
  })

  test('renders deploy button with correct label', async ({ page }) => {
    await expect(page.locator('#btn-deploy')).toBeVisible()
    await expect(page.locator('#btn-deploy')).toHaveText('Deploy to my account')
  })

  // ── updateDeployButton ──────────────────────────────────────────────────────

  test('deploy button is disabled on load', async ({ page }) => {
    await expect(page.locator('#btn-deploy')).toBeDisabled()
  })

  test('deploy button remains disabled with only script selected', async ({
    page,
  }) => {
    await page.locator('#script-gmail').click()
    await expect(page.locator('#btn-deploy')).toBeDisabled()
  })

  test('deploy button remains disabled with only title filled', async ({
    page,
  }) => {
    await page.fill('#project-title', 'My Project')
    await expect(page.locator('#btn-deploy')).toBeDisabled()
  })

  test('deploy button enables when gmail script selected and title provided', async ({
    page,
  }) => {
    await page.locator('#script-gmail').click()
    await page.fill('#project-title', 'My Gmail Project')
    await expect(page.locator('#btn-deploy')).toBeEnabled()
  })

  test('deploy button enables when calendar script selected and title provided', async ({
    page,
  }) => {
    await page.locator('#script-calendar').click()
    await page.fill('#project-title', 'My Calendar Project')
    await expect(page.locator('#btn-deploy')).toBeEnabled()
  })

  test('deploy button re-disables when title is cleared after enabling', async ({
    page,
  }) => {
    await page.locator('#script-gmail').click()
    await page.fill('#project-title', 'My Project')
    await expect(page.locator('#btn-deploy')).toBeEnabled()
    await page.fill('#project-title', '')
    await expect(page.locator('#btn-deploy')).toBeDisabled()
  })

  test('deploy button re-disables when title is whitespace only', async ({
    page,
  }) => {
    await page.locator('#script-gmail').click()
    await page.fill('#project-title', '   ')
    await expect(page.locator('#btn-deploy')).toBeDisabled()
  })

  // ── showStatus / status area ────────────────────────────────────────────────

  test('status area is hidden on load', async ({ page }) => {
    await expect(page.locator('#status-area')).toBeHidden()
  })

  test('showStatus info applies status-info class', async ({ page }) => {
    // 'pending' deploy keeps the info banner visible until resolved
    await page.evaluate(() => {
      window.__deployMode = 'pending'
    })
    await page.locator('#script-gmail').click()
    await page.fill('#project-title', 'My Project')
    await page.locator('#btn-deploy').click()
    await expect(page.locator('#status-msg.status-info')).toBeVisible()
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

  test('showStatus ok applies status-ok class', async ({ page }) => {
    await page.locator('#script-gmail').click()
    await page.fill('#project-title', 'My Project')
    await page.locator('#btn-deploy').click()
    await expect(page.locator('#status-msg.status-ok')).toBeVisible()
  })

  test('showStatus error applies status-error class', async ({ page }) => {
    await page.evaluate(() => {
      window.__deployMode = 'failure-with-message'
    })
    await page.locator('#script-gmail').click()
    await page.fill('#project-title', 'My Project')
    await page.locator('#btn-deploy').click()
    await expect(page.locator('#status-msg.status-error')).toBeVisible()
  })

  test('status area becomes visible after deploy', async ({ page }) => {
    await page.locator('#script-gmail').click()
    await page.fill('#project-title', 'My Project')
    await page.locator('#btn-deploy').click()
    await page.waitForSelector('.status-ok')
    await expect(page.locator('#status-area')).toBeVisible()
  })

  // ── handleDeploy – deploying state ─────────────────────────────────────────

  test('deploy button is disabled and shows spinner while deploy is pending', async ({
    page,
  }) => {
    await page.evaluate(() => {
      window.__deployMode = 'pending'
    })
    await page.locator('#script-gmail').click()
    await page.fill('#project-title', 'My Project')
    await page.locator('#btn-deploy').click()

    // Button must be disabled and show a spinner while waiting for response
    await expect(page.locator('#btn-deploy')).toBeDisabled()
    await expect(page.locator('#btn-deploy .spinner')).toBeVisible()

    // Info status visible during deployment
    await expect(page.locator('#status-area')).toBeVisible()
    await expect(page.locator('.status-info')).toBeVisible()
  })

  test('handleDeploy returns early and shows nothing when no script selected', async ({
    page,
  }) => {
    // Fill title but leave no radio selected; call handleDeploy directly
    await page.fill('#project-title', 'My Project')
    await page.evaluate(() => window.handleDeploy())
    await expect(page.locator('#status-area')).toBeHidden()
  })

  test('handleDeploy calls deployScript with correct project name and folder', async ({
    page,
  }) => {
    await page.locator('#script-calendar').click()
    await page.fill('#project-title', 'My Calendar Sync')
    await page.locator('#btn-deploy').click()
    await page.waitForSelector('.status-ok')

    const args = await page.evaluate(() => window.__lastDeployArgs)
    expect(args.projectName).toBe('My Calendar Sync')
    expect(args.scriptFolderName).toBe('calendar-to-sheets')
  })

  // ── onDeploySuccess ─────────────────────────────────────────────────────────

  test('onDeploySuccess shows success status', async ({ page }) => {
    await page.locator('#script-gmail').click()
    await page.fill('#project-title', 'Gmail Archiver')
    await page.locator('#btn-deploy').click()
    await expect(page.locator('.status-ok')).toBeVisible()
    await expect(page.locator('.status-ok')).toContainText(
      'Deployed successfully'
    )
  })

  test('onDeploySuccess shows link pointing to correct Apps Script URL', async ({
    page,
  }) => {
    await page.locator('#script-gmail').click()
    await page.fill('#project-title', 'Gmail Archiver')
    await page.locator('#btn-deploy').click()
    await expect(page.locator('.result-link')).toHaveAttribute(
      'href',
      'https://script.google.com/d/mock-script-id-123/edit'
    )
    await expect(page.locator('.result-link')).toHaveAttribute(
      'target',
      '_blank'
    )
  })

  // ── resetButton ─────────────────────────────────────────────────────────────

  test('deploy button text resets to "Deploy to my account" after success', async ({
    page,
  }) => {
    await page.locator('#script-gmail').click()
    await page.fill('#project-title', 'Gmail Archiver')
    await page.locator('#btn-deploy').click()
    await page.waitForSelector('.status-ok')
    await expect(page.locator('#btn-deploy')).toHaveText('Deploy to my account')
  })

  test('deploy button re-enables after successful deploy', async ({ page }) => {
    await page.locator('#script-gmail').click()
    await page.fill('#project-title', 'Gmail Archiver')
    await page.locator('#btn-deploy').click()
    await page.waitForSelector('.status-ok')
    await expect(page.locator('#btn-deploy')).toBeEnabled()
  })

  test('deploy button text resets to "Deploy to my account" after failure', async ({
    page,
  }) => {
    await page.evaluate(() => {
      window.__deployMode = 'failure-with-message'
    })
    await page.locator('#script-gmail').click()
    await page.fill('#project-title', 'Gmail Archiver')
    await page.locator('#btn-deploy').click()
    await page.waitForSelector('.status-error')
    await expect(page.locator('#btn-deploy')).toHaveText('Deploy to my account')
  })

  test('deploy button re-enables after failed deploy', async ({ page }) => {
    await page.evaluate(() => {
      window.__deployMode = 'failure-with-message'
    })
    await page.locator('#script-gmail').click()
    await page.fill('#project-title', 'Gmail Archiver')
    await page.locator('#btn-deploy').click()
    await page.waitForSelector('.status-error')
    await expect(page.locator('#btn-deploy')).toBeEnabled()
  })

  // ── onDeployFailure ─────────────────────────────────────────────────────────

  test('onDeployFailure shows error status with err.message', async ({
    page,
  }) => {
    await page.evaluate(() => {
      window.__deployMode = 'failure-with-message'
    })
    await page.locator('#script-gmail').click()
    await page.fill('#project-title', 'Gmail Archiver')
    await page.locator('#btn-deploy').click()
    await expect(page.locator('.status-error')).toBeVisible()
    await expect(page.locator('.status-error')).toContainText(
      'Deployment failed'
    )
  })

  test('onDeployFailure shows error status with plain string error', async ({
    page,
  }) => {
    await page.evaluate(() => {
      window.__deployMode = 'failure-string'
    })
    await page.locator('#script-gmail').click()
    await page.fill('#project-title', 'Gmail Archiver')
    await page.locator('#btn-deploy').click()
    await expect(page.locator('.status-error')).toContainText(
      'plain string error'
    )
  })

  // ── escapeHtml ──────────────────────────────────────────────────────────────

  test('escapeHtml escapes HTML entities in error message', async ({
    page,
  }) => {
    await page.evaluate(() => {
      window.__deployMode = 'failure-with-message'
    })
    await page.locator('#script-gmail').click()
    await page.fill('#project-title', 'Gmail Archiver')
    await page.locator('#btn-deploy').click()
    await page.waitForSelector('.status-error')

    // textContent exposes decoded text — literal angle brackets must appear
    const text = await page.locator('#status-msg').textContent()
    expect(text).toContain('<script>alert(1)</script>')

    // innerHTML must use HTML entities so no actual <script> tag is injected
    const html = await page.locator('#status-msg').innerHTML()
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>alert(1)</script>')
  })
})
