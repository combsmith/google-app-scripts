'use strict'

const {
  GITHUB_API_BASE,
  APPS_SCRIPT_API_BASE,
  getFileType,
  filterGithubItems,
  buildManifestFile,
  buildDeploymentPayload,
} = require('../src/index')

// ── getFileType ───────────────────────────────────────────────────────────────

describe('getFileType', () => {
  test('returns SERVER_JS for .gs files', () => {
    expect(getFileType('code.gs')).toBe('SERVER_JS')
    expect(getFileType('config.gs')).toBe('SERVER_JS')
  })

  test('returns HTML for .html files', () => {
    expect(getFileType('Index.html')).toBe('HTML')
    expect(getFileType('page.html')).toBe('HTML')
  })

  test('returns null for unsupported extensions', () => {
    expect(getFileType('README.md')).toBeNull()
    expect(getFileType('package.json')).toBeNull()
    expect(getFileType('style.css')).toBeNull()
  })

  test('returns null for empty string', () => {
    expect(getFileType('')).toBeNull()
  })

  test('returns null for null', () => {
    expect(getFileType(null)).toBeNull()
  })

  test('returns null for undefined', () => {
    expect(getFileType(undefined)).toBeNull()
  })

  test('returns null for non-string values', () => {
    expect(getFileType(42)).toBeNull()
    expect(getFileType({})).toBeNull()
  })
})

// ── filterGithubItems ─────────────────────────────────────────────────────────

describe('filterGithubItems', () => {
  const gsItem = {
    type: 'file',
    name: 'code.gs',
    download_url: 'https://raw.githubusercontent.com/example/code.gs',
  }
  const htmlItem = {
    type: 'file',
    name: 'Index.html',
    download_url: 'https://raw.githubusercontent.com/example/Index.html',
  }
  const mdItem = {
    type: 'file',
    name: 'README.md',
    download_url: 'https://raw.githubusercontent.com/example/README.md',
  }
  const dirItem = {
    type: 'dir',
    name: 'src',
    download_url: null,
  }

  test('returns empty array for non-array input', () => {
    expect(filterGithubItems(null)).toEqual([])
    expect(filterGithubItems(undefined)).toEqual([])
    expect(filterGithubItems('string')).toEqual([])
    expect(filterGithubItems({})).toEqual([])
  })

  test('returns empty array for empty input', () => {
    expect(filterGithubItems([])).toEqual([])
  })

  test('includes .gs files with SERVER_JS type', () => {
    const result = filterGithubItems([gsItem])
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('code')
    expect(result[0].type).toBe('SERVER_JS')
    expect(result[0].download_url).toBe(gsItem.download_url)
  })

  test('includes .html files with HTML type', () => {
    const result = filterGithubItems([htmlItem])
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('Index')
    expect(result[0].type).toBe('HTML')
  })

  test('strips .gs extension from name', () => {
    const result = filterGithubItems([gsItem])
    expect(result[0].name).toBe('code')
  })

  test('strips .html extension from name', () => {
    const result = filterGithubItems([htmlItem])
    expect(result[0].name).toBe('Index')
  })

  test('excludes unsupported file extensions', () => {
    const result = filterGithubItems([mdItem])
    expect(result).toHaveLength(0)
  })

  test('excludes directory items', () => {
    const result = filterGithubItems([dirItem])
    expect(result).toHaveLength(0)
  })

  test('excludes items without a download_url', () => {
    const noUrl = { type: 'file', name: 'code.gs', download_url: null }
    expect(filterGithubItems([noUrl])).toHaveLength(0)
  })

  test('excludes null and undefined items in array', () => {
    const result = filterGithubItems([null, undefined, gsItem])
    expect(result).toHaveLength(1)
  })

  test('handles mixed valid and invalid items', () => {
    const result = filterGithubItems([gsItem, htmlItem, mdItem, dirItem])
    expect(result).toHaveLength(2)
    const names = result.map((r) => r.name)
    expect(names).toContain('code')
    expect(names).toContain('Index')
  })

  test('preserves the download_url on returned items', () => {
    const result = filterGithubItems([gsItem])
    expect(result[0].download_url).toBe(gsItem.download_url)
  })
})

// ── buildManifestFile ─────────────────────────────────────────────────────────

describe('buildManifestFile', () => {
  test('returns an object with name, type, and source', () => {
    const manifest = buildManifestFile()
    expect(typeof manifest).toBe('object')
    expect(manifest.name).toBe('appsscript')
    expect(manifest.type).toBe('JSON')
    expect(typeof manifest.source).toBe('string')
  })

  test('source is valid JSON', () => {
    const manifest = buildManifestFile()
    expect(() => JSON.parse(manifest.source)).not.toThrow()
  })

  test('source JSON contains required fields', () => {
    const manifest = buildManifestFile()
    const parsed = JSON.parse(manifest.source)
    expect(typeof parsed.timeZone).toBe('string')
    expect(parsed.exceptionLogging).toBe('STACKDRIVER')
    expect(parsed.runtimeVersion).toBe('V8')
    expect(typeof parsed.dependencies).toBe('object')
  })

  test('returns a new object on each call (no shared state)', () => {
    const m1 = buildManifestFile()
    const m2 = buildManifestFile()
    expect(m1).not.toBe(m2)
  })
})

// ── buildDeploymentPayload ────────────────────────────────────────────────────

describe('buildDeploymentPayload', () => {
  const codeFile = {
    name: 'code',
    type: 'SERVER_JS',
    source: 'function main() {}',
  }
  const configFile = { name: 'config', type: 'SERVER_JS', source: 'var X = 1;' }

  test('throws for non-array input', () => {
    expect(() => buildDeploymentPayload(null)).toThrow(
      'sourceFiles must be a non-empty array'
    )
    expect(() => buildDeploymentPayload(undefined)).toThrow(
      'sourceFiles must be a non-empty array'
    )
    expect(() => buildDeploymentPayload('string')).toThrow(
      'sourceFiles must be a non-empty array'
    )
  })

  test('throws for empty array', () => {
    expect(() => buildDeploymentPayload([])).toThrow(
      'sourceFiles must be a non-empty array'
    )
  })

  test('result starts with the appsscript manifest', () => {
    const result = buildDeploymentPayload([codeFile])
    expect(result[0].name).toBe('appsscript')
    expect(result[0].type).toBe('JSON')
  })

  test('source files appear after the manifest', () => {
    const result = buildDeploymentPayload([codeFile, configFile])
    expect(result[1]).toEqual(codeFile)
    expect(result[2]).toEqual(configFile)
  })

  test('total length is sourceFiles.length + 1 (manifest)', () => {
    const result = buildDeploymentPayload([codeFile, configFile])
    expect(result).toHaveLength(3)
  })

  test('works with a single source file', () => {
    const result = buildDeploymentPayload([codeFile])
    expect(result).toHaveLength(2)
    expect(result[1]).toEqual(codeFile)
  })

  test('does not mutate the input array', () => {
    const input = [codeFile]
    buildDeploymentPayload(input)
    expect(input).toHaveLength(1)
  })
})

// ── Constants ─────────────────────────────────────────────────────────────────

describe('GITHUB_API_BASE', () => {
  test('points to the correct repository path', () => {
    expect(GITHUB_API_BASE).toBe(
      'https://api.github.com/repos/combsmith/google-app-scripts/contents/src'
    )
  })
})

describe('APPS_SCRIPT_API_BASE', () => {
  test('points to the correct Google API endpoint', () => {
    expect(APPS_SCRIPT_API_BASE).toBe('https://script.googleapis.com/v1')
  })
})
