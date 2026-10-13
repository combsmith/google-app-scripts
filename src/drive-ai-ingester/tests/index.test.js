const {
  extractFileContentText,
  analyzeDocumentWithAi,
  applyDualLayerTagsToDriveFile,
  extractJsonSubstring,
  parseRetryDelayMs,
  getNotePathForDomain,
  formatDriveIngestionEntry,
} = require('../src/index')

const MimeType = { GOOGLE_DOCS: 'gdoc', PLAIN_TEXT: 'text/plain' }

function makeResponse(code, text, headers) {
  return {
    getResponseCode: () => code,
    getContentText: () => text,
    getHeaders: () => headers || {},
  }
}

function geminiBody(text) {
  return JSON.stringify({
    candidates: [{ content: { parts: [{ text }] } }],
  })
}

describe('extractFileContentText', () => {
  beforeEach(() => jest.spyOn(console, 'warn').mockImplementation(() => {}))
  afterEach(() => jest.restoreAllMocks())

  test('reads Google Doc body truncated to 3000 chars', () => {
    const file = {
      getMimeType: () => 'gdoc',
      getId: () => 'id1',
      getName: () => 'n',
    }
    const DocumentApp = {
      openById: () => ({
        getBody: () => ({ getText: () => 'a'.repeat(5000) }),
      }),
    }
    expect(
      extractFileContentText(file, { DocumentApp, MimeType })
    ).toHaveLength(3000)
  })

  test('reads plain text blob', () => {
    const file = {
      getMimeType: () => 'text/plain',
      getBlob: () => ({ getDataAsString: () => 'hello' }),
      getName: () => 'n',
    }
    expect(extractFileContentText(file, { MimeType })).toBe('hello')
  })

  test('falls back to file name for other types', () => {
    const file = { getMimeType: () => 'pdf', getName: () => 'a.pdf' }
    expect(extractFileContentText(file, { MimeType })).toBe('a.pdf')
  })

  test('falls back to file name on error', () => {
    const file = {
      getMimeType: () => {
        throw new Error('boom')
      },
      getName: () => 'a.pdf',
    }
    expect(extractFileContentText(file, { MimeType })).toBe('a.pdf')
    expect(console.warn).toHaveBeenCalled()
  })
})

describe('analyzeDocumentWithAi', () => {
  const config = { canonicalDomains: ['01_Household'], geminiApiKey: 'k' }
  beforeEach(() => {
    jest.spyOn(console, 'warn').mockImplementation(() => {})
    jest.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => jest.restoreAllMocks())

  test('returns parsed metadata on first success using gemini-2.5-flash', () => {
    const UrlFetchApp = {
      fetch: jest
        .fn()
        .mockReturnValue(
          makeResponse(200, geminiBody('```json\n{"title":"T"}\n```'))
        ),
    }
    const res = analyzeDocumentWithAi('f', 't', config, {
      UrlFetchApp,
      Utilities: { sleep: jest.fn() },
    })
    expect(res).toEqual({ title: 'T' })
    expect(UrlFetchApp.fetch).toHaveBeenCalledTimes(1)
    expect(UrlFetchApp.fetch).toHaveBeenCalledWith(
      expect.stringContaining('gemini-2.5-flash:generateContent'),
      expect.any(Object)
    )
  })

  test('falls back to secondary model if first model fails', () => {
    const fetch = jest
      .fn()
      .mockReturnValueOnce(makeResponse(500, 'Internal Server Error'))
      .mockReturnValueOnce(
        makeResponse(200, geminiBody('```json\n{"title":"Fallback"}\n```'))
      )
    const res = analyzeDocumentWithAi('f', 't', config, {
      UrlFetchApp: { fetch },
      Utilities: { sleep: jest.fn() },
    })
    expect(res).toEqual({ title: 'Fallback' })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('gemini-2.5-flash:generateContent'),
      expect.any(Object)
    )
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('gemini-2.0-flash:generateContent'),
      expect.any(Object)
    )
  })

  test('sleeps on 429, handles exceptions and bad bodies across all production models, then returns null', () => {
    const sleep = jest.fn()
    const fetch = jest
      .fn()
      .mockReturnValueOnce(makeResponse(429, '', { 'Retry-After': '2' }))
      .mockImplementationOnce(() => {
        throw new Error('net')
      })
      .mockReturnValueOnce(makeResponse(200, geminiBody('no json here')))
    const res = analyzeDocumentWithAi('f', 't', config, {
      UrlFetchApp: { fetch },
      Utilities: { sleep },
    })
    expect(res).toBeNull()
    expect(sleep).toHaveBeenCalledWith(2000)
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('gemini-2.5-flash:generateContent'),
      expect.any(Object)
    )
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('gemini-2.0-flash:generateContent'),
      expect.any(Object)
    )
    expect(fetch).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('gemini-1.5-flash:generateContent'),
      expect.any(Object)
    )
  })

  test('handles 200 response with missing candidates', () => {
    const fetch = jest
      .fn()
      .mockReturnValue(makeResponse(200, JSON.stringify({})))
    const res = analyzeDocumentWithAi('f', 't', config, {
      UrlFetchApp: { fetch },
      Utilities: { sleep: jest.fn() },
    })
    expect(res).toBeNull()
    expect(fetch).toHaveBeenCalledTimes(3)
  })
})

