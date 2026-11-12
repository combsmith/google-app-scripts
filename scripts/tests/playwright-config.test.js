const fs = require('fs')
const path = require('path')

jest.mock('@playwright/test', () => ({
  defineConfig: (cfg) => cfg,
}))

const configPath = path.join(__dirname, '..', '..', 'playwright.config.js')
const workflowPath = path.join(
  __dirname,
  '..',
  '..',
  '.github',
  'workflows',
  'playwright-tests.yml'
)

function loadPlaywrightConfig(ciValue) {
  const prevCi = process.env.CI
  try {
    if (ciValue === undefined) {
      delete process.env.CI
    } else {
      process.env.CI = ciValue
    }
    jest.resetModules()
    return require(configPath)
  } finally {
    if (prevCi === undefined) {
      delete process.env.CI
    } else {
      process.env.CI = prevCi
    }
    jest.resetModules()
  }
}

describe('playwright.config.js reporter configuration (#678)', () => {
  it('uses only the list reporter during local runs when CI is unset', () => {
    const config = loadPlaywrightConfig(undefined)
    expect(config.reporter).toEqual([['list']])
  })

  it('enables non-interactive HTML report output matching playwright-tests.yml on CI', () => {
    const config = loadPlaywrightConfig('true')
    expect(config.reporter).toEqual([
      ['list'],
      ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ])

    const workflow = fs.readFileSync(workflowPath, 'utf8')
    expect(workflow).toMatch(/path:\s*playwright-report\/?/)
  })
})
