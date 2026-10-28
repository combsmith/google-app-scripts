const codeMod = require('../code.gs')
const indexMod = require('../src/index.js')

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

describe.each([
  ['code.gs', codeMod],
  ['src/index.js', indexMod],
])('review fixes (%s)', (_implName, mod) => {
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
            candidates: [
              { content: { parts: [{ text: JSON.stringify(obj) }] } },
            ],
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
    const cfg = {
      userAccountEmail: 'me@example.com',
      canonicalDomains: DOMAINS,
    }

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
          getProperty: (k) =>
            k === 'MANUAL_REVIEW_LABEL' ? 'Ops/Review' : null,
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

  describe('same-thread attachment provenance requires a content match', () => {
    const att = { getSize: () => 5 }
    const file = {
      getDescription: () => 'Thread-ID: mine',
      getSize: () => 5,
      getBlob: () => 'blob',
    }

    test('rejects a same-thread file whose content differs', () => {
      let n = 0
      expect(
        mod.doesDriveFileMatchThreadAttachment_(file, att, 'mine', {
          getFileHash: () => 'h' + n++,
        })
      ).toBe(false)
    })

    test('accepts a same-thread file whose content matches', () => {
      expect(
        mod.doesDriveFileMatchThreadAttachment_(file, att, 'mine', {
          getFileHash: () => 'same',
        })
      ).toBe(true)
    })
  })

  describe('isSubLabelOfDomain_', () => {
    test('only accepts sub-labels that resolve to the domain', () => {
      expect(mod.isSubLabelOfDomain_('Finance/Bills', '02_Finance_Legal')).toBe(
        true
      )
      expect(
        mod.isSubLabelOfDomain_('02_Finance_Legal/Bills', '02_Finance_Legal')
      ).toBe(true)
      expect(
        mod.isSubLabelOfDomain_('Personal/Follow-Up', '02_Finance_Legal')
      ).toBe(false)
      expect(mod.isSubLabelOfDomain_('Tech/Alerts', '02_Finance_Legal')).toBe(
        false
      )
    })
  })

  describe('manual-payment bill notices fall through to semantic classification', () => {
    const cfg = { billingSenderDomains: 'utility.example' }
    test('bill-ready with manual payment due is not archived', () => {
      expect(
        mod.deterministicRuleClassify_(
          'billing@utility.example',
          'Your bill is ready',
          'Autopay is disabled. Please pay $150 by November 1 to avoid interruption of service.',
          null,
          cfg
        )
      ).toBeNull()
    })

    test('routine bill-ready notice is still archived', () => {
      const r = mod.deterministicRuleClassify_(
        'billing@utility.example',
        'Your bill is ready',
        'Your statement is available online.',
        null,
        cfg
      )
      expect(r.category).toBe('Updates')
      expect(r.action).toBe('archive')
    })
  })

  describe('round-3 review fixes', () => {
    test('doesDriveFileMatchThreadAttachment_ rejects when hashes are unavailable', () => {
      const file = { getSize: () => 5, getBlob: () => 'blob' }
      const att = { getSize: () => 5 }
      expect(
        mod.doesDriveFileMatchThreadAttachment_(file, att, 't', {
          getFileHash: () => '',
        })
      ).toBe(false)
    })

    test('family shield matches complete addresses only', () => {
      const cfg = {
        familyEmails: 'relative@example.com',
        userAccountEmail: 'me@example.com',
        canonicalDomains: DOMAINS,
      }
      const hit = mod.deterministicRuleClassify_(
        'Relative <relative@example.com>',
        'Hello',
        'hi',
        null,
        cfg
      )
      expect(hit && hit.subLabel).toBe('Family/Correspondence')
      const miss = mod.deterministicRuleClassify_(
        'other.relative@example.com',
        'Hello',
        'hi',
        null,
        cfg
      )
      expect(miss && miss.subLabel).not.toBe('Family/Correspondence')
    })

    test('shared root folder ID is used instead of creating a private tree', () => {
      const shared = {
        getFoldersByName: () => ({ hasNext: () => false }),
        createFolder: jest.fn((n) => ({
          n,
          getFoldersByName: () => ({ hasNext: () => false }),
          createFolder: jest.fn((m) => ({ m })),
        })),
      }
      const drive = {
        getRootFolder: jest.fn(),
        getFolderById: jest.fn(() => shared),
      }
      mod.ensureDriveTaxonomyFolder('02_Finance_Legal', 'Bills', drive, {
        rootFolderId: 'shared-id',
      })
      expect(drive.getFolderById).toHaveBeenCalledWith('shared-id')
      expect(drive.getRootFolder).not.toHaveBeenCalled()
    })

    describe('retention', () => {
      const old = new Date(Date.now() - 3 * 365 * 24 * 3600 * 1000)
      const mk = (id, over) => ({
        getId: () => id,
        getFirstMessageSubject: () => 's',
        getLabels: () => [label('Promotions')],
        getMessages: () => [msg('promo@store.example')],
        getLastMessageDate: () => old,
        moveToTrash: jest.fn(),
        ...over,
      })

      test('keeps mixed Promotions/Primary conversations', () => {
        const mixed = mk('mixed')
        const promo = mk('promo')
        const Gmail = {
          Users: {
            Threads: {
              get: (u, id) => ({
                messages:
                  id === 'mixed'
                    ? [
                        { labelIds: ['CATEGORY_PROMOTIONS'] },
                        { labelIds: ['CATEGORY_PERSONAL'] },
                      ]
                    : [{ labelIds: ['CATEGORY_PROMOTIONS'] }],
              }),
            },
          },
        }
        mod.purgeExpiredEmailsByRetentionPolicy(
          { userAccountEmail: 'me@example.com', canonicalDomains: DOMAINS },
          {
            Gmail,
            GmailApp: {
              search: jest.fn((q, off) => (off === 0 ? [mixed, promo] : [])),
            },
          }
        )
        expect(mixed.moveToTrash).not.toHaveBeenCalled()
        expect(promo.moveToTrash).toHaveBeenCalled()
      })

      test('persists a cursor past permanently exempt threads', () => {
        const store = {}
        const PropertiesService = {
          getScriptProperties: () => ({
            getProperty: (k) => store[k] || null,
            setProperty: (k, v) => {
              store[k] = v
            },
          }),
        }
        const exempt = Array.from({ length: 50 }, (_, i) =>
          mk('e' + i, { getLabels: () => [label('02_Finance_Legal/Bills')] })
        )
        const eligible = mk('ok')
        const search = jest.fn((q, off, size) => {
          const all = exempt.concat([eligible])
          return all.slice(off, off + size)
        })
        const run = () =>
          mod.purgeExpiredEmailsByRetentionPolicy(
            { userAccountEmail: 'me@example.com', canonicalDomains: DOMAINS },
            { PropertiesService, GmailApp: { search } }
          )
        run()
        expect(eligible.moveToTrash).toHaveBeenCalled()
        // reached the end of the results, so the cursor resets
        expect(store.RETENTION_PURGE_OFFSET).toBe('0')
      })
    })
  })

  describe('processThreadBatch attachment persistence failures', () => {
    test('removes Processed and queues retry when Drive persistence fails', () => {
      const processed = label('Processed')
      const added = []
      const removed = []
      const att = {
        getName: () => 'bill.pdf',
        getContentType: () => 'application/pdf',
        getSize: () => 2048,
        getBytes: () => [1, 2, 3],
      }
      const thread = {
        getId: () => 't-fail',
        getMessages: () => [
          {
            getFrom: () => 'someone@example.com',
            getSubject: () => 'Invoice',
            getPlainBody: () => 'Please see attached',
            getAttachments: () => [att],
          },
        ],
        addLabel: jest.fn((l) => added.push(l.getName())),
        removeLabel: jest.fn((l) => removed.push(l.getName())),
      }
      const body = {
        canonical_label: '02_Finance_Legal/Taxes',
        confidence: 0.5,
        reasoning: 'ok',
      }
      const services = {
        GmailApp: {
          getUserLabelByName: jest.fn(() => null),
          createLabel: jest.fn((n) => label(n)),
        },
        UrlFetchApp: {
          fetch: jest.fn(() => ({
            getResponseCode: () => 200,
            getContentText: () =>
              JSON.stringify({
                candidates: [
                  { content: { parts: [{ text: JSON.stringify(body) }] } },
                ],
              }),
          })),
        },
        DriveApp: {
          getRootFolder: () => {
            throw new Error('quota')
          },
        },
      }
      const results = mod.processThreadBatch(
        [thread],
        {
          processedLabel: 'Processed',
          retryLabel: 'AI/Needs-Retry',
          canonicalDomains: ['02_Finance_Legal/Taxes'],
          geminiApiKey: 'k',
          modelEndpoint: 'https://example.com/m',
          autoFilterConfidenceThreshold: 0.95,
        },
        services
      )
      expect(processed.getName()).toBe('Processed')
      expect(results[0].status).toBe('attachment_persistence_failed')
      expect(removed).toContain('Processed')
      expect(added).toContain('AI/Needs-Retry')
    })
  })

  describe('shared deduplicated attachments during realignment', () => {
    test('recordDriveFileCoOwner_ appends a new thread once', () => {
      let desc = 'Thread-ID: a'
      const file = {
        getDescription: () => desc,
        setDescription: jest.fn((d) => {
          desc = d
        }),
      }
      mod.recordDriveFileCoOwner_(file, 'b')
      mod.recordDriveFileCoOwner_(file, 'b')
      expect(file.setDescription).toHaveBeenCalledTimes(1)
      expect(desc).toBe('Thread-ID: a\nThread-ID: b')
      expect(mod.isDriveFileSharedWithOtherThreads_(file, 'a')).toBe(true)
      expect(
        mod.isDriveFileSharedWithOtherThreads_(
          { description: 'Thread-ID: a' },
          'a'
        )
      ).toBe(false)
      expect(() => mod.recordDriveFileCoOwner_(null, 'b')).not.toThrow()
      expect(() =>
        mod.recordDriveFileCoOwner_(
          {
            setDescription: () => {
              throw new Error('ro')
            },
          },
          'b'
        )
      ).not.toThrow()
    })

    test('realigning the original thread copies a shared file instead of moving it', () => {
      const shared = {
        getName: () => 'bill.pdf',
        getDescription: () => 'Thread-ID: thread-a\nThread-ID: thread-b',
        moveTo: jest.fn(),
        makeCopy: jest.fn(),
      }
      const oldFolder = {
        getName: () => 'Bills',
        getFilesByName: () => ({
          hasNext: jest.fn().mockReturnValueOnce(true).mockReturnValue(false),
          next: () => shared,
        }),
      }
      const newFolder = {
        getName: () => 'Taxes',
        getFilesByName: () => ({ hasNext: () => false }),
        createFile: jest.fn(),
      }
      const sub = {
        getFoldersByName: (n) => ({
          hasNext: () => true,
          next: () => (n === 'Taxes' ? newFolder : oldFolder),
        }),
        createFolder: (n) => (n === 'Taxes' ? newFolder : oldFolder),
      }
      const drive = {
        getRootFolder: () => ({
          getFoldersByName: () => ({ hasNext: () => true, next: () => sub }),
          createFolder: () => sub,
        }),
      }
      const att = {
        getName: () => 'bill.pdf',
        getContentType: () => 'application/pdf',
        getSize: () => 15000,
        getBytes: () => new Uint8Array([1, 2, 3]),
      }
      const thread = {
        getId: () => 'thread-a',
        getMessages: () => [
          {
            getFrom: () => 'a@example.com',
            getSubject: () => 'Bill',
            getPlainBody: () => 'x',
            getAttachments: () => [att],
          },
        ],
        getLabels: () => [label('02_Finance_Legal'), label('Finance/Bills')],
        addLabel: jest.fn(),
        removeLabel: jest.fn(),
      }
      const gmail = {
        search: jest.fn(() => [thread]),
        getUserLabelByName: jest.fn((n) => label(n)),
        createLabel: jest.fn((n) => label(n)),
      }
      mod.reclassifyThreadsByQuery(
        'q',
        { maxThreads: 5, dryRun: false },
        {
          canonicalDomains: ['02_Finance_Legal'],
          processedLabel: 'Processed',
        },
        {
          GmailApp: gmail,
          DriveApp: drive,
          classifyFn: () => ({
            canonicalDomain: '02_Finance_Legal',
            subLabel: 'Finance/Taxes',
            action: 'keep',
            category: 'Primary',
          }),
          getFileHash: () => 'h',
        }
      )
      expect(shared.makeCopy).toHaveBeenCalledWith('bill.pdf', newFolder)
      expect(shared.moveTo).not.toHaveBeenCalled()
    })

    test('ready-prescription notices stay in Primary/keep while routine refill notices archive', () => {
      const ready = mod.deterministicRuleClassify_(
        'notify@cvs.com',
        'Your prescription is ready',
        'Please pick up your prescription at the pharmacy counter.',
        null,
        {}
      )
      expect(ready).toMatchObject({
        canonicalDomain: '04_Family_Health',
        subLabel: 'Family/Health-Medical',
        category: 'Primary',
        action: 'keep',
      })

      const refill = mod.deterministicRuleClassify_(
        'notify@cvs.com',
        'Refill confirmation',
        'Your prescription refill has been confirmed.',
        null,
        {}
      )
      expect(refill).toMatchObject({
        canonicalDomain: '04_Family_Health',
        subLabel: 'Family/Health-Medical',
        category: 'Updates',
        action: 'archive',
      })
    })

    test('auditAndBackfillCanonicalAttachments records co-ownership when reusing an existing attachment', () => {
      const pdfBytes = Buffer.from('same pdf bytes', 'utf-8')
      let desc = '[AI_INDEXED] 2026-01-01\nThread-ID: thread-a'
      const existingFile = {
        getName: () => 'statement.pdf',
        getSize: () => pdfBytes.length,
        getBytes: () => pdfBytes,
        getDescription: () => desc,
        setDescription: jest.fn((next) => {
          desc = next
        }),
        getBlob: () => ({ getBytes: () => pdfBytes }),
      }
      const makeIter = (items) => {
        let idx = 0
        return {
          hasNext: () => idx < items.length,
          next: () => items[idx++],
        }
      }
      const targetFolder = {
        getName: () => 'Bills',
        getFilesByName: () => makeIter([existingFile]),
        searchFiles: () => makeIter([]),
        getFiles: () => makeIter([]),
      }
      const domainFolder = {
        getFoldersByName: () => makeIter([targetFolder]),
        createFolder: () => targetFolder,
      }
      const drive = {
        getRootFolder: () => ({
          getFoldersByName: () => makeIter([domainFolder]),
          createFolder: () => domainFolder,
        }),
      }
      const att = {
        getName: () => 'statement.pdf',
        getContentType: () => 'application/pdf',
        getSize: () => pdfBytes.length,
        getBytes: () => pdfBytes,
      }
      const threadB = {
        getId: () => 'thread-b',
        getFirstMessageSubject: () => 'Statement copy',
        getLabels: () => [label('02_Finance_Legal'), label('Finance/Bills')],
        getMessages: () => [
          {
            getFrom: () => 'billing@example.com',
            getSubject: () => 'Statement copy',
            getAttachments: () => [att],
          },
        ],
      }
      const gmail = {
        search: jest.fn(() => [threadB]),
        getUserLabels: () => [label('Finance/Bills'), label('AI/Needs-Retry')],
      }

      const report = mod.auditAndBackfillCanonicalAttachments(
        { dryRun: false, maxThreads: 10 },
        { canonicalDomains: ['02_Finance_Legal'] },
        {
          GmailApp: gmail,
          DriveApp: drive,
        }
      )

      expect(report.alreadyStoredAndTagged).toBe(1)
      expect(
        mod.isDriveFileSharedWithOtherThreads_(existingFile, 'thread-a')
      ).toBe(true)

      // Also verify untagged existing file with prior Thread-ID provenance
      desc = 'Thread-ID: thread-a'
      const report2 = mod.auditAndBackfillCanonicalAttachments(
        { dryRun: false, maxThreads: 10 },
        {
          canonicalDomains: ['02_Finance_Legal'],
          driveRootFolderId: 'shared-1',
        },
        {
          GmailApp: gmail,
          DriveApp: {
            ...drive,
            getFolderById: () => ({
              getFoldersByName: () => makeIter([domainFolder]),
              createFolder: () => domainFolder,
            }),
          },
        }
      )
      expect(report2.alreadyStoredUntagged).toBe(1)
      expect(
        mod.isDriveFileSharedWithOtherThreads_(existingFile, 'thread-a')
      ).toBe(true)
    })

    test('auditEmailClassifications paginates beyond the first 50 matches and persists continuation cursor', () => {
      const makeCompliantThread = (i) => ({
        getId: () => 't-ok-' + i,
        getFirstMessageSubject: () => 'Statement ' + i,
        getMessages: () => [{ getFrom: () => 'billing@example.com' }],
        getLabels: () => [
          label('Processed'),
          label('02_Finance_Legal'),
          label('Finance/Bills'),
        ],
      })
      const orphanThread = {
        getId: () => 't-orphan-51',
        getFirstMessageSubject: () => 'Important unfiled conversation',
        getMessages: () => [{ getFrom: () => 'person@example.com' }],
        getLabels: () => [label('Processed')],
      }
      const allThreads = Array.from({ length: 50 }, (_, i) =>
        makeCompliantThread(i)
      ).concat([orphanThread])

      const search = jest.fn((_q, start, max) =>
        allThreads.slice(start, start + max)
      )
      const store = {}
      const props = {
        getProperty: (k) => store[k] || null,
        setProperty: (k, v) => {
          store[k] = v
        },
      }

      const report = mod.auditEmailClassifications(
        {
          processedLabel: 'Processed',
          canonicalDomains: ['02_Finance_Legal'],
        },
        {
          GmailApp: { search },
          PropertiesService: { getScriptProperties: () => props },
        }
      )

      expect(search).toHaveBeenCalledTimes(2)
      expect(report.scannedCount).toBe(51)
      expect(report.flaggedCount).toBe(1)
      expect(report.findings[0].flags).toEqual(
        expect.arrayContaining([
          expect.stringContaining('MISSING_CANONICAL_DOMAIN'),
        ])
      )
      expect(store.AUDIT_CLASSIFICATIONS_OFFSET).toBe('0')

      // Also verify continuation cursor across runs when auditMaxPages is 1
      const r1 = mod.auditEmailClassifications(
        {
          processedLabel: 'Processed',
          canonicalDomains: ['02_Finance_Legal'],
          auditMaxPages: 1,
        },
        {
          GmailApp: { search },
          PropertiesService: { getScriptProperties: () => props },
        }
      )
      expect(r1.scannedCount).toBe(50)
      expect(r1.flaggedCount).toBe(0)
      expect(store.AUDIT_CLASSIFICATIONS_OFFSET).toBe('50')

      const r2 = mod.auditEmailClassifications(
        {
          processedLabel: 'Processed',
          canonicalDomains: ['02_Finance_Legal'],
          auditMaxPages: 1,
        },
        {
          GmailApp: { search },
          PropertiesService: { getScriptProperties: () => props },
        }
      )
      expect(r2.scannedCount).toBe(1)
      expect(r2.flaggedCount).toBe(1)
      expect(store.AUDIT_CLASSIFICATIONS_OFFSET).toBe('0')

      // Also verify wrap-around when stored offset is past the end of results
      store.AUDIT_CLASSIFICATIONS_OFFSET = '500'
      const r3 = mod.auditEmailClassifications(
        {
          processedLabel: 'Processed',
          canonicalDomains: ['02_Finance_Legal'],
        },
        {
          GmailApp: { search },
          PropertiesService: { getScriptProperties: () => props },
        }
      )
      expect(r3.scannedCount).toBe(51)
      expect(store.AUDIT_CLASSIFICATIONS_OFFSET).toBe('0')
    })

    test('processEmailsWithAiClassifier covers secondary sweep cursor, taxonomy label retry/escalation, and inbox restoration', () => {
      const store = { SECONDARY_SWEEP_OFFSET: '30' }
      const props = {
        getProperty: (k) => store[k] || null,
        setProperty: (k, v) => {
          store[k] = v
        },
      }
      const cacheStore = { retry_count_t_escalate: '4' }
      const cache = {
        get: (k) => cacheStore[k] || null,
        put: (k, v) => {
          cacheStore[k] = v
        },
        remove: (k) => {
          delete cacheStore[k]
        },
      }

      const makeThread = (
        id,
        subject,
        from,
        inInbox = false,
        extraLabels = []
      ) => ({
        getId: () => id,
        getFirstMessageSubject: () => subject,
        getMessages: () => [
          {
            getFrom: () => from,
            getSubject: () => subject,
            getPlainBody: () => 'body',
            getAttachments: () => [],
          },
        ],
        getLabels: () => extraLabels.map((n) => label(n)),
        addLabel: jest.fn(),
        removeLabel: jest.fn(),
        moveToArchive: jest.fn(),
        moveToInbox: jest.fn(),
        isInInbox: () => inInbox,
      })

      // 1. Secondary sweep wrap-around and cursor persistence
      const sweepThread = makeThread(
        't-sweep',
        'Offer Letter',
        'hr@company.example',
        true,
        ['AI/Needs-Retry']
      )
      const searchSweep = jest.fn((q, offset) => {
        if (q.includes('in:inbox is:unread')) {
          return offset > 0 ? [] : [sweepThread]
        }
        return []
      })
      mod.processEmailsWithAiClassifier(
        {
          geminiApiKey: 'k',
          unprocessedQuery: 'q',
          processedLabel: 'Processed',
          retryLabel: 'AI/Needs-Retry',
          manualReviewLabel: 'AI/Manual-Review',
          canonicalDomains: DOMAINS,
        },
        {
          GmailApp: {
            search: searchSweep,
            getUserLabelByName: (n) => label(n),
            createLabel: (n) => label(n),
          },
          PropertiesService: { getScriptProperties: () => props },
          CacheService: { getScriptCache: () => cache },
        }
      )
      expect(store.SECONDARY_SWEEP_OFFSET).toBe('0')

      // 2. Taxonomy label unavailable (retry < 5 and escalation >= 5) + recovered inbox restoration
      const tRetry = makeThread(
        't_retry',
        'Your verification code is 111111',
        'auth@example.com'
      )
      const tEscalate = makeThread(
        't_escalate',
        'Your verification code is 222222',
        'auth@example.com',
        false,
        ['AI/Needs-Retry']
      )
      const tRestore = makeThread(
        't_restore',
        'Your prescription is ready',
        'notify@cvs.com',
        false,
        ['AI/Needs-Retry']
      )
      mod.processEmailsWithAiClassifier(
        {
          geminiApiKey: 'k',
          unprocessedQuery: 'q',
          processedLabel: 'Processed',
          retryLabel: 'AI/Needs-Retry',
          manualReviewLabel: 'AI/Manual-Review',
          canonicalDomains: DOMAINS,
        },
        {
          GmailApp: {
            search: () => [tRetry, tEscalate, tRestore],
            getUserLabelByName: (n) =>
              n === 'Tech/Security' ? null : label(n),
            createLabel: (n) => {
              if (n === 'Tech/Security') throw new Error('unavailable')
              return label(n)
            },
          },
          CacheService: { getScriptCache: () => cache },
        }
      )
      expect(tRetry.addLabel).toHaveBeenCalled()
      expect(tEscalate.addLabel).toHaveBeenCalled()
      expect(tEscalate.removeLabel).toHaveBeenCalled()
      expect(tRestore.moveToInbox).toHaveBeenCalled()
    })

    test('reclassifyThreadsByQuery queues retry when attachment persistence fails and ensureDriveTaxonomyFolder preserves held locks', () => {
      const att = {
        getName: () => 'doc.pdf',
        getContentType: () => 'application/pdf',
        getSize: () => 4096,
        getBytes: () => Buffer.from('pdf', 'utf-8'),
      }
      const thread = {
        getId: () => 't-reclass-fail',
        getMessages: () => [
          {
            getFrom: () => 'billing@chase.com',
            getSubject: () => 'Your statement is ready',
            getPlainBody: () => 'autopay confirmation',
            getAttachments: () => [att],
          },
        ],
        getLabels: () => [label('Processed')],
        addLabel: jest.fn(),
        removeLabel: jest.fn(),
        moveToArchive: jest.fn(),
      }
      mod.reclassifyThreadsByQuery(
        'q',
        { dryRun: false, maxThreads: 5 },
        {
          canonicalDomains: DOMAINS,
          processedLabel: 'Processed',
          retryLabel: 'AI/Needs-Retry',
        },
        {
          GmailApp: {
            search: () => [thread],
            getUserLabelByName: (n) => label(n),
            createLabel: (n) => label(n),
          },
          DriveApp: {
            getRootFolder: () => {
              throw new Error('drive down')
            },
          },
        }
      )
      expect(thread.removeLabel).toHaveBeenCalled()
      expect(thread.addLabel).toHaveBeenCalled()

      // Lock already held by caller is not released inside ensureDriveTaxonomyFolder
      const releaseLock = jest.fn()
      const folder = {
        getFoldersByName: () => ({ hasNext: () => false }),
        createFolder: () => folder,
      }
      mod.ensureDriveTaxonomyFolder(
        '02_Finance_Legal',
        'Bills',
        { getRootFolder: () => folder },
        {
          rootFolderName: 'Root',
          lockService: {
            getScriptLock: () => ({
              hasLock: () => true,
              tryLock: jest.fn(),
              releaseLock,
            }),
          },
        }
      )
      expect(releaseLock).not.toHaveBeenCalled()

      expect(() =>
        mod.ensureDriveTaxonomyFolder(
          '02_Finance_Legal',
          'Bills',
          {},
          { rootFolderId: 'shared-missing' }
        )
      ).toThrow('DriveApp service cannot resolve shared root folder ID')

      // Retention wrap-around when RETENTION_PURGE_OFFSET > 0 and message-level star / throw shield
      const old = new Date(Date.now() - 3 * 365 * 24 * 3600 * 1000)
      const msgStarredThread = {
        getId: () => 't-msg-star',
        getLabels: () => [label('Promotions')],
        getLastMessageDate: () => old,
        getMessages: () => [
          { getFrom: () => 'promo@store.example', isStarred: () => true },
        ],
        moveToTrash: jest.fn(),
      }
      const throwThread = {
        getId: () => 't-throw',
        getLabels: () => [label('Promotions')],
        getLastMessageDate: () => {
          throw new Error('bad date')
        },
        getMessages: () => [{ getFrom: () => 'promo@store.example' }],
        moveToTrash: jest.fn(),
      }
      const retStore = { RETENTION_PURGE_OFFSET: '200' }
      mod.purgeExpiredEmailsByRetentionPolicy(
        { userAccountEmail: 'me@example.com', canonicalDomains: DOMAINS },
        {
          PropertiesService: {
            getScriptProperties: () => ({
              getProperty: (k) => retStore[k] || null,
              setProperty: (k, v) => {
                retStore[k] = v
              },
            }),
          },
          GmailApp: {
            search: (_q, off) =>
              off > 0 ? [] : [msgStarredThread, throwThread, null],
          },
        }
      )
      expect(msgStarredThread.moveToTrash).not.toHaveBeenCalled()
      expect(throwThread.moveToTrash).not.toHaveBeenCalled()
      expect(retStore.RETENTION_PURGE_OFFSET).toBe('0')
    })
  })
})

