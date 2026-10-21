const { getCleanBody, getFileHash } = require('../../gas-utils')

describe('getCleanBody', () => {
  test('returns empty string for falsy input', () => {
    expect(getCleanBody(null)).toBe('')
    expect(getCleanBody('')).toBe('')
  })

  test('removes quoted lines starting with > and <', () => {
    const input = 'Hello\n> quoted line\n< another quote\nWorld'
    expect(getCleanBody(input)).toBe('Hello\nWorld')
  })

  test('cuts off at reply header (On ... wrote:)', () => {
    const input =
      'Line1\nOn Jan 1, 2020, John Doe <john@example.com> wrote:\nQuoted'
    expect(getCleanBody(input)).toBe('Line1')
  })

  test('cuts off at Outlook-style From:/Sent: reply header on same line', () => {
    const input =
      'My reply\nFrom: Jane Doe Sent: Monday, Jan 1, 2020 9:00 AM\nQuoted'
    expect(getCleanBody(input)).toBe('My reply')
  })

  test('does not truncate at multiline From:/Sent: (separate lines are preserved)', () => {
    const input =
      'My reply\nFrom: Jane Doe\nSent: Monday, Jan 1, 2020 9:00 AM\nQuoted'
    expect(getCleanBody(input)).toBe(
      'My reply\nFrom: Jane Doe\nSent: Monday, Jan 1, 2020 9:00 AM\nQuoted'
    )
  })

  test('does not truncate at standalone From: line (forwarded content should be preserved)', () => {
    const input =
      'Please see the forwarded email below:\nFrom: Jane Doe <jane@example.com>\nHere is the content'
    expect(getCleanBody(input)).toBe(
      'Please see the forwarded email below:\nFrom: Jane Doe <jane@example.com>\nHere is the content'
    )
  })

  test('cuts off at underscore separator line', () => {
    const input =
      'My message\n________________________________________\nFrom: Jane\nSent: Monday'
    expect(getCleanBody(input)).toBe('My message')
  })

  test('does not truncate at underscores that are part of text (not a separator line)', () => {
    const input = '__________field description here\nMore content here'
    expect(getCleanBody(input)).toBe(
      '__________field description here\nMore content here'
    )
  })

  test('cuts off at confidentiality notice', () => {
    const input = 'Message body\nThis is a confidentiality notice: do not share'
    expect(getCleanBody(input)).toBe('Message body')
  })

  test('handles match at start of text (lineStart = 0)', () => {
    const input =
      'On Jan 1, 2020, John Doe <john@example.com> wrote:\nQuoted content here'
    expect(getCleanBody(input)).toBe('')
  })

  test('preserves text when no patterns match', () => {
    const input = 'Regular email content\nNo special patterns here'
    expect(getCleanBody(input)).toBe(
      'Regular email content\nNo special patterns here'
    )
  })

  test.each([
    {
      name: 'cuts off at reply header with non-breaking space after On',
      input: 'Line1\nOn Jan 1, 2020, John Doe wrote:\nQuoted',
      expected: 'Line1',
    },
    {
      name: 'cuts off at reply header with non-breaking space before wrote',
      input: 'Line1\nOn Jan 1, 2020, John Doe wrote:\nQuoted',
      expected: 'Line1',
    },
    {
      name: 'cuts off at Outlook header with non-breaking space after From',
      input: 'My reply\nFrom: Jane Doe Sent: Monday\nQuoted',
      expected: 'My reply',
    },
  ])('$name', ({ input, expected }) => {
    expect(getCleanBody(input)).toBe(expected)
  })

  test.each([
    {
      name: 'collapses 3+ consecutive line breaks to 2',
      input: 'Paragraph 1\n\n\n\nParagraph 2',
      expected: 'Paragraph 1\n\nParagraph 2',
    },
    {
      name: 'handles multiple occurrences of excessive line breaks',
      input: 'Line 1\n\n\nLine 2\n\n\n\n\nLine 3',
      expected: 'Line 1\n\nLine 2\n\nLine 3',
    },
    {
      name: 'preserves single line breaks',
      input: 'Line 1\nLine 2\nLine 3',
      expected: 'Line 1\nLine 2\nLine 3',
    },
    {
      name: 'preserves double line breaks (intentional paragraph spacing)',
      input: 'Paragraph 1\n\nParagraph 2',
      expected: 'Paragraph 1\n\nParagraph 2',
    },
    {
      name: 'collapses runs of 3+ line breaks but preserves double line breaks',
      input: 'Thank you!\n\n\n\nJohn Doe\n\nSoftware Engineer\n\n\nAcme Corp',
      expected: 'Thank you!\n\nJohn Doe\n\nSoftware Engineer\n\nAcme Corp',
    },
  ])('$name', ({ input, expected }) => {
    expect(getCleanBody(input)).toBe(expected)
  })
})

describe('getFileHash', () => {
  test('computes sha256 for a Buffer', () => {
    const buf = Buffer.from('hello world')
    expect(getFileHash(buf)).toBe(
      'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9'
    )
  })

  test('computes sha256 for an object with getBytes()', () => {
    const blob = { getBytes: () => Buffer.from('abc') }
    expect(getFileHash(blob)).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    )
  })

  test('computes sha256 for an object with bytes property', () => {
    const blob = { bytes: Buffer.from('test') }
    expect(getFileHash(blob)).toBe(
      '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'
    )
  })

  test('throws error for unsupported blob type', () => {
    expect(() => getFileHash('not a blob')).toThrow('Unsupported blob type')
    expect(() => getFileHash({})).toThrow('Unsupported blob type')
    expect(() => getFileHash(null)).toThrow('Unsupported blob type')
  })
})
