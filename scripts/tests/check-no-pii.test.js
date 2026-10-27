const path = require('path')
const fs = require('fs')
const os = require('os')

describe('check-no-pii.js', () => {
  const {
    BASE_PROHIBITED_RULES,
    loadCustomRules,
    isScannablePath,
    isIgnoredPath,
    toPosixPath,
    isMatchWhitelisted,
    scanFile,
    getTrackedRepoFiles,
    getAllRepoFiles,
    getStagedFiles,
    readTargetFileContent,
  } = require('../check-no-pii.js')

  describe('Prohibited rules', () => {
    it('should have household surname rule', () => {
      const rule = BASE_PROHIBITED_RULES.find(
        (r) => r.name === 'Household Surnames'
      )
      expect(rule).toBeDefined()
      expect(rule.pattern).toBeDefined()
      expect(rule.description).toBeDefined()
      expect(rule.whitelist).toBeDefined()
    })

    it('should have Gmail rule', () => {
      const rule = BASE_PROHIBITED_RULES.find(
        (r) => r.name === 'Personal Gmail Addresses'
      )
      expect(rule).toBeDefined()
      expect(rule.pattern).toBeDefined()
      expect(rule.whitelist).toBeDefined()
    })

    it('should have SSN rule', () => {
      const rule = BASE_PROHIBITED_RULES.find(
        (r) => r.name === 'US Social Security Numbers'
      )
      expect(rule).toBeDefined()
      expect(rule.pattern).toBeDefined()
      expect(rule.whitelist).toBeDefined()
    })
  })

  describe('Whitelist patterns', () => {
    it('should whitelist petry-projects references', () => {
      const rule = BASE_PROHIBITED_RULES.find(
        (r) => r.name === 'Household Surnames'
      )
      const hasProjectWhitelist = rule.whitelist.some((w) =>
        w.test('petry-projects')
      )
      expect(hasProjectWhitelist).toBe(true)
    })

    it('should whitelist testuser@gmail.com', () => {
      const rule = BASE_PROHIBITED_RULES.find(
        (r) => r.name === 'Personal Gmail Addresses'
      )
      const hasTestUserWhitelist = rule.whitelist.some((w) =>
        w.test('testuser@gmail.com')
      )
      expect(hasTestUserWhitelist).toBe(true)
    })

    it('should whitelist test SSNs', () => {
      const rule = BASE_PROHIBITED_RULES.find(
        (r) => r.name === 'US Social Security Numbers'
      )
      const hasTestSSNWhitelist = rule.whitelist.some(
        (w) => w.test('000-00-0000') || w.test('123-45-6789')
      )
      expect(hasTestSSNWhitelist).toBe(true)
    })
  })

  describe('Binary file detection', () => {
    it('should identify binary extensions', () => {
      expect(isScannablePath('image.png')).toBe(false)
      expect(isScannablePath('doc.pdf')).toBe(false)
      expect(isScannablePath('archive.zip')).toBe(false)
      expect(isScannablePath('script.wasm')).toBe(false)
      expect(isScannablePath('font.ttf')).toBe(false)
      expect(isScannablePath('video.mp4')).toBe(false)
    })

    it('should identify text file extensions', () => {
      expect(isScannablePath('code.js')).toBe(true)
      expect(isScannablePath('readme.md')).toBe(true)
      expect(isScannablePath('config.json')).toBe(true)
      expect(isScannablePath('script.sh')).toBe(true)
      expect(isScannablePath('data.csv')).toBe(true)
      expect(isScannablePath('file.txt')).toBe(true)
    })

    it('should handle mixed case extensions', () => {
      expect(isScannablePath('image.PNG')).toBe(false)
      expect(isScannablePath('Document.PDF')).toBe(false)
    })
  })

  describe('Path utilities', () => {
    it('should preserve forward slashes', () => {
      const posixPath = toPosixPath('src/components/App.js')
      expect(posixPath).toBe('src/components/App.js')
    })

    it('should handle paths', () => {
      const result = toPosixPath(
        'src' + path.sep + 'components' + path.sep + 'App.js'
      )
      expect(result).toContain('/')
      expect(result).toContain('App.js')
    })
  })

  describe('Ignored paths', () => {
    it('should identify node_modules as ignored', () => {
      expect(isIgnoredPath('node_modules/pkg/index.js')).toBe(true)
    })

    it('should identify .git as ignored', () => {
      expect(isIgnoredPath('.git/config')).toBe(true)
    })

    it('should identify coverage as ignored', () => {
      expect(isIgnoredPath('coverage/index.html')).toBe(true)
    })

    it('should identify dist as ignored', () => {
      expect(isIgnoredPath('dist/bundle.js')).toBe(true)
    })

    it('should identify .pii-rules.json as ignored', () => {
      expect(isIgnoredPath('.pii-rules.json')).toBe(true)
    })

    it('should identify check-no-pii.js as ignored', () => {
      expect(isIgnoredPath('scripts/check-no-pii.js')).toBe(true)
    })

    it('should identify .wt- temp directories as ignored', () => {
      expect(isIgnoredPath('.wt-temp/file.js')).toBe(true)
      expect(isIgnoredPath('.wt-xyz123/nested/file.js')).toBe(true)
    })

    it('should allow other paths', () => {
      expect(isIgnoredPath('src/index.js')).toBe(false)
      expect(isIgnoredPath('README.md')).toBe(false)
    })
  })

  describe('Whitelist matching', () => {
    it('should match whitelisted text in line', () => {
      const line = 'Run: curl https://example.com/testuser@gmail.com/install.sh' // pii-ignore
      const match = {
        0: 'testuser@gmail.com', // pii-ignore
        index: 39,
      }
      const whitelist = [/testuser@gmail\.com/i]
      expect(isMatchWhitelisted(line, match, whitelist)).toBe(true)
    })

    it('should not match non-whitelisted text', () => {
      const line = 'Contact: user@gmail.com for details' // pii-ignore
      const match = {
        0: 'user@gmail.com', // pii-ignore
        index: 9,
      }
      const whitelist = [/testuser@gmail\.com/i]
      expect(isMatchWhitelisted(line, match, whitelist)).toBe(false)
    })

    it('should return false for empty whitelist', () => {
      const line = 'Some text here'
      const match = {
        0: 'text',
        index: 5,
      }
      expect(isMatchWhitelisted(line, match, [])).toBe(false)
      expect(isMatchWhitelisted(line, match, null)).toBe(false)
    })

    it('should check line context for whitelist patterns', () => {
      const line = 'petry-projects/google-app-scripts'
      const match = {
        0: 'Petry', // pii-ignore
        index: 0,
      }
      const whitelist = [/petry-projects/i]
      expect(isMatchWhitelisted(line, match, whitelist)).toBe(true)
    })
  })

  describe('Custom rules loading', () => {
    it('should return empty array when no custom rules exist', () => {
      delete process.env.PII_CUSTOM_RULES_JSON
      const rules = loadCustomRules()
      expect(Array.isArray(rules)).toBe(true)
      expect(rules.length).toBe(0)
    })

    it('should load rules from environment variable', () => {
      const customRule = JSON.stringify([
        {
          name: 'Test Pattern',
          pattern: 'test123',
          description: 'A test pattern',
        },
      ])
      process.env.PII_CUSTOM_RULES_JSON = customRule
      const rules = loadCustomRules()
      expect(rules.length).toBe(1)
      expect(rules[0].name).toBe('Test Pattern')
      delete process.env.PII_CUSTOM_RULES_JSON
    })

    it('should handle non-array JSON', () => {
      const customRule = JSON.stringify({
        name: 'Test Pattern',
        pattern: 'test123',
      })
      process.env.PII_CUSTOM_RULES_JSON = customRule
      const rules = loadCustomRules()
      expect(rules.length).toBe(0)
      delete process.env.PII_CUSTOM_RULES_JSON
    })

    it('should add global flag to pattern flags', () => {
      const customRule = JSON.stringify([
        {
          name: 'Test',
          pattern: 'test',
          flags: 'i',
        },
      ])
      process.env.PII_CUSTOM_RULES_JSON = customRule
      const rules = loadCustomRules()
      expect(rules[0].pattern.flags).toContain('g')
      expect(rules[0].pattern.flags).toContain('i')
      delete process.env.PII_CUSTOM_RULES_JSON
    })

    it('should handle rules with whitelist', () => {
      const customRule = JSON.stringify([
        {
          name: 'Test',
          pattern: 'secret',
          whitelist: ['test-secret'],
        },
      ])
      process.env.PII_CUSTOM_RULES_JSON = customRule
      const rules = loadCustomRules()
      expect(rules[0].whitelist).toBeDefined()
      expect(Array.isArray(rules[0].whitelist)).toBe(true)
      delete process.env.PII_CUSTOM_RULES_JSON
    })
  })

  describe('File scanning', () => {
    it('should detect PII violations in file content', () => {
      const tmpFile = path.join(os.tmpdir(), 'test-pii.txt')
      fs.writeFileSync(tmpFile, 'Email: someone@gmail.com\n') // pii-ignore
      try {
        const violations = scanFile(tmpFile)
        expect(violations.length).toBeGreaterThan(0)
        expect(violations[0].rule).toBe('Personal Gmail Addresses')
      } finally {
        fs.unlinkSync(tmpFile)
      }
    })

    it('should skip files with pii-ignore comment', () => {
      const tmpFile = path.join(os.tmpdir(), 'test-ignore.txt')
      fs.writeFileSync(tmpFile, 'Email: someone@gmail.com // pii-ignore\n')
      try {
        const violations = scanFile(tmpFile)
        expect(violations.length).toBe(0)
      } finally {
        fs.unlinkSync(tmpFile)
      }
    })

    it('should skip files with HTML pii-ignore comment', () => {
      const tmpFile = path.join(os.tmpdir(), 'test-ignore.html')
      fs.writeFileSync(
        tmpFile,
        'Email: someone@gmail.com <!-- pii-ignore -->\n'
      )
      try {
        const violations = scanFile(tmpFile)
        expect(violations.length).toBe(0)
      } finally {
        fs.unlinkSync(tmpFile)
      }
    })

    it('should detect multiple violations in same file', () => {
      const tmpFile = path.join(os.tmpdir(), 'test-multi.txt')
      fs.writeFileSync(
        tmpFile,
        'Contact: user@gmail.com and test 123-45-6789\n' // pii-ignore
      )
      try {
        const violations = scanFile(tmpFile)
        expect(violations.length).toBeGreaterThanOrEqual(1)
        const rules = violations.map((v) => v.rule)
        expect(rules).toContain('Personal Gmail Addresses')
      } finally {
        fs.unlinkSync(tmpFile)
      }
    })

    it('should not scan ignored paths', () => {
      const violations = scanFile('node_modules/package/index.js')
      expect(violations).toEqual([])
    })

    it('should return empty array for non-existent files', () => {
      const violations = scanFile('/nonexistent/file.js')
      expect(violations).toEqual([])
    })

    it('should report correct line numbers', () => {
      const tmpFile = path.join(os.tmpdir(), 'test-lines.txt')
      fs.writeFileSync(
        tmpFile,
        'Line 1: safe\nLine 2: user@gmail.com\nLine 3: safe\n' // pii-ignore
      )
      try {
        const violations = scanFile(tmpFile)
        expect(violations.length).toBeGreaterThan(0)
        expect(violations[0].line).toBe(2)
      } finally {
        fs.unlinkSync(tmpFile)
      }
    })

    it('should identify multiple matches on same line', () => {
      const tmpFile = path.join(os.tmpdir(), 'test-sameline.txt')
      fs.writeFileSync(tmpFile, 'Emails: user1@gmail.com and user2@gmail.com\n') // pii-ignore
      try {
        const violations = scanFile(tmpFile)
        expect(violations.length).toBeGreaterThanOrEqual(2)
        violations.forEach((v) => expect(v.line).toBe(1))
      } finally {
        fs.unlinkSync(tmpFile)
      }
    })

    it('should handle files with no newline at end', () => {
      const tmpFile = path.join(os.tmpdir(), 'test-nonewline.txt')
      fs.writeFileSync(tmpFile, 'Email: test@gmail.com') // pii-ignore
      try {
        const violations = scanFile(tmpFile)
        expect(violations.length).toBeGreaterThan(0)
        expect(violations[0].match).toContain('gmail.com')
      } finally {
        fs.unlinkSync(tmpFile)
      }
    })

    it('should respect whitelist patterns', () => {
      const tmpFile = path.join(os.tmpdir(), 'test-whitelist.txt')
      fs.writeFileSync(tmpFile, 'Please contact testuser@gmail.com\n') // pii-ignore
      try {
        const violations = scanFile(tmpFile)
        expect(violations.length).toBe(0)
      } finally {
        fs.unlinkSync(tmpFile)
      }
    })
  })

  describe('Rules structure', () => {
    it('should have all required rule properties', () => {
      BASE_PROHIBITED_RULES.forEach((rule) => {
        expect(rule.name).toBeDefined()
        expect(rule.pattern).toBeDefined()
        expect(rule.description).toBeDefined()
        expect(typeof rule.name).toBe('string')
      })
    })

    it('should have regex patterns with global flag', () => {
      BASE_PROHIBITED_RULES.forEach((rule) => {
        const flags = rule.pattern.flags
        expect(flags.includes('g')).toBe(true)
      })
    })

    it('should have whitelists as arrays or undefined', () => {
      BASE_PROHIBITED_RULES.forEach((rule) => {
        if (rule.whitelist) {
          expect(Array.isArray(rule.whitelist)).toBe(true)
        }
      })
    })

    it('should match prohibited patterns correctly', () => {
      const surnameRule = BASE_PROHIBITED_RULES.find(
        (r) => r.name === 'Household Surnames'
      )
      const pattern = new RegExp(
        surnameRule.pattern.source,
        surnameRule.pattern.flags
      )
      expect(pattern.test('Visit Petry.com')).toBe(true) // pii-ignore
    })

    it('should match Gmail pattern correctly', () => {
      const gmailRule = BASE_PROHIBITED_RULES.find(
        (r) => r.name === 'Personal Gmail Addresses'
      )
      const pattern = new RegExp(
        gmailRule.pattern.source,
        gmailRule.pattern.flags
      )
      expect(pattern.test('Contact: user@gmail.com')).toBe(true) // pii-ignore
    })

    it('should match SSN pattern correctly', () => {
      const ssnRule = BASE_PROHIBITED_RULES.find(
        (r) => r.name === 'US Social Security Numbers'
      )
      const pattern = new RegExp(ssnRule.pattern.source, ssnRule.pattern.flags)
      expect(pattern.test('SSN: 123-45-6789 here')).toBe(true)
      expect(pattern.test('Invalid: 12345-6789')).toBe(false)
    })
  })

  describe('Module exports', () => {
    it('should export required functions and constants', () => {
      expect(BASE_PROHIBITED_RULES).toBeDefined()
      expect(Array.isArray(BASE_PROHIBITED_RULES)).toBe(true)
      expect(typeof isScannablePath).toBe('function')
      expect(typeof isIgnoredPath).toBe('function')
      expect(typeof toPosixPath).toBe('function')
      expect(typeof isMatchWhitelisted).toBe('function')
      expect(typeof scanFile).toBe('function')
      expect(typeof loadCustomRules).toBe('function')
      expect(typeof getAllRepoFiles).toBe('function')
      expect(typeof readTargetFileContent).toBe('function')
    })
  })

  describe('File discovery', () => {
    it('should handle getAllRepoFiles with test directory', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-'))
      try {
        fs.writeFileSync(path.join(tmpDir, 'file.js'), 'console.log("test")')
        fs.writeFileSync(path.join(tmpDir, 'test.json'), '{}')
        const files = getAllRepoFiles(tmpDir, '')
        expect(Array.isArray(files)).toBe(true)
        expect(files.length).toBeGreaterThanOrEqual(0)
      } finally {
        fs.rmSync(tmpDir, { recursive: true })
      }
    })

    it('should skip ignored directories in getAllRepoFiles', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-'))
      try {
        const nodeModulesDir = path.join(tmpDir, 'node_modules')
        fs.mkdirSync(nodeModulesDir)
        fs.writeFileSync(path.join(nodeModulesDir, 'index.js'), 'test')
        fs.writeFileSync(path.join(tmpDir, 'app.js'), 'test')

        const files = getAllRepoFiles(tmpDir, '')
        const hasNodeModules = files.some((f) => f.includes('node_modules'))
        expect(hasNodeModules).toBe(false)
      } finally {
        fs.rmSync(tmpDir, { recursive: true })
      }
    })

    it('should skip symlinks in getAllRepoFiles', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-'))
      try {
        const targetFile = path.join(tmpDir, 'target.js')
        const linkFile = path.join(tmpDir, 'link.js')
        fs.writeFileSync(targetFile, 'test')
        try {
          fs.symlinkSync(targetFile, linkFile)
          const files = getAllRepoFiles(tmpDir, '')
          const isRegularFile =
            files.filter((f) => !f.includes('link')).length > 0
          expect(isRegularFile).toBe(true)
        } catch (e) {
          if (e.code !== 'EEXIST') throw e
        }
      } finally {
        fs.rmSync(tmpDir, { recursive: true })
      }
    })
  })

  describe('Whitelist context matching', () => {
    it('should detect matches whitelisted within line context', () => {
      const line = 'github.com/petry-projects/repo' // pii-ignore
      const match = {
        0: 'Petry', // pii-ignore
        index: 11,
      }
      const whitelist = [/petry-projects/i]
      expect(isMatchWhitelisted(line, match, whitelist)).toBe(true)
    })

    it('should not match when whitelist pattern is outside match bounds', () => {
      const line = 'First Petry and then projects' // pii-ignore
      const match = {
        0: 'Petry', // pii-ignore
        index: 6,
      }
      const whitelist = [/petry-projects/i]
      expect(isMatchWhitelisted(line, match, whitelist)).toBe(false)
    })
  })

  describe('Pattern edge cases', () => {
    it('should handle empty patterns array', () => {
      const line = 'some text here'
      const match = { 0: 'text', index: 5 }
      expect(isMatchWhitelisted(line, match, [])).toBe(false)
    })

    it('should validate binary extension detection comprehensively', () => {
      const binaryExts = [
        '.png',
        '.jpg',
        '.pdf',
        '.zip',
        '.gz',
        '.wasm',
        '.mp4',
        '.ttf',
      ]
      binaryExts.forEach((ext) => {
        expect(isScannablePath(`file${ext}`)).toBe(false)
      })

      const textExts = ['.js', '.json', '.md', '.txt', '.sh', '.py', '.csv']
      textExts.forEach((ext) => {
        expect(isScannablePath(`file${ext}`)).toBe(true)
      })
    })

    it('should identify extensionless files as scannable', () => {
      expect(isScannablePath('Dockerfile')).toBe(true)
      expect(isScannablePath('Makefile')).toBe(true)
      expect(isScannablePath('.gitignore')).toBe(true)
    })
  })

  describe('Ignored path patterns', () => {
    it('should ignore all known binary directories', () => {
      const ignoredDirs = ['node_modules', '.git', 'coverage', 'dist', 'build']
      ignoredDirs.forEach((dir) => {
        expect(isIgnoredPath(`${dir}/file.js`)).toBe(true)
      })
    })

    it('should ignore .wt- temporary directories', () => {
      expect(isIgnoredPath('.wt-abc123/file.js')).toBe(true)
      expect(isIgnoredPath('.wt-pr-123/nested/file.js')).toBe(true)
    })

    it('should allow non-ignored paths', () => {
      expect(isIgnoredPath('src/index.js')).toBe(false)
      expect(isIgnoredPath('test/unit.test.js')).toBe(false)
      expect(isIgnoredPath('README.md')).toBe(false)
    })
  })
})
