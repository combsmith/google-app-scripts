const {
  appendMarkdownEntryToGitHubRepo,
  executeGitHubCommit,
  extractTopicTitleFromPath,
  insertEntryIntoLogSection,
  assertClean_,
  assertNoAsciiReplacement_,
  RULE6_PATTERNS,
  formatProgressiveDisclosureEntry,
  getNotePathForDomain,
  getSearchDateRange_,
} = require('../src/index.js')

describe('GitHub Sync & Rule 6 Mojibake Guards', () => {
  // -------------------------------------------------------------------------
  // RULE6_PATTERNS & assertClean_
  // -------------------------------------------------------------------------
  describe('RULE6_PATTERNS', () => {
    test('defines all required mojibake detection patterns and messages', () => {
      expect(Array.isArray(RULE6_PATTERNS)).toBe(true)
      expect(RULE6_PATTERNS).toHaveLength(4)
      RULE6_PATTERNS.forEach(([regex, message]) => {
        expect(regex).toBeInstanceOf(RegExp)
        expect(typeof message).toBe('string')
      })
    })
  })

  describe('assertClean_', () => {
    test('passes on clean strings containing non-ASCII UTF-8 characters', () => {
      const cleanSamples = [
        '### 2026-09-12 — PayPal Payment Receipt: Cloudflare Inc',
        '- **Subject**: Don’t forget your $10.46\u00A0USD receipt · Monthly update',
        'Status: ✅ Verified 🐝 Apiary Alert 🚀 Deployed',
        'Normal ASCII text with no special characters',
        'Empty text should pass',
      ]
      cleanSamples.forEach((text) => {
        expect(() => assertClean_(text, 'clean sample')).not.toThrow()
      })
    })

    test('passes on null or empty input', () => {
      expect(() => assertClean_(null, 'null input')).not.toThrow()
      expect(() => assertClean_('', 'empty input')).not.toThrow()
    })

    test('passes on genuine question marks and URLs with query parameters', () => {
      const genuineQuestions = [
        'Did you sign in from a new device?',
        'Is this payment expected? (Yes/No)',
        'What? Are you sure?',
        'Can we meet today? Thanks!',
        'Questions? Contact support@example.com.',
        'View invoice at https://example.com/view?token=abc&mode=pdf or [Attachment](https://drive.google.com/file/d/123/view?usp=sharing)',
      ]
      genuineQuestions.forEach((text) => {
        expect(() => assertClean_(text, 'genuine question')).not.toThrow()
      })
    })

    test('throws on "\\S \\? \\S" pattern (flattened em dash or middle dot)', () => {
      expect(() =>
        assertClean_('2026-09-12 ? PayPal Receipt', 'flattened heading')
      ).toThrow(/Rule 6.*' \? ' between words/)

      expect(() =>
        assertClean_('Item 1 ? Item 2', 'flattened dot separator')
      ).toThrow(/Rule 6.*' \? ' between words/)
    })

    test('throws on "??" pattern (flattened multi-byte emoji)', () => {
      expect(() =>
        assertClean_('Notification ?? Alert received', 'flattened emoji')
      ).toThrow(/Rule 6.*'\?\?'/)
    })

    test('throws on "[A-Za-z]\\?[A-Za-z]" pattern (flattened curly apostrophe/quote)', () => {
      expect(() =>
        assertClean_('Don?t miss this update', 'flattened apostrophe')
      ).toThrow(/Rule 6.*'\?' inside a word/)

      expect(() =>
        assertClean_('It?s ready for review', 'flattened apostrophe')
      ).toThrow(/Rule 6.*'\?' inside a word/)
    })

    test('throws on U+FFFD replacement character', () => {
      expect(() =>
        assertClean_('Bad character \uFFFD in stream', 'replacement char')
      ).toThrow(/Rule 6.*U\+FFFD/)
    })
  })

  // -------------------------------------------------------------------------
  // assertNoAsciiReplacement_
  // -------------------------------------------------------------------------
  describe('assertNoAsciiReplacement_', () => {
    test('passes when source and rendered both contain non-ASCII chars and rendered has a genuine question mark', () => {
      const source =
        'PayPal — Cloudflare Inc: $10.46\u00A0USD · Don’t miss ✅ 🐝'
      const rendered =
        '### 2026-09-12 — PayPal: $10.46\u00A0USD · Don’t miss ✅ 🐝\n' +
        '- **Subject**: Did you sign in from a new device?'
      expect(() => assertNoAsciiReplacement_(source, rendered)).not.toThrow()
    })

    test('passes when rendered contains no question marks', () => {
      const source = 'PayPal — Cloudflare Inc'
      const rendered = '### 2026-09-12 — PayPal — Cloudflare Inc'
      expect(() => assertNoAsciiReplacement_(source, rendered)).not.toThrow()
    })

    test('passes on null or empty input', () => {
      expect(() => assertNoAsciiReplacement_(null, 'text')).not.toThrow()
      expect(() => assertNoAsciiReplacement_('text', null)).not.toThrow()
      expect(() => assertNoAsciiReplacement_('', '')).not.toThrow()
    })

    test('passes when source contains only ASCII and rendered contains question marks', () => {
      const source = 'Plain ASCII subject'
      const rendered = 'Is this a question? Yes it is.'
      expect(() => assertNoAsciiReplacement_(source, rendered)).not.toThrow()
    })

    test('throws when non-ASCII characters from source are flattened to "?" in rendered', () => {
      const source = 'PayPal — Cloudflare · Don’t forget ✅ 🐝'
      const flattenedRendered = 'PayPal ? Cloudflare ? Don?t forget ?? ??'

      expect(() =>
        assertNoAsciiReplacement_(source, flattenedRendered)
      ).toThrow(
        /Rule 6: refusing to write text that flattened non-ASCII to "\?"/
      )
    })

    test('error message lists the specific lost characters', () => {
      const source = 'Costco Anywhere Visa® Card — $10.46\u00A0USD'
      const flattenedRendered = 'Costco Anywhere Visa? Card ? $10.46?USD'

      expect(() =>
        assertNoAsciiReplacement_(source, flattenedRendered)
      ).toThrow(/®/)
    })
  })

  // -------------------------------------------------------------------------
  // extractTopicTitleFromPath & insertEntryIntoLogSection
  // -------------------------------------------------------------------------
  describe('extractTopicTitleFromPath', () => {
    test('extracts and titles topic from standard nested path', () => {
      expect(
        extractTopicTitleFromPath(
          'household/technology/digital-backups/index.md'
        )
      ).toBe('Digital Backups')
      expect(extractTopicTitleFromPath('household/kids/index.md')).toBe('Kids')
      expect(extractTopicTitleFromPath('household/finances/index.md')).toBe(
        'Finances'
      )
    })

    test('handles single segment paths and strips the file extension', () => {
      expect(extractTopicTitleFromPath('digital-backups.md')).toBe(
        'Digital Backups'
      )
    })

    test('handles null, undefined, empty string, and root slash safely without throwing', () => {
      expect(extractTopicTitleFromPath(null)).toBe('Ingested Records')
      expect(extractTopicTitleFromPath(undefined)).toBe('Ingested Records')
      expect(extractTopicTitleFromPath('')).toBe('Ingested Records')
      expect(extractTopicTitleFromPath('/')).toBe('Ingested Records')
    })
  })

  describe('insertEntryIntoLogSection', () => {
    test('handles null or empty content safely without throwing', () => {
      expect(insertEntryIntoLogSection(null, 'entry')).toBe('entry')
      expect(insertEntryIntoLogSection('content', null)).toBe('content')
      expect(insertEntryIntoLogSection(null, null)).toBe('')
    })
    test('inserts entry before </details> marker when present', () => {
      const doc =
        '# Notes\n\n## 3. Ingested Activity Logs\n<details open><summary><b>Activity Logs</b></summary>\n### Older Entry\n</details>\n'
      const newEntry = '### 2026-09-12 — New Entry'
      const result = insertEntryIntoLogSection(doc, newEntry)

      expect(result).toContain(newEntry + '\n</details>')
      expect(result.indexOf(newEntry)).toBeLessThan(
        result.indexOf('</details>')
      )
    })

    test('inserts entry after "## 3. Ingested Activity" marker when </details> is absent', () => {
      const doc =
        '# Notes\n\n## 3. Ingested Activity Logs\n### Older Entry\n\n## 4. Other'
      const newEntry = '### 2026-09-12 — New Entry'
      const result = insertEntryIntoLogSection(doc, newEntry)

      const sectionIdx = result.indexOf('## 3. Ingested Activity Logs')
      const entryIdx = result.indexOf(newEntry)
      expect(entryIdx).toBeGreaterThan(sectionIdx)
    })

    test('appends entry at end of file when no markers match', () => {
      const doc = '# Just a title\nSome content'
      const newEntry = '### 2026-09-12 — New Entry'
      const result = insertEntryIntoLogSection(doc, newEntry)

      expect(result).toBe(doc + '\n' + newEntry)
    })
  })

  // -------------------------------------------------------------------------
  // formatProgressiveDisclosureEntry & getNotePathForDomain
  // -------------------------------------------------------------------------
  describe('formatProgressiveDisclosureEntry', () => {
    test('formats markdown entry with em dash in heading and all metadata fields', () => {
      const entry = formatProgressiveDisclosureEntry(
        '2026-09-12',
        'PayPal Payment Receipt: Cloudflare Inc',
        'service@paypal.com',
        'Cloudflare Inc: $10.46\u00A0USD',
        'A payment receipt confirms a successful transaction of $10.46 USD.',
        'user@example.com'
      )

      expect(entry).toContain(
        '### 2026-09-12 — PayPal Payment Receipt: Cloudflare Inc'
      )
      expect(entry).toContain('- **Account**: user@example.com')
      expect(entry).toContain('- **From**: service@paypal.com')
      expect(entry).toContain('- **Subject**: Cloudflare Inc: $10.46\u00A0USD')
      expect(entry).toContain(
        '- **Summary**:\n  > A payment receipt confirms a successful transaction of $10.46 USD.'
      )
    })

    test('handles entry without summaryText', () => {
      const entry = formatProgressiveDisclosureEntry(
        '2026-09-12',
        'Title Only',
        'sender@example.com',
        'Subject Line',
        null,
        'user@example.com'
      )

      expect(entry).toContain('### 2026-09-12 — Title Only')
      expect(entry).not.toContain('**Summary**')
    })
  })

  describe('getNotePathForDomain', () => {
    test('routes all 7 canonical domains to their correct markdown notes', () => {
      expect(getNotePathForDomain('01_Household')).toBe('01_Household/index.md')
      expect(getNotePathForDomain('02_Finance_Legal')).toBe(
        '02_Finance_Legal/index.md'
      )
      expect(getNotePathForDomain('03_Vehicles')).toBe('03_Vehicles/index.md')
      expect(getNotePathForDomain('04_Family_Health')).toBe(
        '04_Family_Health/index.md'
      )
      expect(getNotePathForDomain('05_Tech_Infrastructure')).toBe(
        '05_Tech_Infrastructure/index.md'
      )
      expect(getNotePathForDomain('06_Work_Career')).toBe(
        '06_Work_Career/index.md'
      )
      expect(getNotePathForDomain('07_Community_NonProfit')).toBe(
        '07_Community_NonProfit/index.md'
      )
      expect(getNotePathForDomain('Unknown_Domain')).toBeNull()
    })
  })

  // -------------------------------------------------------------------------
  // End-to-End UTF-8 Round-Trip Verification (Step 4 Proof)
  // -------------------------------------------------------------------------
  describe('UTF-8 Round-Trip Proof & Encoding Integrity', () => {
    test('sample note body with em dash, curly quotes, middle dot, NBSP, checkmark, and astral emoji round-trips byte-identically through real GET-decode -> append -> PUT-encode', () => {
      // 1. Initial sample note containing all critical non-ASCII UTF-8 characters and genuine question mark
      const initialDoc = [
        '---',
        'title: Digital Backups',
        'created: 2026-09-12',
        'notebook: household',
        'section: general',
        '---',
        '',
        '# Digital Backups',
        '',
        '## 1. Executive Summary & Active Status',
        '- System integrity: ✅ Verified 100% operational.',
        '- Contact: Don’t hesitate · Support available 24/7.',
        '',
        '## 2. Key References & Quick Links',
        '| Topic | Asset |',
        '| :--- | :--- |',
        '| AWS S3 | Cloud Backup Archive |',
        '',
        '## 3. Ingested Activity Logs',
        '<details open><summary><b>Activity Logs</b></summary>',
        '### 2026-09-11 — Prior Backup Verification: Cloudflare Inc',
        '- **Account**: user@example.com',
        '- **From**: "service@paypal.com" <service@paypal.com>',
        '- **Subject**: Monthly Retainer: $10.46\u00A0USD · Don’t forget',
        '- **Summary**:',
        '  > Previous backup completed successfully with 🐝 Honeybee Telemetry and 🚀 FastSync.',
        '</details>',
      ].join('\n')

      // Encode initial document as base64 (as returned by GitHub Contents API)
      const mockGitHubGetBase64 = Utilities.base64Encode(
        Utilities.newBlob(initialDoc).getBytes()
      )

      // Step A: Real GET-decode
      const decodedExistingContent = Utilities.newBlob(
        Utilities.base64Decode(mockGitHubGetBase64)
      ).getDataAsString()

      expect(decodedExistingContent).toBe(initialDoc)

      // Step B: Create and append new progressive disclosure entry
      const newEntry = formatProgressiveDisclosureEntry(
        '2026-09-12',
        'PayPal Payment Receipt: Cloudflare Inc',
        '"service@paypal.com" <service@paypal.com>',
        'Cloudflare Inc: $10.46\u00A0USD · Did you sign in from a new device?',
        'A payment receipt confirms a successful transaction for Costco Anywhere Visa® Card.',
        'user@example.com'
      )

      // Verify heading contains em dash U+2014, not '?'
      expect(newEntry).toContain(
        '### 2026-09-12 — PayPal Payment Receipt: Cloudflare Inc'
      )
      expect(newEntry).not.toContain('2026-09-12 ?')

      // Step C: Section insertion
      const updatedContent = insertEntryIntoLogSection(
        decodedExistingContent,
        newEntry
      )

      // Step D: Rule 6 assertions
      expect(() =>
        assertClean_(
          newEntry,
          'new entry for household/our-technology/digital-backups/index.md'
        )
      ).not.toThrow()
      expect(() =>
        assertClean_(
          updatedContent,
          'updated content for household/our-technology/digital-backups/index.md'
        )
      ).not.toThrow()
      expect(() =>
        assertNoAsciiReplacement_(decodedExistingContent, updatedContent)
      ).not.toThrow()

      // Step E: Real PUT-encode
      const putBase64 = Utilities.base64Encode(
        Utilities.newBlob(updatedContent).getBytes()
      )

      // Step F: Simulate next GET-decode from GitHub to prove byte-identical round trip
      const roundTrippedContent = Utilities.newBlob(
        Utilities.base64Decode(putBase64)
      ).getDataAsString()

      // Verify exact byte and character identity
      expect(roundTrippedContent).toBe(updatedContent)
      expect(Buffer.from(roundTrippedContent, 'utf8')).toEqual(
        Buffer.from(updatedContent, 'utf8')
      )

      // Verify all non-ASCII characters preserved in round-tripped content
      expect(roundTrippedContent).toContain('—') // em dash
      expect(roundTrippedContent).toContain('’') // curly apostrophe
      expect(roundTrippedContent).toContain('·') // middle dot
      expect(roundTrippedContent).toContain('\u00A0') // non-breaking space
      expect(roundTrippedContent).toContain('®') // registered trademark
      expect(roundTrippedContent).toContain('✅') // checkmark
      expect(roundTrippedContent).toContain('🐝') // astral emoji (U+1F41D)
      expect(roundTrippedContent).toContain('🚀') // astral emoji (U+1F680)
      expect(roundTrippedContent).toContain(
        'Did you sign in from a new device?'
      ) // genuine question mark

      // Verify NO mojibake was introduced
      expect(() =>
        assertClean_(roundTrippedContent, 'round-tripped content')
      ).not.toThrow()
    })

    test('demonstrates that default US_ASCII base64Encode causes mojibake and gets caught by assertNoAsciiReplacement_', () => {
      const sourceWithUtf8 =
        '### 2026-09-12 — PayPal: $10.46\u00A0USD · Don’t forget 🚀'

      // Simulate what the old broken code did: Utilities.base64Encode(string) without converting to UTF-8 bytes
      // In GAS, base64Encode(string) flattens non-ASCII chars to '?'
      const asciiFlattenedBase64 = Utilities.base64Encode(sourceWithUtf8)
      const flattenedContent = Utilities.newBlob(
        Utilities.base64Decode(asciiFlattenedBase64)
      ).getDataAsString()

      expect(flattenedContent).toContain('?')
      expect(() =>
        assertClean_(flattenedContent, 'ascii flattened text')
      ).toThrow(/Rule 6/)
      expect(() =>
        assertNoAsciiReplacement_(sourceWithUtf8, flattenedContent)
      ).toThrow(
        /Rule 6: refusing to write text that flattened non-ASCII to "\?"/
      )
    })
  })

  // -------------------------------------------------------------------------
  // executeGitHubCommit & appendMarkdownEntryToGitHubRepo
  // -------------------------------------------------------------------------
  describe('executeGitHubCommit & appendMarkdownEntryToGitHubRepo', () => {
    const originalProperties = global.PropertiesService
    const originalUrlFetchApp = global.UrlFetchApp

    beforeEach(() => {
      global.PropertiesService = {
        getScriptProperties: () => ({
          getProperty: (k) => {
            if (k === 'GITHUB_REPO_OWNER') return 'test-owner'
            if (k === 'GITHUB_REPO_NAME') return 'test-repo'
            if (k === 'GITHUB_PAT') return 'ghp_valid'
            return ''
          },
        }),
      }
    })

    afterEach(() => {
      global.PropertiesService = originalProperties
      global.UrlFetchApp = originalUrlFetchApp
    })

    test('returns false and logs when GITHUB_PAT property is not set', () => {
      global.PropertiesService = {
        getScriptProperties: () => ({
          getProperty: (k) => (k === 'GITHUB_PAT' ? null : 'test-val'),
        }),
      }

      const result = appendMarkdownEntryToGitHubRepo(
        'household/finances/index.md',
        '### 2026-09-12 — Test Entry',
        'feat(ingestion): Test'
      )
      expect(result).toBe(false)
    })

    test('fails closed and returns false when GITHUB_REPO_OWNER or GITHUB_REPO_NAME is unconfigured', () => {
      global.PropertiesService = {
        getScriptProperties: () => ({
          getProperty: (k) => (k === 'GITHUB_PAT' ? 'ghp_valid' : ''),
        }),
      }

      expect(
        appendMarkdownEntryToGitHubRepo(
          'household/finances/index.md',
          '### 2026-09-12 — Test Entry',
          'feat(ingestion): Test'
        )
      ).toBe(false)

      expect(
        executeGitHubCommit(
          'household/finances/index.md',
          '### 2026-09-12 — Test Entry',
          'feat(ingestion): Test',
          'ghp_valid'
        )
      ).toBe(false)
    })

    test('commits successfully (200 GET -> 200 PUT) with UTF-8 content', () => {
      const existingDoc =
        '# Notes\n\n## 3. Ingested Activity Logs\n<details open><summary>Logs</summary>\n### 2026-09-11 — Existing\n</details>'
      const existingBase64 = Utilities.base64Encode(
        Utilities.newBlob(existingDoc).getBytes()
      )

      let capturedPutPayload = null
      global.UrlFetchApp = {
        fetch: jest.fn((url, options) => {
          if (options.method === 'get') {
            return {
              getResponseCode: () => 200,
              getContentText: () =>
                JSON.stringify({ sha: 'abc123sha', content: existingBase64 }),
            }
          }
          if (options.method === 'put') {
            capturedPutPayload = JSON.parse(options.payload)
            return {
              getResponseCode: () => 200,
              getContentText: () =>
                JSON.stringify({ commit: { sha: 'new123' } }),
            }
          }
          return { getResponseCode: () => 400, getContentText: () => '{}' }
        }),
      }

      const entryMd =
        '### 2026-09-12 — PayPal: $10.46\u00A0USD · New Entry ✅\n- **From**: service@paypal.com'
      const commitMsg = 'feat(ingestion): PayPal: $10.46\u00A0USD'

      const success = executeGitHubCommit(
        'household/finances/index.md',
        entryMd,
        commitMsg,
        'ghp_faketoken'
      )

      expect(success).toBe(true)
      expect(capturedPutPayload).toBeDefined()
      expect(capturedPutPayload.sha).toBe('abc123sha')
      expect(capturedPutPayload.message).toBe(commitMsg)

      // Decode PUT base64 payload to verify UTF-8 contents
      const putContent = Utilities.newBlob(
        Utilities.base64Decode(capturedPutPayload.content)
      ).getDataAsString()
      expect(putContent).toContain(
        '### 2026-09-12 — PayPal: $10.46\u00A0USD · New Entry ✅'
      )
      expect(putContent).toContain('### 2026-09-11 — Existing')
    })

    test('auto-creates new note on 404 GET and commits with 201 PUT in UTF-8', () => {
      let capturedPutPayload = null
      global.UrlFetchApp = {
        fetch: jest.fn((url, options) => {
          if (options.method === 'get') {
            return {
              getResponseCode: () => 404,
              getContentText: () => JSON.stringify({ message: 'Not Found' }),
            }
          }
          if (options.method === 'put') {
            capturedPutPayload = JSON.parse(options.payload)
            return {
              getResponseCode: () => 201,
              getContentText: () =>
                JSON.stringify({ commit: { sha: 'created123' } }),
            }
          }
          return { getResponseCode: () => 400, getContentText: () => '{}' }
        }),
      }

      const entryMd = '### 2026-09-12 — Initial Log Entry'
      const success = executeGitHubCommit(
        'household/vehicles/index.md',
        entryMd,
        'feat(ingestion): Initial Vehicle Log',
        'ghp_faketoken'
      )

      expect(success).toBe(true)
      expect(capturedPutPayload).toBeDefined()
      expect(capturedPutPayload.sha).toBeUndefined() // No SHA on new file creation

      const putContent = Utilities.newBlob(
        Utilities.base64Decode(capturedPutPayload.content)
      ).getDataAsString()
      expect(putContent).toContain('title: Vehicles')
      expect(putContent).toContain('### 2026-09-12 — Initial Log Entry')
    })

    test('skips idempotently when entry is already in the document', () => {
      const existingDoc =
        '# Notes\n\n## 3. Ingested Activity Logs\n<details open><summary>Logs</summary>\n### 2026-09-12 — Already Present\n</details>'
      const existingBase64 = Utilities.base64Encode(
        Utilities.newBlob(existingDoc).getBytes()
      )

      const mockFetch = jest.fn((url, options) => {
        if (options.method === 'get') {
          return {
            getResponseCode: () => 200,
            getContentText: () =>
              JSON.stringify({ sha: 'abc123sha', content: existingBase64 }),
          }
        }
        return { getResponseCode: () => 200, getContentText: () => '{}' }
      })
      global.UrlFetchApp = { fetch: mockFetch }

      const result = executeGitHubCommit(
        'household/finances/index.md',
        '### 2026-09-12 — Already Present',
        'feat(ingestion): Already Present',
        'ghp_faketoken'
      )

      expect(result).toBe('IDEMPOTENT_SKIP')
      // Only GET should have been called, no PUT
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })

    test('returns false on SHA collision 409', () => {
      global.UrlFetchApp = {
        fetch: jest.fn((url, options) => {
          if (options.method === 'get') {
            return {
              getResponseCode: () => 200,
              getContentText: () =>
                JSON.stringify({
                  sha: 'abc123sha',
                  content: Utilities.base64Encode(
                    Utilities.newBlob('# Doc').getBytes()
                  ),
                }),
            }
          }
          if (options.method === 'put') {
            return {
              getResponseCode: () => 409,
              getContentText: () => JSON.stringify({ message: 'Conflict' }),
            }
          }
        }),
      }

      const result = executeGitHubCommit(
        'household/finances/index.md',
        '### 2026-09-12 — New Entry',
        'feat(ingestion): New Entry',
        'ghp_faketoken'
      )
      expect(result).toBe(false)
    })

    test('returns false on unexpected GET status', () => {
      global.UrlFetchApp = {
        fetch: jest.fn(() => ({
          getResponseCode: () => 500,
          getContentText: () => 'Server error',
        })),
      }

      const result = executeGitHubCommit(
        'household/finances/index.md',
        '### 2026-09-12 — New Entry',
        'feat(ingestion): New Entry',
        'ghp_faketoken'
      )
      expect(result).toBe(false)
    })

    test('refuses to commit and returns false when entry carries mojibake', () => {
      const existingDoc =
        '# Notes\n\n## 3. Ingested Activity Logs\n<details open><summary>Logs</summary>\n</details>'
      global.UrlFetchApp = {
        fetch: jest.fn((url, options) => {
          if (options.method === 'get') {
            return {
              getResponseCode: () => 200,
              getContentText: () =>
                JSON.stringify({
                  sha: 'sha1',
                  content: Utilities.base64Encode(
                    Utilities.newBlob(existingDoc).getBytes()
                  ),
                }),
            }
          }
          return { getResponseCode: () => 200, getContentText: () => '{}' }
        }),
      }

      const corruptedEntry =
        '### 2026-09-12 ? PayPal Payment Receipt: Cloudflare Inc'
      const result = executeGitHubCommit(
        'household/finances/index.md',
        corruptedEntry,
        'feat(ingestion): Corrupted',
        'ghp_faketoken'
      )

      expect(result).toBe(false)
      // GET was called, but PUT was NEVER called because assertion threw
      expect(global.UrlFetchApp.fetch).toHaveBeenCalledTimes(1)
    })

    test('appendMarkdownEntryToGitHubRepo retries up to 3 times on transient failure', () => {
      jest.useFakeTimers()
      try {
        global.PropertiesService = {
          getScriptProperties: () => ({
            getProperty: (k) => {
              if (k === 'GITHUB_PAT') return 'ghp_valid'
              if (k === 'GITHUB_REPO_OWNER') return 'test-owner'
              if (k === 'GITHUB_REPO_NAME') return 'test-repo'
              return ''
            },
          }),
        }

        let attempts = 0
        global.UrlFetchApp = {
          fetch: jest.fn((url, options) => {
            if (options.method === 'get') {
              attempts++
              if (attempts < 3) {
                return {
                  getResponseCode: () => 500,
                  getContentText: () => 'Internal Error',
                }
              }
              return {
                getResponseCode: () => 200,
                getContentText: () =>
                  JSON.stringify({
                    sha: 'sha1',
                    content: Utilities.base64Encode(
                      Utilities.newBlob(
                        '# Doc\n<details open><summary>Logs</summary>\n</details>'
                      ).getBytes()
                    ),
                  }),
              }
            }
            return {
              getResponseCode: () => 200,
              getContentText: () => JSON.stringify({ commit: { sha: 'sha2' } }),
            }
          }),
        }

        const success = appendMarkdownEntryToGitHubRepo(
          'household/finances/index.md',
          '### 2026-09-12 — Test Retry',
          'feat(ingestion): Retry'
        )

        expect(success).toBe(true)
        expect(attempts).toBe(3)
      } finally {
        jest.useRealTimers()
      }
    })

    test('returns false on an unexpected PUT status (e.g. 422)', () => {
      global.UrlFetchApp = {
        fetch: jest.fn((url, options) => {
          if (options.method === 'get') {
            return {
              getResponseCode: () => 200,
              getContentText: () =>
                JSON.stringify({
                  sha: 'abc123sha',
                  content: Utilities.base64Encode(
                    Utilities.newBlob(
                      '# Doc\n<details open><summary>Logs</summary>\n</details>'
                    ).getBytes()
                  ),
                }),
            }
          }
          return {
            getResponseCode: () => 422,
            getContentText: () => JSON.stringify({ message: 'Unprocessable' }),
          }
        }),
      }

      const result = executeGitHubCommit(
        'household/finances/index.md',
        '### 2026-09-12 — New Entry',
        'feat(ingestion): New Entry',
        'ghp_faketoken'
      )
      expect(result).toBe(false)
    })

    test('appendMarkdownEntryToGitHubRepo returns false after exhausting retries on persistent conflict', () => {
      jest.useFakeTimers()
      try {
        global.PropertiesService = {
          getScriptProperties: () => ({
            getProperty: (k) => {
              if (k === 'GITHUB_PAT') return 'ghp_valid'
              if (k === 'GITHUB_REPO_OWNER') return 'test-owner'
              if (k === 'GITHUB_REPO_NAME') return 'test-repo'
              return ''
            },
          }),
        }

        let getCalls = 0
        global.UrlFetchApp = {
          fetch: jest.fn((url, options) => {
            if (options.method === 'get') {
              getCalls++
              return {
                getResponseCode: () => 200,
                getContentText: () =>
                  JSON.stringify({
                    sha: 'sha' + getCalls,
                    content: Utilities.base64Encode(
                      Utilities.newBlob(
                        '# Doc\n<details open><summary>Logs</summary>\n</details>'
                      ).getBytes()
                    ),
                  }),
              }
            }
            // Every PUT collides (HTTP 409) -> executeGitHubCommit returns false
            return {
              getResponseCode: () => 409,
              getContentText: () => JSON.stringify({ message: 'Conflict' }),
            }
          }),
        }

        const result = appendMarkdownEntryToGitHubRepo(
          'household/finances/index.md',
          '### 2026-09-12 — Persistent Conflict',
          'feat(ingestion): Conflict'
        )

        expect(result).toBe(false)
        expect(getCalls).toBe(3) // one full GET->PUT cycle per retry attempt
      } finally {
        jest.useRealTimers()
      }
    })
  })

  // -------------------------------------------------------------------------
  // getSearchDateRange_
  // -------------------------------------------------------------------------
  describe('getSearchDateRange_', () => {
    test('computes correct after and before dates for given date and offset', () => {
      const range = getSearchDateRange_('2026-07-23', 2)
      expect(range.after).toBe('2026/07/21')
      expect(range.before).toBe('2026/07/26')
    })
  })

  // -------------------------------------------------------------------------
  // gitHubSync.gs parity with src/index.js
  // -------------------------------------------------------------------------
  describe('gitHubSync.gs parity with src/index.js', () => {
    const gitHubSyncGs = require('../gitHubSync.gs')
    const originalProperties = global.PropertiesService
    const originalUrlFetchApp = global.UrlFetchApp

    beforeEach(() => {
      global.PropertiesService = {
        getScriptProperties: () => ({
          getProperty: (k) => {
            if (k === 'GITHUB_REPO_OWNER') return 'test-owner'
            if (k === 'GITHUB_REPO_NAME') return 'test-repo'
            if (k === 'GITHUB_PAT') return 'token-xyz'
            return ''
          },
        }),
      }
    })

    afterEach(() => {
      global.PropertiesService = originalProperties
      global.UrlFetchApp = originalUrlFetchApp
    })

    test('extractTopicTitleFromPath handles single segment paths and strips file extension', () => {
      expect(gitHubSyncGs.extractTopicTitleFromPath('digital-backups.md')).toBe(
        'Digital Backups'
      )
    })

    test('executeGitHubCommit uses Bearer auth header, API version header, and URL-encoded path segments', () => {
      let capturedUrl = null
      let capturedHeaders = null
      global.UrlFetchApp = {
        fetch: jest.fn((url, options) => {
          capturedUrl = url
          capturedHeaders = options.headers
          if (options.method === 'get') {
            return {
              getResponseCode: () => 404,
              getContentText: () => '{}',
            }
          }
          return {
            getResponseCode: () => 201,
            getContentText: () => JSON.stringify({ commit: { sha: 'sha456' } }),
          }
        }),
      }

      const success = gitHubSyncGs.executeGitHubCommit(
        '01_Household/My Notes & Docs/index.md',
        '### 2026-10-15 — Test Title',
        'feat(ingestion): Test',
        'token-xyz'
      )
      expect(success).toBe(true)
      expect(capturedUrl).toBe(
        'https://api.github.com/repos/test-owner/test-repo/contents/01_Household/My%20Notes%20%26%20Docs/index.md'
      )
      expect(capturedHeaders).toMatchObject({
        Authorization: 'Bearer token-xyz',
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      })
    })

    test('executeGitHubCommit handles wrapped newlines in base64 content from GitHub Contents API', () => {
      const rawMarkdown =
        '# Ingested Logs\n## 3. Ingested Activity Logs\n<details open><summary>Logs</summary>\n</details>'
      const encoded = Buffer.from(rawMarkdown, 'utf-8').toString('base64')
      const wrappedBase64 = encoded.match(/.{1,60}/g).join('\n')

      let putPayload = null
      global.UrlFetchApp = {
        fetch: jest.fn((url, options) => {
          if (options.method === 'get') {
            return {
              getResponseCode: () => 200,
              getContentText: () =>
                JSON.stringify({
                  sha: 'sha123',
                  content: wrappedBase64,
                }),
            }
          }
          if (options.method === 'put') {
            putPayload = JSON.parse(options.payload)
            return {
              getResponseCode: () => 200,
              getContentText: () =>
                JSON.stringify({ commit: { sha: 'sha456' } }),
            }
          }
        }),
      }

      const success = gitHubSyncGs.executeGitHubCommit(
        '01_Household/index.md',
        '### 2026-10-15 — Test Title\n- **Subject**: Test',
        'feat(ingestion): Test',
        'token-xyz'
      )
      expect(success).toBe(true)
      expect(putPayload).toBeDefined()
      const decodedPut = Utilities.newBlob(
        Utilities.base64Decode(putPayload.content)
      ).getDataAsString()
      expect(decodedPut).toContain('### 2026-10-15 — Test Title')
    })

    test('executeGitHubCommit validates Base64 round trip at the payload boundary', () => {
      const existingBase64 = Utilities.base64Encode(
        Utilities.newBlob(
          '# Doc\n<details open><summary>Logs</summary>\n</details>'
        ).getBytes()
      )
      let getCalled = false
      let putCalled = false
      global.UrlFetchApp = {
        fetch: jest.fn((url, options) => {
          if (options.method === 'get') {
            getCalled = true
            return {
              getResponseCode: () => 200,
              getContentText: () =>
                JSON.stringify({
                  sha: 'sha123',
                  content: existingBase64,
                }),
            }
          }
          if (options.method === 'put') {
            putCalled = true
            return {
              getResponseCode: () => 200,
              getContentText: () =>
                JSON.stringify({ commit: { sha: 'sha456' } }),
            }
          }
        }),
      }

      let decodeCalls = 0
      jest.spyOn(Utilities, 'base64Decode').mockImplementation((b64) => {
        decodeCalls++
        const decoded = Buffer.from(b64, 'base64').toString('utf-8')
        if (decodeCalls === 1) {
          // GET decode succeeds cleanly with valid byte array
          return Array.from(Buffer.from(decoded, 'utf-8'))
        }
        // PUT round-trip verification detects ASCII-flattened mojibake
        const flattened = decoded.replace(/—/g, '?')
        return Array.from(Buffer.from(flattened, 'utf-8'))
      })

      try {
        const result = gitHubSyncGs.executeGitHubCommit(
          '01_Household/index.md',
          '### 2026-10-15 — Heading with em dash',
          'feat(ingestion): Test',
          'token-xyz'
        )
        expect(getCalled).toBe(true)
        expect(decodeCalls).toBe(2)
        expect(result).toBe(false)
        expect(putCalled).toBe(false)
      } finally {
        Utilities.base64Decode.mockRestore()
      }
    })

    test('extractTopicTitleFromPath and insertEntryIntoLogSection handle null inputs safely in gitHubSync.gs', () => {
      expect(gitHubSyncGs.extractTopicTitleFromPath(null)).toBe(
        'Ingested Records'
      )
      expect(gitHubSyncGs.extractTopicTitleFromPath(undefined)).toBe(
        'Ingested Records'
      )
      expect(gitHubSyncGs.extractTopicTitleFromPath('')).toBe(
        'Ingested Records'
      )
      expect(gitHubSyncGs.insertEntryIntoLogSection(null, 'entry')).toBe(
        'entry'
      )
      expect(gitHubSyncGs.insertEntryIntoLogSection('content', null)).toBe(
        'content'
      )
    })
  })
})