describe.each([
  ['code.gs', codeMod],
  ['src/index.js', indexMod],
])('round-4 review fixes (%s)', (_implName, mod) => {
  test('document scans with rating/star substrings stay eligible', () => {
    const img = (name) => ({ name, size: 200 * 1024 })
    expect(
      mod.evaluateAttachmentEligibility(img('operating-agreement.png')).eligible
    ).toBe(true)
    expect(
      mod.evaluateAttachmentEligibility(img('start-of-care.png')).eligible
    ).toBe(true)
    expect(
      mod.evaluateAttachmentEligibility(img('star-rating.png')).eligible
    ).toBe(false)
  })

  test('compound domain labels resolve to their root domain', () => {
    expect(
      mod.resolveCanonicalDomainFromLabels(['02_Finance_Legal/Bills'])
    ).toBe('02_Finance_Legal')
  })

  test('revertAndQueueMissedCareerEmails skips manual-review threads', () => {
    const thread = {
      getId: () => 'th-manual',
      getLabels: () => [label('AI/Manual-Review')],
      removeLabel: jest.fn(),
      addLabel: jest.fn(),
    }
    const gmail = {
      search: jest.fn(() => [thread]),
      getUserLabelByName: jest.fn((name) => label(name)),
    }
    const res = mod.revertAndQueueMissedCareerEmails(gmail, {})
    expect(res).toEqual([])
    expect(thread.addLabel).not.toHaveBeenCalled()
  })
  test('revertAndQueueMissedCareerEmails skips threads the user already replied to', () => {
    const thread = {
      getId: () => 'th-replied',
      getLabels: () => [],
      getMessages: () => [{ getFrom: () => 'Me <me@example.com>' }],
      removeLabel: jest.fn(),
      addLabel: jest.fn(),
    }
    const gmail = {
      search: jest.fn(() => [thread]),
      getUserLabelByName: jest.fn((name) => label(name)),
    }
    const res = mod.revertAndQueueMissedCareerEmails(gmail, {
      userAccountEmail: 'me@example.com',
    })
    expect(res).toEqual([])
    expect(thread.addLabel).not.toHaveBeenCalled()
  })

  test('revertAndQueueMissedCareerEmails returns [] when the search throws', () => {
    const gmail = {
      search: jest.fn(() => {
        throw new Error('search failed')
      }),
      getUserLabelByName: jest.fn((name) => label(name)),
    }
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    expect(mod.revertAndQueueMissedCareerEmails(gmail, {})).toEqual([])
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
