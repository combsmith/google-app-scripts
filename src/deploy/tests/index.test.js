'use strict'

const fs = require('fs')
const path = require('path')
const {
  APPS_SCRIPT_API_BASE,
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
} = require('../index')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns a fetch-like mock that resolves with the provided body/status. */
function makeFetch(status, body) {
  const bodyStr = typeof body === 'string' ? body : JSON.stringify(body)
  return jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: jest.fn().mockResolvedValue(bodyStr),
    json: jest.fn().mockResolvedValue(body),
  })
}

// ---------------------------------------------------------------------------
// getScriptCatalog
// ---------------------------------------------------------------------------

describe('getScriptCatalog', () => {
  test('returns a non-empty array', () => {
    const catalog = getScriptCatalog()
    expect(Array.isArray(catalog)).toBe(true)
    expect(catalog.length).toBeGreaterThan(0)
  })

  test('each entry has required fields', () => {
    const catalog = getScriptCatalog()
    for (const entry of catalog) {
      expect(typeof entry.id).toBe('string')
      expect(entry.id.length).toBeGreaterThan(0)
      expect(typeof entry.name).toBe('string')
      expect(typeof entry.description).toBe('string')
      expect(Array.isArray(entry.files)).toBe(true)
      expect(entry.files.length).toBeGreaterThan(0)
      expect(Array.isArray(entry.scopes)).toBe(true)
      expect(entry.scopes.length).toBeGreaterThan(0)
    }
  })

  test('includes gmail-to-drive-by-labels entry', () => {
    const catalog = getScriptCatalog()
    const entry = catalog.find((e) => e.id === 'gmail-to-drive-by-labels')
    expect(entry).toBeDefined()
    expect(entry.files).toContain('code.gs')
    expect(entry.files).toContain('config.gs')
  })

  test('includes calendar-to-sheets entry', () => {
    const catalog = getScriptCatalog()
    const entry = catalog.find((e) => e.id === 'calendar-to-sheets')
    expect(entry).toBeDefined()
    expect(entry.files).toContain('code.gs')
    expect(entry.files).toContain('config.gs')
  })

  test('all entries have unique ids', () => {
    const catalog = getScriptCatalog()
    const ids = catalog.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

// ---------------------------------------------------------------------------
// getScriptById
// ---------------------------------------------------------------------------

describe('getScriptById', () => {
  test('returns the correct entry for a known id', () => {
    const entry = getScriptById('calendar-to-sheets')
    expect(entry).not.toBeNull()
    expect(entry.id).toBe('calendar-to-sheets')
  })

  test('returns the correct entry for gmail-to-drive-by-labels', () => {
    const entry = getScriptById('gmail-to-drive-by-labels')
    expect(entry).not.toBeNull()
    expect(entry.id).toBe('gmail-to-drive-by-labels')
  })

  test('returns null for an unknown id', () => {
    expect(getScriptById('does-not-exist')).toBeNull()
  })

  test('returns null when called with no argument', () => {
    expect(getScriptById()).toBeNull()
  })

  test('returns null for empty string', () => {
    expect(getScriptById('')).toBeNull()
  })

  test('returns null for null input', () => {
    expect(getScriptById(null)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// buildProjectContent
// ---------------------------------------------------------------------------

describe('buildProjectContent', () => {
  test('builds correct structure for valid files', () => {
    const result = buildProjectContent([
      { name: 'code', source: 'function main() {}' },
      { name: 'config', source: 'var X = 1;' },
    ])
    expect(result).toEqual({
      files: [
        { name: 'code', type: 'SERVER_JS', source: 'function main() {}' },
        { name: 'config', type: 'SERVER_JS', source: 'var X = 1;' },
      ],
    })
  })

  test('sets type to SERVER_JS for all files', () => {
    const result = buildProjectContent([{ name: 'code', source: '' }])
    expect(result.files[0].type).toBe('SERVER_JS')
  })

  test('throws when files is not an array', () => {
    expect(() => buildProjectContent('not-an-array')).toThrow(
      'files must be a non-empty array'
    )
  })

  test('throws when files is an empty array', () => {
    expect(() => buildProjectContent([])).toThrow(
      'files must be a non-empty array'
    )
  })

  test('throws when a file has no name', () => {
    expect(() => buildProjectContent([{ name: '', source: 'x' }])).toThrow(
      'non-empty string name'
    )
  })

  test('throws when a file entry is missing name key', () => {
    expect(() => buildProjectContent([{ source: 'x' }])).toThrow(
      'non-empty string name'
    )
  })

  test('throws when a file has a non-string source', () => {
    expect(() => buildProjectContent([{ name: 'code', source: 123 }])).toThrow(
      'string source'
    )
  })

  test('throws when file entry is null', () => {
    expect(() => buildProjectContent([null])).toThrow()
  })

  test('preserves empty string source', () => {
    const result = buildProjectContent([{ name: 'code', source: '' }])
    expect(result.files[0].source).toBe('')
  })
})

// ---------------------------------------------------------------------------
// createProject
// ---------------------------------------------------------------------------

describe('createProject', () => {
  test('calls the correct endpoint with correct method and headers', async () => {
    const responseBody = {
      scriptId: 'abc123',
      title: 'My Script',
      createTime: 't1',
      updateTime: 't2',
    }
    const fetchFn = makeFetch(200, responseBody)

    const result = await createProject(fetchFn, 'token-xyz', 'My Script')

    expect(fetchFn).toHaveBeenCalledTimes(1)
    const [url, opts] = fetchFn.mock.calls[0]
    expect(url).toBe(`${APPS_SCRIPT_API_BASE}/projects`)
    expect(opts.method).toBe('POST')
    expect(opts.headers.Authorization).toBe('Bearer token-xyz')
    expect(opts.headers['Content-Type']).toBe('application/json')
    expect(JSON.parse(opts.body)).toEqual({ title: 'My Script' })
    expect(result).toEqual(responseBody)
  })

  test('throws when fetchFn is not a function', async () => {
    await expect(createProject(null, 'token', 'title')).rejects.toThrow(
      'fetchFn must be a function'
    )
  })

  test('throws when accessToken is missing', async () => {
    await expect(createProject(jest.fn(), '', 'title')).rejects.toThrow(
      'accessToken is required'
    )
  })

  test('throws when accessToken is null', async () => {
    await expect(createProject(jest.fn(), null, 'title')).rejects.toThrow(
      'accessToken is required'
    )
  })

  test('throws when title is missing', async () => {
    await expect(createProject(jest.fn(), 'token', '')).rejects.toThrow(
      'title is required'
    )
  })

  test('throws when title is null', async () => {
    await expect(createProject(jest.fn(), 'token', null)).rejects.toThrow(
      'title is required'
    )
  })

  test('throws with error message on non-OK response', async () => {
    const fetchFn = makeFetch(403, 'Forbidden')
    await expect(createProject(fetchFn, 'token', 'title')).rejects.toThrow(
      'Failed to create project: 403'
    )
  })

  test('includes response body text in error message on failure', async () => {
    const fetchFn = makeFetch(500, 'Internal Server Error')
    await expect(createProject(fetchFn, 'token', 'title')).rejects.toThrow(
      'Internal Server Error'
    )
  })
})

// ---------------------------------------------------------------------------
// updateProjectContent
// ---------------------------------------------------------------------------

describe('updateProjectContent', () => {
  const validContent = {
    files: [{ name: 'code', type: 'SERVER_JS', source: 'function foo() {}' }],
  }

  test('calls the correct endpoint with correct method and headers', async () => {
    const responseBody = { files: validContent.files }
    const fetchFn = makeFetch(200, responseBody)

    const result = await updateProjectContent(
      fetchFn,
      'token-abc',
      'script-001',
      validContent
    )

    expect(fetchFn).toHaveBeenCalledTimes(1)
    const [url, opts] = fetchFn.mock.calls[0]
    expect(url).toBe(`${APPS_SCRIPT_API_BASE}/projects/script-001/content`)
    expect(opts.method).toBe('PUT')
    expect(opts.headers.Authorization).toBe('Bearer token-abc')
    expect(opts.headers['Content-Type']).toBe('application/json')
    expect(JSON.parse(opts.body)).toEqual(validContent)
    expect(result).toEqual(responseBody)
  })

  test('throws when fetchFn is not a function', async () => {
    await expect(
      updateProjectContent(null, 'token', 'id', validContent)
    ).rejects.toThrow('fetchFn must be a function')
  })

  test('throws when accessToken is missing', async () => {
    await expect(
      updateProjectContent(jest.fn(), '', 'id', validContent)
    ).rejects.toThrow('accessToken is required')
  })

  test('throws when accessToken is null', async () => {
    await expect(
      updateProjectContent(jest.fn(), null, 'id', validContent)
    ).rejects.toThrow('accessToken is required')
  })

  test('throws when scriptId is missing', async () => {
    await expect(
      updateProjectContent(jest.fn(), 'token', '', validContent)
    ).rejects.toThrow('scriptId is required')
  })

  test('throws when scriptId is null', async () => {
    await expect(
      updateProjectContent(jest.fn(), 'token', null, validContent)
    ).rejects.toThrow('scriptId is required')
  })

  test('throws when content is null', async () => {
    await expect(
      updateProjectContent(jest.fn(), 'token', 'id', null)
    ).rejects.toThrow('content must be an object with a files array')
  })

  test('throws when content.files is not an array', async () => {
    await expect(
      updateProjectContent(jest.fn(), 'token', 'id', { files: 'bad' })
    ).rejects.toThrow('content must be an object with a files array')
  })

  test('throws with error message on non-OK response', async () => {
    const fetchFn = makeFetch(401, 'Unauthorized')
    await expect(
      updateProjectContent(fetchFn, 'token', 'id', validContent)
    ).rejects.toThrow('Failed to update project content: 401')
  })

  test('includes response body text in error message on failure', async () => {
    const fetchFn = makeFetch(400, 'Bad Request details')
    await expect(
      updateProjectContent(fetchFn, 'token', 'id', validContent)
    ).rejects.toThrow('Bad Request details')
  })
})

// ---------------------------------------------------------------------------
// deployScript
// ---------------------------------------------------------------------------

describe('deployScript', () => {
  const files = [
    { name: 'code', source: 'function main() {}' },
    { name: 'config', source: 'var X = 1;' },
  ]

  function makeDeployFetch(scriptId) {
    let callCount = 0
    return jest.fn().mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        // createProject response
        return Promise.resolve({
          ok: true,
          status: 200,
          text: jest.fn().mockResolvedValue(''),
          json: jest.fn().mockResolvedValue({
            scriptId,
            title: 'Test Script',
            createTime: '2026-01-01T00:00:00Z',
            updateTime: '2026-01-01T00:00:00Z',
          }),
        })
      }
      // updateProjectContent response
      return Promise.resolve({
        ok: true,
        status: 200,
        text: jest.fn().mockResolvedValue(''),
        json: jest.fn().mockResolvedValue({ files: [] }),
      })
    })
  }

  test('returns scriptId, title and appsScriptUrl on success', async () => {
    const fetchFn = makeDeployFetch('new-script-id')
    const result = await deployScript(fetchFn, 'token', 'My Project', files)

    expect(result.scriptId).toBe('new-script-id')
    expect(result.title).toBe('Test Script')
    expect(result.appsScriptUrl).toBe(
      'https://script.google.com/d/new-script-id/edit'
    )
  })

  test('makes exactly two fetch calls (create + update)', async () => {
    const fetchFn = makeDeployFetch('sid')
    await deployScript(fetchFn, 'token', 'Title', files)
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  test('first call goes to /projects endpoint', async () => {
    const fetchFn = makeDeployFetch('sid')
    await deployScript(fetchFn, 'token', 'Title', files)
    expect(fetchFn.mock.calls[0][0]).toBe(`${APPS_SCRIPT_API_BASE}/projects`)
  })

  test('second call goes to /projects/:id/content endpoint', async () => {
    const fetchFn = makeDeployFetch('sid')
    await deployScript(fetchFn, 'token', 'Title', files)
    expect(fetchFn.mock.calls[1][0]).toBe(
      `${APPS_SCRIPT_API_BASE}/projects/sid/content`
    )
  })

  test('propagates errors from createProject', async () => {
    const fetchFn = makeFetch(500, 'Server Error')
    await expect(
      deployScript(fetchFn, 'token', 'Title', files)
    ).rejects.toThrow('Failed to create project')
  })

  test('propagates errors from updateProjectContent', async () => {
    let callCount = 0
    const fetchFn = jest.fn().mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: jest.fn().mockResolvedValue(''),
          json: jest.fn().mockResolvedValue({
            scriptId: 'sid',
            title: 'T',
            createTime: '',
            updateTime: '',
          }),
        })
      }
      return Promise.resolve({
        ok: false,
        status: 422,
        text: jest.fn().mockResolvedValue('Unprocessable Entity'),
        json: jest.fn().mockResolvedValue({}),
      })
    })

    await expect(
      deployScript(fetchFn, 'token', 'Title', files)
    ).rejects.toThrow('Failed to update project content')
  })
})

// ---------------------------------------------------------------------------
// createGmailLabel
// ---------------------------------------------------------------------------

describe('createGmailLabel', () => {
  test('calls the Gmail labels endpoint with correct method and body', async () => {
    const responseBody = { id: 'Label_42', name: 'Projects/receipts' }
    const fetchFn = makeFetch(200, responseBody)

    const result = await createGmailLabel(
      fetchFn,
      'token-abc',
      'Projects/receipts'
    )

    expect(fetchFn).toHaveBeenCalledTimes(1)
    const [url, opts] = fetchFn.mock.calls[0]
    expect(url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/labels')
    expect(opts.method).toBe('POST')
    expect(opts.headers.Authorization).toBe('Bearer token-abc')
    expect(opts.headers['Content-Type']).toBe('application/json')
    expect(JSON.parse(opts.body)).toEqual({ name: 'Projects/receipts' })
    expect(result).toEqual(responseBody)
  })

  test('returns label object with id and name on success', async () => {
    const fetchFn = makeFetch(200, { id: 'Label_1', name: 'my-label' })
    const result = await createGmailLabel(fetchFn, 'token', 'my-label')
    expect(result.id).toBe('Label_1')
    expect(result.name).toBe('my-label')
  })

  test('throws when fetchFn is not a function', async () => {
    await expect(createGmailLabel(null, 'token', 'label')).rejects.toThrow(
      'fetchFn must be a function'
    )
  })

  test('throws when accessToken is missing', async () => {
    await expect(createGmailLabel(jest.fn(), '', 'label')).rejects.toThrow(
      'accessToken is required'
    )
  })

  test('throws when accessToken is null', async () => {
    await expect(createGmailLabel(jest.fn(), null, 'label')).rejects.toThrow(
      'accessToken is required'
    )
  })

  test('throws when labelName is missing', async () => {
    await expect(createGmailLabel(jest.fn(), 'token', '')).rejects.toThrow(
      'labelName is required'
    )
  })

  test('throws when labelName is null', async () => {
    await expect(createGmailLabel(jest.fn(), 'token', null)).rejects.toThrow(
      'labelName is required'
    )
  })

  test('throws with error message on non-OK response', async () => {
    const fetchFn = makeFetch(409, 'Label already exists')
    await expect(
      createGmailLabel(fetchFn, 'token', 'duplicate')
    ).rejects.toThrow('Failed to create Gmail label: 409')
  })

  test('includes response body text in error message on failure', async () => {
    const fetchFn = makeFetch(409, 'Label already exists')
    await expect(
      createGmailLabel(fetchFn, 'token', 'duplicate')
    ).rejects.toThrow('Label already exists')
  })

  test('throws on server error', async () => {
    const fetchFn = makeFetch(500, 'Internal Server Error')
    await expect(createGmailLabel(fetchFn, 'token', 'label')).rejects.toThrow(
      'Failed to create Gmail label: 500'
    )
  })
})

// ---------------------------------------------------------------------------
// escapeHtml
// ---------------------------------------------------------------------------

describe('escapeHtml', () => {
  test('escapes ampersands', () => {
    expect(escapeHtml('a & b')).toBe('a &amp; b')
  })

  test('escapes less-than signs', () => {
    expect(escapeHtml('a < b')).toBe('a &lt; b')
  })

  test('escapes greater-than signs', () => {
    expect(escapeHtml('a > b')).toBe('a &gt; b')
  })

  test('escapes double quotes', () => {
    expect(escapeHtml('say "hello"')).toBe('say &quot;hello&quot;')
  })

  test('escapes single quotes', () => {
    expect(escapeHtml("it's mine")).toBe('it&#x27;s mine')
  })

  test('escapes multiple special characters', () => {
    expect(escapeHtml('<script>alert("XSS")</script>')).toBe(
      '&lt;script&gt;alert(&quot;XSS&quot;)&lt;/script&gt;'
    )
  })

  test('handles null and undefined by returning empty string', () => {
    expect(escapeHtml(null)).toBe('')
    expect(escapeHtml(undefined)).toBe('')
  })

  test('converts non-string inputs to string before escaping', () => {
    expect(escapeHtml(123)).toBe('123')
    expect(escapeHtml({})).toContain('object')
  })

  test('leaves normal text unchanged', () => {
    expect(escapeHtml('Hello World')).toBe('Hello World')
  })
})

// ---------------------------------------------------------------------------
// buildDeploySuccessHtml
// ---------------------------------------------------------------------------

describe('buildDeploySuccessHtml', () => {
  test('returns empty string for non-array input', () => {
    expect(buildDeploySuccessHtml(null)).toBe('')
    expect(buildDeploySuccessHtml(undefined)).toBe('')
    expect(buildDeploySuccessHtml('not-an-array')).toBe('')
  })

  test('builds success HTML for single deployed project', () => {
    const projects = [
      { scriptId: 'abc123', title: 'My Script', catalogId: 'test' },
    ]
    const html = buildDeploySuccessHtml(projects)

    expect(html).toContain('✅')
    expect(html).toContain('Script deployed!')
    expect(html).toContain('My Script')
    expect(html).toContain('https://script.google.com/d/abc123/edit')
    expect(html).toContain('Now configure each script below')
  })

  test('builds success HTML for multiple deployed projects', () => {
    const projects = [
      { scriptId: 'id1', title: 'Script 1', catalogId: 'test1' },
      { scriptId: 'id2', title: 'Script 2', catalogId: 'test2' },
      { scriptId: 'id3', title: 'Script 3', catalogId: 'test3' },
    ]
    const html = buildDeploySuccessHtml(projects)

    expect(html).toContain('3 scripts deployed!')
    expect(html).toContain('Script 1')
    expect(html).toContain('Script 2')
    expect(html).toContain('Script 3')
  })

  test('escapes HTML in project titles', () => {
    const projects = [
      {
        scriptId: 'id',
        title: '<script>alert("xss")</script>',
        catalogId: 'test',
      },
    ]
    const html = buildDeploySuccessHtml(projects)

    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  test('escapes HTML in script IDs', () => {
    const projects = [
      {
        scriptId: '<img src=x onerror=alert(1)>',
        title: 'My Script',
        catalogId: 'test',
      },
    ]
    const html = buildDeploySuccessHtml(projects)

    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
  })

  test('includes deployed successfully styling for each project', () => {
    const projects = [
      { scriptId: 'id1', title: 'Script 1', catalogId: 'test1' },
      { scriptId: 'id2', title: 'Script 2', catalogId: 'test2' },
    ]
    const html = buildDeploySuccessHtml(projects)

    expect(html.match(/Deployed successfully/g) || []).toHaveLength(2)
  })

  test('handles empty array with 0 scripts message', () => {
    const html = buildDeploySuccessHtml([])
    expect(html).toContain('0 scripts deployed!')
  })
})

// ---------------------------------------------------------------------------
// buildDeployErrorHtml
// ---------------------------------------------------------------------------

describe('buildDeployErrorHtml', () => {
  test('returns error message for null input', () => {
    const html = buildDeployErrorHtml(null)
    expect(html).toContain('❌')
    expect(html).toContain('Unknown error')
  })

  test('builds error HTML from error message', () => {
    const err = new Error('Something went wrong')
    const html = buildDeployErrorHtml(err)

    expect(html).toContain('❌')
    expect(html).toContain('Deployment failed')
    expect(html).toContain('Something went wrong')
  })

  test('escapes error message to prevent XSS', () => {
    const err = new Error('<script>alert("xss")</script>')
    const html = buildDeployErrorHtml(err)

    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  test('includes error detail block with stack trace', () => {
    const err = new Error('Test error')
    err.stack = 'Error: Test error\n  at line 42'
    const html = buildDeployErrorHtml(err)

    expect(html).toContain('<details')
    expect(html).toContain('Error detail')
    expect(html).toContain('at line 42')
  })

  test('falls back to message if stack is unavailable', () => {
    const err = new Error('Just a message')
    const html = buildDeployErrorHtml(err)

    expect(html).toContain('Just a message')
  })

  test('detects Apps Script API disabled error', () => {
    const err = new Error('The following error occurred: Apps Script API...')
    const html = buildDeployErrorHtml(err)

    expect(html).toContain('User has not enabled the Apps Script API')
    expect(html).toContain('script.google.com/home/usersettings')
    expect(html).toContain('Enable it at')
    expect(html).toContain('wait a minute then try again')
  })

  test('includes copy button for error details', () => {
    const err = new Error('Test error')
    const html = buildDeployErrorHtml(err)

    expect(html).toContain('Copy error')
    expect(html).toContain('copy-btn')
  })

  test('copy button writes data-copy verbatim and never re-parses it as HTML', () => {
    const err = new Error('<script>alert("xss")</script>')
    const html = buildDeployErrorHtml(err)

    // data-copy holds the HTML-escaped value so the attribute is safe to insert
    expect(html).toContain('data-copy="')
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>')
    // The parser already decodes the attribute, so the handler copies it as-is (#595)
    expect(html).toContain(
      'onclick="navigator.clipboard.writeText(this.dataset.copy).catch(()=>{})"'
    )
    expect(html).not.toContain('innerHTML')
    expect(html).not.toContain('textContent')
  })

  test('deploy/index.html inlined copy handler never re-parses error text (#595)', () => {
    const page = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', 'deploy', 'index.html'),
      'utf8'
    )

    expect(page).toContain('navigator.clipboard.writeText(this.dataset.copy)')
    expect(page).not.toMatch(/innerHTML\s*=\s*this\.dataset\.copy/)
  })

  test('handles errors with string representation', () => {
    const err = { message: 'Object error' }
    const html = buildDeployErrorHtml(err)

    expect(html).toContain('Object error')
  })
})

// ---------------------------------------------------------------------------
// APPS_SCRIPT_API_BASE constant
// ---------------------------------------------------------------------------

describe('APPS_SCRIPT_API_BASE', () => {
  test('points to the correct Google API endpoint', () => {
    expect(APPS_SCRIPT_API_BASE).toBe('https://script.googleapis.com/v1')
  })
})
