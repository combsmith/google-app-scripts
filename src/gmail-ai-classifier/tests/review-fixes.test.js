const mod = require('../code.gs')

const DOMAINS = [
  '01_Household',
  '02_Finance_Legal',
  '03_Vehicles',
  '04_Family_Health',
  '05_Tech_Infrastructure',
  '06_Work_Career',
  '07_Community_NonProfit',
]

const label = (name) => ({ getName: () => name })
const msg = (from, extra = {}) => ({ getFrom: () => from, ...extra })

describe('validateOntologicalClassification completeness', () => {
  test('rejects empty and incomplete objects', () => {
    expect(mod.validateOntologicalClassification({}, DOMAINS)).toBe(false)
    expect(
      mod.validateOntologicalClassification({ confidence: 0.9 }, DOMAINS)
    ).toBe(false)
    expect(
      mod.validateOntologicalClassification(
        { canonicalDomain: null, confidence: 0.9, category: 'Updates' },
        DOMAINS
      )
    ).toBe(false)
  })

  test('accepts a complete object with an explicitly null domain', () => {
    expect(
      mod.validateOntologicalClassification(
        {
          canonicalDomain: null,
          confidence: 0.9,
          category: 'Promotions',
          action: 'archive',
        },
        DOMAINS
      )
    ).toBe(true)
  })
})

describe('classifyWithGemini cache key', () => {
  test('different custom prompt rules do not share a cached result', () => {
    const obj = {
      canonicalDomain: null,
      category: 'Updates',
      action: 'archive',
      confidence: 0.9,
    }
    const store = {}
    const cache = {
      get: jest.fn((k) => store[k] || null),
      put: jest.fn((k, v) => {
        store[k] = v
      }),
    }
    const fetch = jest.fn(() => ({
      getResponseCode: () => 200,
      getContentText: () =>
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }],
        }),
    }))
    const services = { CacheService: cache, UrlFetchApp: { fetch } }
    mod.classifyWithGemini(
      'a@x.example',
      's',
      'b',
      { customPromptRules: 'one' },
      services
    )
    mod.classifyWithGemini(
      'a@x.example',
      's',
      'b',
      { customPromptRules: 'two' },
      services
    )
    expect(fetch).toHaveBeenCalledTimes(2)
    mod.classifyWithGemini(
      'a@x.example',
      's',
      'b',
      { customPromptRules: 'two' },
      services
    )
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})

describe('owner address matching', () => {
  test('does not treat a suffix-matching sender as the owner', () => {
    const thread = {
      getMessages: () => [msg('Other User <other.me@example.com>')],
    }
    expect(mod.isThreadSentOrRepliedByUser(thread, 'me@example.com')).toBe(
      false
    )
    const own = { getMessages: () => [msg('Me <ME@example.com>')] }
    expect(mod.isThreadSentOrRepliedByUser(own, 'me@example.com')).toBe(true)
  })

  test('deterministic shield ignores suffix senders', () => {
    const thread = {
      getMessages: () => [msg('Other User <other.me@example.com>')],
      getLabels: () => [],
    }
    const result = mod.deterministicRuleClassify_(
      'Other User <other.me@example.com>',
      'Invoice',
      'x',
      thread,
      { userAccountEmail: 'me@example.com', canonicalDomains: DOMAINS }
    )
    expect(!result || result.reasoning !== 'User-Sent Shield').toBe(true)
  })

  test('user-reply shield preserves existing canonical filing', () => {
    const thread = {
      getMessages: () => [msg('bank@x.example'), msg('Me <me@example.com>')],
      getLabels: () => [label('Finance/Bills'), label('Processed')],
    }
    const result = mod.deterministicRuleClassify_(
      'bank@x.example',
      'Invoice',
      'x',
      thread,
      {
        userAccountEmail: 'me@example.com',
        canonicalDomains: DOMAINS,
      }
    )
    expect(result.reasoning).toBe('User-Sent Shield')
    expect(result.canonicalDomain).toBe('02_Finance_Legal')
    expect(result.subLabel).toBe('Finance/Bills')
    expect(result.action).toBe('keep')
  })
})

describe('deterministic guards', () => {
  const cfg = { userAccountEmail: 'me@example.com', canonicalDomains: DOMAINS }

  test('suspicious sign-in warnings stay in Primary', () => {
    const result = mod.deterministicRuleClassify_(
      'no-reply@accounts.example.com',
      'Security alert for your account: suspicious sign-in blocked',
      'Review suspicious activity',
      null,
      cfg
    )
    expect(result.category).toBe('Primary')
    expect(result.action).toBe('keep')
  })

  test('routine sign-in pings are still archived', () => {
    const result = mod.deterministicRuleClassify_(
      'no-reply@accounts.example.com',
      'Your verification code is 123456',
      'Use this code',
      null,
      cfg
    )
    expect(result.action).toBe('archive')
  })

  test('urgent school conference requests are not treated as broadcasts', () => {
    const result = mod.deterministicRuleClassify_(
      'Teacher <teacher@school.example>',
      'Urgent: attendance conference required',
      'Please reply today',
      null,
      { ...cfg, schoolDomains: 'school.example' }
    )
    expect(result.category).toBe('Primary')
    expect(result.action).toBe('keep')
  })
})

