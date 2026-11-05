const codeMod = require('../code.gs')
const indexMod = require('../src/index.js')

// Reference implementation: the original regex, used to assert the
// non-regex rewrite preserves behavior exactly on ordinary inputs.
function legacyExtract(sender) {
  const raw = String(sender || '')
    .trim()
    .toLowerCase()
  const angleMatch = /<([^<>@\s]+@[^<>@\s]+)>/.exec(raw)
  if (angleMatch) return angleMatch[1]
  const plainMatch = /([^\s<>,"']+@[a-z0-9.-]+\.[a-z]{2,})/i.exec(raw)
  return plainMatch ? plainMatch[1].toLowerCase() : ''
}

describe.each([
  ['code.gs', codeMod],
  ['src/index.js', indexMod],
])('extractSenderAddress_ (%s)', (_name, mod) => {
  const extract = mod.extractSenderAddress_

  test.each([
    ['Jane Doe <Jane.Doe@Example.com>', 'jane.doe@example.com'],
    ['jane@example.com', 'jane@example.com'],
    ['"Jane" jane@example.co.uk', 'jane@example.co.uk'],
    ['Reply to: bob@mail.example.org, alice@x.com', 'bob@mail.example.org'],
    ['bob@example.com>', 'bob@example.com'],
    ['bob@example.com;extra', 'bob@example.com'],
    ['bob@example.com1', 'bob@example.com'],
    ['a@b@example.com', 'a@b@example.com'],
    ['a@example.com@x', 'a@example.com'],
    ['a@b.c1', ''],
    ['@example.com', ''],
    ['no address here', ''],
    ['nobody@localhost', ''],
    ['x@.com', ''],
    ['bad@x foo@example.net', 'foo@example.net'],
    ['', ''],
    [null, ''],
    [undefined, ''],
  ])('extracts %p -> %p', (input, expected) => {
    expect(extract(input)).toBe(expected)
    expect(extract(input)).toBe(legacyExtract(input))
  })

  test('matches legacy regex on assorted generated inputs', () => {
    const alphabet = [
      'a',
      'b',
      '1',
      '.',
      '-',
      '@',
      ' ',
      '<',
      '>',
      ',',
      '"',
      "'",
      '_',
      'Z',
    ]
    let seed = 42
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed
    }
    for (let n = 0; n < 3000; n++) {
      const len = rand() % 16
      let s = ''
      for (let i = 0; i < len; i++) s += alphabet[rand() % alphabet.length]
      expect(extract(s)).toBe(legacyExtract(s))
    }
  })

  test('runs in linear time on adversarial input', () => {
    const adversarial = 'a'.repeat(50000) + '@' + 'a.'.repeat(25000) + '1'
    const start = Date.now()
    expect(extract(adversarial)).toBe('')
    expect(extract('x'.repeat(50000))).toBe('')
    expect(extract('@'.repeat(50000))).toBe('')
    expect(Date.now() - start).toBeLessThan(500)
  })
})
