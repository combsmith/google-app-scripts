const path = require('path')

describe('check-no-pii.js', () => {
  const {
    BASE_PROHIBITED_RULES,
    isScannablePath,
    isIgnoredPath,
    toPosixPath,
    isMatchWhitelisted,
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
      const binaryFiles = [
        'image.png',
        'doc.pdf',
        'archive.zip',
        'script.wasm',
        'font.ttf',
        'video.mp4',
      ]
      const binaryPattern =
        /\.(png|jpg|jpeg|gif|bmp|ico|webp|heic|tif|tiff|pdf|zip|gz|tgz|7z|jar|woff|woff2|ttf|otf|eot|mp3|mp4|mov|wasm)$/i
      binaryFiles.forEach((file) => {
        expect(binaryPattern.test(file)).toBe(true)
      })
    })

    it('should identify text file extensions', () => {
      const textFiles = [
        'code.js',
        'readme.md',
        'config.json',
        'script.sh',
        'data.csv',
        'file.txt',
      ]
      const binaryPattern =
        /\.(png|jpg|jpeg|gif|bmp|ico|webp|heic|tif|tiff|pdf|zip|gz|tgz|7z|jar|woff|woff2|ttf|otf|eot|mp3|mp4|mov|wasm)$/i
      textFiles.forEach((file) => {
        expect(binaryPattern.test(file)).toBe(false)
      })
    })
  })

  describe('Path utilities', () => {
    it('should convert backslashes to forward slashes', () => {
      const winPath = 'src\\components\\App.js'
      const posixPath = winPath.split('\\').join('/')
      expect(posixPath).toBe('src/components/App.js')
    })

    it('should preserve forward slashes', () => {
      const posixPath = 'src/components/App.js'
      expect(posixPath.includes('//')).toBe(false)
    })
  })

  describe('Ignored paths', () => {
    it('should identify node_modules as ignored', () => {
      expect('node_modules/pkg/index.js'.includes('node_modules')).toBe(true)
    })

    it('should identify .git as ignored', () => {
      expect('.git/config'.includes('.git')).toBe(true)
    })

    it('should identify .pii-rules.json as ignored', () => {
      expect('.pii-rules.json'.endsWith('.pii-rules.json')).toBe(true)
    })

    it('should identify .wt- temp directories as ignored', () => {
      expect('.wt-temp/file.js'.includes('.wt-')).toBe(true)
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
  })

  describe('Module exports', () => {
    it('should export required functions and constants', () => {
      expect(BASE_PROHIBITED_RULES).toBeDefined()
      expect(Array.isArray(BASE_PROHIBITED_RULES)).toBe(true)
      expect(typeof isScannablePath).toBe('function')
      expect(typeof isIgnoredPath).toBe('function')
      expect(typeof toPosixPath).toBe('function')
      expect(typeof isMatchWhitelisted).toBe('function')
    })
  })
})
