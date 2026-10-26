const crypto = require('node:crypto')

/**
 * getCleanBody - logic ported from GAS for local testing
 */
function getCleanBody(text) {
  if (!text) return ''

  const headerPatterns = [
    /^[ \t ]*On[ \t ].+(?<=[ \t ])wrote:/m,
    /^[ \t ]*From:[ \t ].+(?<=[ \t ])Sent:[ \t ]+/m,
    /^[ \t ]*_{10,}[ \t ]*$/m,
    /confidentiality notice/im,
  ]

  let splitIndex = -1
  headerPatterns.forEach((pattern) => {
    const match = text.match(pattern)
    if (match) {
      // Prefer splitting at the start of the line containing the match
      const nlIndex = text.lastIndexOf('\n', match.index)
      const lineStart = nlIndex === -1 ? 0 : nlIndex + 1
      if (splitIndex === -1 || lineStart < splitIndex) {
        splitIndex = lineStart
      }
    }
  })

  const workingText = splitIndex !== -1 ? text.substring(0, splitIndex) : text
  const lines = workingText.split('\n')
  const cleanLines = lines.filter((line) => {
    const trimmed = line.trim()
    return !(trimmed.startsWith('>') || trimmed.startsWith('<'))
  })

  // Join lines and normalize line breaks: collapse 3+ consecutive newlines to 2
  // This preserves intentional paragraph spacing while preventing excessive blank lines in Google Docs
  let result = cleanLines.join('\n').trim()
  result = result.replace(/\n{3,}/g, '\n\n')

  return result
}

/**
 * getFileHash - compute SHA-256 hex digest of a "blob" (Buffer or object with getBytes())
 */
function getFileHash(blob) {
  let bytes
  if (Buffer.isBuffer(blob)) {
    bytes = blob
  } else if (blob && typeof blob.getBytes === 'function') {
    bytes = Buffer.from(blob.getBytes())
  } else if (blob?.bytes) {
    bytes = Buffer.from(blob.bytes)
  } else {
    throw new TypeError('Unsupported blob type')
  }

  const hash = crypto.createHash('sha256').update(bytes).digest('hex')
  return hash
}

module.exports = { getCleanBody, getFileHash }
