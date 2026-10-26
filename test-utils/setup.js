// Basic globals to emulate small parts of the Apps Script runtime used in tests
global.Session = {
  getScriptTimeZone: () => 'UTC',
}

global.Utilities = {
  formatDate: (date, tz, format) => {
    const d = new Date(date)
    if (format === 'yyyy-MM-dd') {
      return d.toISOString().slice(0, 10)
    }
    if (format === 'h:mm a') {
      const h = d.getUTCHours()
      const m = d.getUTCMinutes()
      const ampm = h >= 12 ? 'PM' : 'AM'
      const h12 = h % 12 || 12
      return `${h12}:${String(m).padStart(2, '0')} ${ampm}`
    }
    return d.toISOString()
  },
  // Provide a simple sleep stub used in code
  sleep: (ms) => {},
  // Mock digest hash computation (MD5 and SHA-256)
  computeDigest: (algorithm, bytes) => {
    // Simple deterministic hash for testing
    // Convert bytes to a string and create a fake hash
    const crypto = require('node:crypto')
    const algo =
      algorithm && String(algorithm).toUpperCase().includes('SHA')
        ? 'sha256'
        : 'md5'
    const hash = crypto.createHash(algo).update(Buffer.from(bytes)).digest()
    // Return as array of numbers (like GAS does)
    return Array.from(hash)
  },
  DigestAlgorithm: {
    MD5: 'MD5',
    SHA_256: 'SHA_256',
  },
  Charset: {
    US_ASCII: 'US-ASCII',
    UTF_8: 'UTF-8',
  },
  newBlob: (data, contentType, name) => {
    let buf
    if (Buffer.isBuffer(data)) {
      buf = data
    } else if (Array.isArray(data)) {
      buf = Buffer.from(data)
    } else if (typeof data === 'string') {
      buf = Buffer.from(data, 'utf8')
    } else {
      buf = Buffer.from(data || '')
    }
    return {
      getBytes: () => Array.from(buf),
      getDataAsString: (charset) => {
        if (charset === 'US-ASCII' || charset === 'ASCII') {
          return Array.from(buf, (byte) =>
            byte <= 0x7f ? String.fromCharCode(byte) : '\uFFFD'
          ).join('')
        }
        return buf.toString('utf8')
      },
      getName: () => name || 'blob',
      getContentType: () => contentType || 'application/octet-stream',
    }
  },
  base64Encode: (data, charset) => {
    if (typeof data === 'string') {
      if (charset === 'UTF-8' || charset === 'utf-8') {
        return Buffer.from(data, 'utf8').toString('base64')
      }
      let asciiStr = ''
      for (let i = 0; i < data.length; i++) {
        const code = data.charCodeAt(i)
        asciiStr += code > 127 ? '?' : data[i]
      }
      return Buffer.from(asciiStr, 'ascii').toString('base64')
    }
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
    return buf.toString('base64')
  },
  base64Decode: (encoded, charset) => {
    const buf = Buffer.from(encoded || '', 'base64')
    if (charset === 'US-ASCII' || charset === 'ASCII') {
      return Array.from(buf, (byte) =>
        byte <= 0x7f ? String.fromCharCode(byte) : '\uFFFD'
      ).join('')
    }
    if (charset === 'UTF-8' || charset === 'utf-8') {
      return buf.toString('utf8')
    }
    return Array.from(buf)
  },
}

global.Logger = {
  log: () => {},
}

// Install richer mocks for GmailApp, DriveApp and DocumentApp
const { installGlobals, resetAll } = require('./mocks')
installGlobals(global)

afterEach(() => resetAll(global))