describe('cleanConflictingLabels', () => {
  test('keeps unrelated user nested labels', () => {
    const personal = label('Personal/Follow-Up')
    const stale = label('Household/General')
    const thread = {
      getLabels: () => [personal, stale],
      removeLabel: jest.fn(),
    }
    mod.cleanConflictingLabels(thread, '02_Finance_Legal', 'Finance/Bills', {
      canonicalDomains: DOMAINS,
    })
    expect(thread.removeLabel).toHaveBeenCalledWith(stale)
    expect(thread.removeLabel).not.toHaveBeenCalledWith(personal)
  })
})

describe('retention whole-thread eligibility', () => {
  test('keeps threads with a recent or starred message', () => {
    const old = new Date(Date.now() - 3 * 365 * 24 * 3600 * 1000)
    const mk = (over) => ({
      getId: () => 't',
      getFirstMessageSubject: () => 's',
      getLabels: () => [label('Promotions')],
      getMessages: () => [msg('promo@store.example')],
      getLastMessageDate: () => old,
      moveToTrash: jest.fn(),
      ...over,
    })
    const recent = mk({ getLastMessageDate: () => new Date() })
    const starred = mk({ hasStarredMessages: () => true })
    const eligible = mk({})
    mod.purgeExpiredEmailsByRetentionPolicy(
      { userAccountEmail: 'me@example.com', canonicalDomains: DOMAINS },
      {
        GmailApp: {
          search: jest.fn((q, off) =>
            off === 0 ? [recent, starred, eligible] : []
          ),
        },
      }
    )
    expect(recent.moveToTrash).not.toHaveBeenCalled()
    expect(starred.moveToTrash).not.toHaveBeenCalled()
    expect(eligible.moveToTrash).toHaveBeenCalled()
  })
})

describe('Drive attachment duplicate handling', () => {
  const file = (bytes, id) => ({
    getBytes: () => bytes,
    getBlob: () => ({ getBytes: () => bytes }),
    getSize: () => bytes.length,
    getId: () => id,
    getName: () => 'invoice.pdf',
    getUrl: () => 'https://drive.example/' + id,
  })

  test('failed digests never count as duplicates', () => {
    const prev = global.Utilities
    global.Utilities = {
      DigestAlgorithm: { MD5: 'MD5' },
      computeDigest: () => {
        throw new Error('digest failed')
      },
    }
    try {
      let consumed = false
      const existing = {
        hasNext: () => !consumed,
        next: () => {
          consumed = true
          return file([4, 5, 6], 'e')
        },
      }
      expect(
        mod.isDuplicateAttachment(existing, file([1, 2, 3], 'n'), {})
      ).toBe(false)
    } finally {
      global.Utilities = prev
    }
  })
})

describe('config processed label', () => {
  test('default unprocessed query uses the configured processed label', () => {
    const prev = global.PropertiesService
    global.PropertiesService = {
      getScriptProperties: () => ({
        getProperty: (k) => (k === 'PROCESSED_LABEL' ? 'AI/Done' : null),
      }),
    }
    try {
      const cfg = require('../config.gs').getAiClassifierConfig()
      expect(cfg.unprocessedQuery).toContain('-label:AI/Done')
      expect(cfg.unprocessedQuery).not.toContain('-label:Processed')
    } finally {
      global.PropertiesService = prev
    }
  })
})

describe('config retry label', () => {
  test('default unprocessed query uses the configured retry label', () => {
    const prev = global.PropertiesService
    global.PropertiesService = {
      getScriptProperties: () => ({
        getProperty: (k) => (k === 'RETRY_LABEL' ? 'Ops/Retry' : null),
      }),
    }
    try {
      const cfg = require('../config.gs').getAiClassifierConfig()
      expect(cfg.retryLabel).toBe('Ops/Retry')
      expect(cfg.unprocessedQuery).toContain('label:Ops/Retry OR')
      expect(cfg.unprocessedQuery).not.toContain('AI/Needs-Retry')
    } finally {
      global.PropertiesService = prev
    }
  })
})

describe('config manual-review label', () => {
  test('default unprocessed query uses the configured manual-review label', () => {
    const prev = global.PropertiesService
    global.PropertiesService = {
      getScriptProperties: () => ({
        getProperty: (k) => (k === 'MANUAL_REVIEW_LABEL' ? 'Ops/Review' : null),
      }),
    }
    try {
      const cfg = require('../config.gs').getAiClassifierConfig()
      expect(cfg.manualReviewLabel).toBe('Ops/Review')
      expect(cfg.unprocessedQuery).toContain('-label:Ops/Review')
      expect(cfg.unprocessedQuery).not.toContain('AI/Manual-Review')
    } finally {
      global.PropertiesService = prev
    }
  })
})

describe('doesDriveFileMatchThreadAttachment_ cross-thread content match', () => {
  const att = { getSize: () => 5 }
  const file = {
    getDescription: () => 'Thread-ID: other',
    getSize: () => 5,
    getBlob: () => 'blob',
  }
  const helperFns = { getFileHash: () => 'same-hash' }

  test('rejects another thread file by default', () => {
    expect(
      mod.doesDriveFileMatchThreadAttachment_(file, att, 'mine', helperFns)
    ).toBe(false)
  })

  test('accepts identical content from another thread for audits', () => {
    expect(
      mod.doesDriveFileMatchThreadAttachment_(file, att, 'mine', {
        ...helperFns,
        allowCrossThreadContentMatch: true,
      })
    ).toBe(true)
  })

  test('still rejects differing content for audits', () => {
    let n = 0
    expect(
      mod.doesDriveFileMatchThreadAttachment_(file, att, 'mine', {
        getFileHash: () => 'h' + n++,
        allowCrossThreadContentMatch: true,
      })
    ).toBe(false)
  })
})