describe('applyDualLayerTagsToDriveFile', () => {
  beforeEach(() => {
    jest.spyOn(console, 'warn').mockImplementation(() => {})
    jest.spyOn(console, 'log').mockImplementation(() => {})
    jest.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => jest.restoreAllMocks())

  const Utilities = { formatDate: () => '2026-01-01' }
  const meta = {
    canonicalDomain: '01_Household',
    subLabel: 'x',
    tags: ['a', 'b'],
    people: ['P', 'Acme, Inc.'],
    organization: ['Org, LLC'],
  }

  function makeFile(over) {
    return Object.assign(
      {
        getDescription: () => 'old',
        setDescription: jest.fn(),
        getName: () => 'n',
        getMimeType: () => 'text/plain',
        getId: () => 'id',
        getLastUpdated: () => new Date(),
      },
      over
    )
  }

  test('sets description and inserts front matter into docs with properly escaped JSON arrays', () => {
    const body = { getText: () => 'text', insertParagraph: jest.fn() }
    const DocumentApp = { openById: () => ({ getBody: () => body }) }
    const file = makeFile({ getMimeType: () => 'gdoc' })
    expect(
      applyDualLayerTagsToDriveFile(file, meta, {
        DocumentApp,
        MimeType,
        Utilities,
      })
    ).toBe(true)
    expect(file.setDescription).toHaveBeenCalledWith(
      expect.stringContaining('old\n\n[AI_INDEXED]')
    )
    expect(body.insertParagraph).toHaveBeenCalledWith(
      0,
      expect.stringContaining('people: ["P","Acme, Inc."]')
    )
    expect(body.insertParagraph).toHaveBeenCalledWith(
      0,
      expect.stringContaining('organization: ["Org, LLC"]')
    )
  })

  test('uses empty description, skips existing marker and header', () => {
    const body = { getText: () => '---x', insertParagraph: jest.fn() }
    const DocumentApp = { openById: () => ({ getBody: () => body }) }
    const file = makeFile({
      getDescription: () => '[AI_INDEXED] already',
      getMimeType: () => 'gdoc',
    })
    expect(
      applyDualLayerTagsToDriveFile(
        file,
        {},
        { DocumentApp, MimeType, Utilities }
      )
    ).toBe(true)
    expect(file.setDescription).not.toHaveBeenCalled()
    expect(body.insertParagraph).not.toHaveBeenCalled()

    const f2 = makeFile({ getDescription: () => null })
    applyDualLayerTagsToDriveFile(f2, meta, { MimeType, Utilities })
    expect(f2.setDescription).toHaveBeenCalledWith(
      expect.stringMatching(/^\[AI_INDEXED\]/)
    )
  })

  test('skips header insertion when existing header has leading whitespace', () => {
    const body = {
      getText: () => '  \n\n---\ndomain: "01_Household"\n---',
      insertParagraph: jest.fn(),
    }
    const DocumentApp = { openById: () => ({ getBody: () => body }) }
    const file = makeFile({
      getDescription: () => 'desc',
      getMimeType: () => 'gdoc',
    })
    expect(
      applyDualLayerTagsToDriveFile(file, meta, {
        DocumentApp,
        MimeType,
        Utilities,
      })
    ).toBe(true)
    expect(body.insertParagraph).not.toHaveBeenCalled()
  })

  test('handles non-array metadata tags, people, and organization gracefully', () => {
    const body = { getText: () => 'text', insertParagraph: jest.fn() }
    const DocumentApp = { openById: () => ({ getBody: () => body }) }
    const file = makeFile({ getMimeType: () => 'gdoc' })
    const nonArrayMeta = {
      canonicalDomain: '01_Household',
      subLabel: 'x',
      tags: 'not-an-array',
      people: 'not-an-array',
      organization: 'not-an-array',
    }
    expect(
      applyDualLayerTagsToDriveFile(file, nonArrayMeta, {
        DocumentApp,
        MimeType,
        Utilities,
      })
    ).toBe(true)
    expect(file.setDescription).toHaveBeenCalled()
    expect(body.insertParagraph).toHaveBeenCalledWith(
      0,
      expect.stringContaining('people: []')
    )
  })

  test('returns false when layer 1 fails', () => {
    const file = makeFile({
      setDescription: () => {
        throw new Error('x')
      },
    })
    expect(
      applyDualLayerTagsToDriveFile(file, meta, { MimeType, Utilities })
    ).toBe(false)
  })

  test('layer 2 failure is non-fatal', () => {
    const DocumentApp = {
      openById: () => {
        throw new Error('x')
      },
    }
    const file = makeFile({ getMimeType: () => 'gdoc' })
    expect(
      applyDualLayerTagsToDriveFile(file, meta, {
        DocumentApp,
        MimeType,
        Utilities,
      })
    ).toBe(true)
  })
})

describe('extractJsonSubstring', () => {
  beforeEach(() => jest.spyOn(console, 'warn').mockImplementation(() => {}))
  afterEach(() => jest.restoreAllMocks())

  test('handles empty, invalid, and valid input', () => {
    expect(extractJsonSubstring('')).toBeNull()
    expect(extractJsonSubstring('nothing')).toBeNull()
    expect(extractJsonSubstring('{bad}')).toBeNull()
    expect(extractJsonSubstring('x {"a":1} y')).toEqual({ a: 1 })
  })
})

describe('parseRetryDelayMs', () => {
  test('parses, caps, and defaults', () => {
    expect(
      parseRetryDelayMs(makeResponse(429, '', { 'Retry-After': '3' }))
    ).toBe(3000)
    expect(
      parseRetryDelayMs(makeResponse(429, '', { 'retry-after': '999' }))
    ).toBe(30000)
    expect(
      parseRetryDelayMs(makeResponse(429, '', { 'Retry-After': 'x' }))
    ).toBe(5000)
    expect(parseRetryDelayMs(makeResponse(429, ''))).toBe(5000)
    expect(parseRetryDelayMs(undefined)).toBe(5000)
  })
})

describe('getNotePathForDomain', () => {
  test('maps known and unknown domains', () => {
    expect(getNotePathForDomain('03_Vehicles')).toBe('03_Vehicles/index.md')
    expect(getNotePathForDomain('nope')).toBeNull()
  })
})

describe('formatDriveIngestionEntry', () => {
  test('formats full entry with account email', () => {
    const out = formatDriveIngestionEntry(
      '2026-01-01',
      'T',
      'http://u',
      ' sum ',
      ['a', 'b'],
      ['P'],
      'me@x'
    )
    expect(out).toContain('[T](http://u)')
    expect(out).toContain('- **Account**: me@x')
    expect(out).toContain('**People**: P')
    expect(out).toContain('`a`, `b`')
    expect(out).toContain('> sum')
  })

  test('omits Account line when accountEmail is null or empty', () => {
    const out = formatDriveIngestionEntry(
      '2026-01-01',
      'T',
      'http://u',
      ' sum ',
      ['a'],
      ['P'],
      null
    )
    expect(out).not.toContain('Account')
  })

  test('omits empty sections', () => {
    const out = formatDriveIngestionEntry('d', 'T', 'u', '', [], null, 'me')
    expect(out).not.toContain('People')
    expect(out).not.toContain('Tags')
    expect(out).not.toContain('Summary')
  })

  test('escapes square brackets and backslashes in document title', () => {
    const out = formatDriveIngestionEntry(
      '2026-01-01',
      '[Draft\\Test] Spec [Q1]',
      'http://u',
      ' sum ',
      ['a'],
      ['P'],
      'me@x'
    )
    expect(out).toContain('\\[Draft\\\\Test\\] Spec \\[Q1\\]')
    expect(out).toContain('[\\[Draft\\\\Test\\] Spec \\[Q1\\]](http://u)')
  })

  test('handles non-array peopleList and tagsList gracefully', () => {
    const out = formatDriveIngestionEntry(
      '2026-01-01',
      'T',
      'http://u',
      ' sum ',
      'not-an-array',
      'not-an-array',
      null
    )
    expect(out).not.toContain('People')
    expect(out).not.toContain('Tags')
    expect(out).toContain('[T](http://u)')
  })

  test('handles null or undefined title gracefully', () => {
    const out = formatDriveIngestionEntry(
      '2026-01-01',
      null,
      'http://u',
      ' sum ',
      [],
      [],
      null
    )
    expect(out).toContain('[](http://u)')
  })

  test('formats multi-line summary with blockquote marker on every line', () => {
    const out = formatDriveIngestionEntry(
      '2026-01-01',
      'Doc Title',
      'http://u',
      'Line 1\nLine 2\r\nLine 3',
      [],
      [],
      null
    )
    expect(out).toContain(
      '- **Summary**:\n  > Line 1\n  > Line 2\n  > Line 3\n'
    )
  })
})

describe('config and gitHubSync validation', () => {
  const { getDriveIngesterConfig } = require('../config.gs')
  const {
    appendMarkdownEntryToGitHubRepo,
    executeGitHubCommit,
  } = require('../gitHubSync.gs')

  beforeEach(() => {
    global.getDriveIngesterConfig = getDriveIngesterConfig
    jest.spyOn(console, 'warn').mockImplementation(() => {})
    jest.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => jest.restoreAllMocks())

  test('getDriveIngesterConfig defaults github repo owner and name to empty string', () => {
    global.PropertiesService = {
      getScriptProperties: () => ({
        getProperty: () => null,
      }),
    }
    const config = getDriveIngesterConfig()
    expect(config.githubRepoOwner).toBe('')
    expect(config.githubRepoName).toBe('')
    expect(config.githubToken).toBe('')
  })

  test('appendMarkdownEntryToGitHubRepo returns false when destination repo coordinates are missing', () => {
    global.PropertiesService = {
      getScriptProperties: () => ({
        getProperty: (key) => {
          if (key === 'GITHUB_PAT') return 'token'
          return null
        },
      }),
    }
    const result = appendMarkdownEntryToGitHubRepo(
      'path.md',
      'entry',
      'message'
    )
    expect(result).toBe(false)
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('GitHub sync configuration incomplete')
    )
  })

  test('executeGitHubCommit returns false when repo coordinates are missing', () => {
    const result = executeGitHubCommit('path.md', 'entry', 'msg', {
      githubToken: 'tok',
      githubRepoOwner: '',
      githubRepoName: '',
    })
    expect(result).toBe(false)
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Missing repository owner or repository name')
    )
  })
})
