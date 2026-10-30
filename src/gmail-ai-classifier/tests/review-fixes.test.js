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

      const snippetActionable = mod.deterministicRuleClassify_(
        'Teacher <teacher@school.example>',
        'Attendance update for your child',
        'Urgent: please reply today to confirm a conference about your child.',
        null,
        { ...cfg, schoolDomains: 'school.example' }
      )
      expect(snippetActionable.category).toBe('Primary')
      expect(snippetActionable.action).toBe('keep')
      expect(snippetActionable.reasoning).toBe('Teacher 1:1 Shield')
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
  describe('fast-path guards for actionable messages', () => {
    const classify = (sender, subject, snippet) =>
      mod.deterministicRuleClassify_(sender, subject, snippet, null, {})

    test('SaaS plan fast path still archives routine plan notices', () => {
      const res = classify(
        'noreply@cloudflare.com',
        'Your account plan has changed',
        'Plan details'
      )
      expect(res && res.subLabel).toBe('Tech/Alerts')
    })

    test('SaaS plan fast path skips actionable payment failures', () => {
      const res = classify(
        'billing@cloudflare.com',
        'Action required: account plan payment failed',
        'Update your payment method to prevent service suspension'
      )
      expect(!res || res.subLabel !== 'Tech/Alerts').toBe(true)
    })

    test('ParentSquare personal conference requests are not fast-pathed', () => {
      const res = classify(
        'Teacher via ParentSquare <no-reply@parentsquare.com>',
        'Urgent: please confirm the conference for your child',
        'Please reply'
      )
      expect(!res || res.subLabel !== 'Family/School-Student').toBe(true)
    })

    test('ParentSquare broadcasts are still routed to the school label', () => {
      const res = classify(
        'School via ParentSquare <no-reply@parentsquare.com>',
        'Weekly Newsletter',
        'This week at school'
      )
      expect(res && res.subLabel).toBe('Family/School-Student')
    })

    test('PayPal receipt rule excludes outstanding payment requests and money requests', () => {
      const reqBySubject = classify(
        'service@paypal.com',
        'Action required: payment request from Acme',
        'Please pay $150 by Friday'
      )
      expect(reqBySubject).toBeNull()

      const reqBySnippet = classify(
        'service@paypal.com',
        'PayPal transaction ($150.00 USD)',
        'Acme sent you an invoice. Please pay $150 by Friday.'
      )
      expect(reqBySnippet).toBeNull()

      const completedReceipt = classify(
        'service@paypal.com',
        'Receipt for your payment to Acme',
        'You sent a payment of $150.00 USD to Acme.'
      )
      expect(completedReceipt).toMatchObject({
        canonicalDomain: '02_Finance_Legal',
        subLabel: 'Finance/Purchases',
        category: 'Updates',
        action: 'archive',
        reasoning: 'Payment Receipt',
      })
    })

    test('previously unclassified replied threads still get semantic filing and Drive persistence while staying in Primary/keep', () => {
      const pdfBytes = Buffer.from('contractor invoice pdf', 'utf-8')
      const att = {
        getName: () => 'contractor-invoice.pdf',
        getContentType: () => 'application/pdf',
        getSize: () => pdfBytes.length + 4096,
        getBytes: () => pdfBytes,
      }
      const addedLabels = []
      const repliedUnfiledThread = {
        getId: () => 't-contractor-replied',
        getFirstMessageSubject: () => 'Roof Repair Invoice #402',
        getMessages: () => [
          {
            getFrom: () => 'billing@roofing-contractor.example',
            getSubject: () => 'Roof Repair Invoice #402',
            getPlainBody: () => 'Please see attached invoice for roof repair.',
            getDate: () => new Date('2026-10-01T12:00:00Z'),
            getAttachments: () => [att],
          },
          {
            getFrom: () => 'Me <me@example.com>',
            getSubject: () => 'Re: Roof Repair Invoice #402',
            getPlainBody: () => 'Thanks, received!',
            getDate: () => new Date('2026-10-01T12:30:00Z'),
            getAttachments: () => [],
          },
        ],
        getLabels: () => [],
        addLabel: jest.fn((lb) => addedLabels.push(lb.getName())),
        removeLabel: jest.fn(),
        moveToArchive: jest.fn(),
        moveToTrash: jest.fn(),
      }

      const cfg = {
        geminiApiKey: 'k',
        unprocessedQuery: 'q',
        processedLabel: 'Processed',
        userAccountEmail: 'me@example.com',
        canonicalDomains: DOMAINS,
      }

      // 1. deterministicRuleClassify_ returns null so unclassified replied thread falls through to Gemini
      expect(
        mod.deterministicRuleClassify_(
          'billing@roofing-contractor.example',
          'Roof Repair Invoice #402',
          'Please see attached invoice for roof repair.',
          repliedUnfiledThread,
          cfg
        )
      ).toBeNull()

      // 2. Canonical deterministic rule on a replied thread keeps its canonical domain and shields to Primary/keep
      const repliedDeterministic = mod.deterministicRuleClassify_(
        'service@paypal.com',
        'Receipt for your payment to Acme',
        'You sent a payment of $150.00 USD to Acme.',
        repliedUnfiledThread,
        cfg
      )
      expect(repliedDeterministic).toMatchObject({
        canonicalDomain: '02_Finance_Legal',
        subLabel: 'Finance/Purchases',
        category: 'Primary',
        action: 'keep',
        reasoning: 'User-Sent Shield',
      })

      // 3. processEmailsWithAiClassifier invokes classifyFn, applies canonical label, saves attachment to Drive, and keeps in Primary
      const createdFile = {
        getId: () => 'f-invoice-1',
        getName: () => 'contractor-invoice.pdf',
        getUrl: () => 'https://drive.example/f-invoice-1',
        setDescription: jest.fn(),
      }
      const folder = {
        getName: () => 'Property',
        getFoldersByName: () => ({ hasNext: () => false }),
        createFolder: () => folder,
        getFilesByName: () => ({ hasNext: () => false }),
        createFile: jest.fn(() => createdFile),
      }
      const classifyFn = jest.fn(() => ({
        canonicalDomain: '01_Household',
        subLabel: 'Household/Property',
        category: 'Updates',
        action: 'archive',
        confidence: 0.96,
        title: 'Roof Repair Invoice',
        summary: 'Contractor invoice for roof repair.',
      }))

      mod.processEmailsWithAiClassifier(cfg, {
        GmailApp: {
          search: (q) =>
            q.includes('in:inbox is:unread') ? [] : [repliedUnfiledThread],
          getUserLabelByName: (n) => label(n),
          createLabel: (n) => label(n),
        },
        DriveApp: {
          getRootFolder: () => folder,
        },
        classifyFn,
      })

      expect(classifyFn).toHaveBeenCalledTimes(1)
      expect(addedLabels).toContain('Household/Property')
      expect(addedLabels).toContain('Processed')
      expect(folder.createFile).toHaveBeenCalledTimes(1)
      expect(repliedUnfiledThread.moveToArchive).not.toHaveBeenCalled()
      expect(repliedUnfiledThread.moveToTrash).not.toHaveBeenCalled()
    })

    test('direct LinkedIn messages and recruiter outreach fall through to semantic classification while routine social alerts archive', () => {
      const directMessage = classify(
        'messages-noreply@linkedin.com',
        'Alice sent you a message',
        'Hi! Would you be open to discussing an engineering role next Tuesday?'
      )
      expect(directMessage).toBeNull()

      const snippetRecruiterOutreach = classify(
        'notifications@linkedin.com',
        'Alice via LinkedIn',
        'Are you available for a quick call with our hiring manager about an open role?'
      )
      expect(snippetRecruiterOutreach).toBeNull()

      const routineDigest = classify(
        'messages-noreply@linkedin.com',
        'You have 3 new notifications on LinkedIn',
        'See what your connections are sharing this week'
      )
      expect(routineDigest).toMatchObject({
        canonicalDomain: null,
        category: 'Social',
        action: 'archive',
        reasoning: 'News/Newsletter/Social',
      })
    })

    test('Family/Health-Medical maps to canonical Medical_Records subfolder', () => {
      expect(
        mod.resolveTaxonomySubfolderName(
          '04_Family_Health',
          'Family/Health-Medical'
        )
      ).toBe('Medical_Records')
      expect(
        mod.resolveTaxonomySubfolderName('04_Family_Health', 'Family/Medical')
      ).toBe('Medical_Records')
      expect(
        mod.resolveTaxonomySubfolderName('01_Household', 'Household/Supplies')
      ).toBe('Primary_House')
    })

    test('promo fast path requires retail/marketing sender evidence and excludes personal proposals', () => {
      const contractorProposal = classify(
        'contractor@example.com',
        'Revised kitchen proposal',
        'Attached is the revised proposal. I can offer a discount if you approve it by Friday. Please confirm whether to proceed.'
      )
      expect(contractorProposal).toBeNull()

      const retailPromo = classify(
        'deals@store.example.com',
        'Flash Sale: 40% Off Limited Time Offer!',
        'Shop now and save on all clearance items'
      )
      expect(retailPromo).toMatchObject({
        canonicalDomain: null,
        category: 'Promotions',
        action: 'archive',
        reasoning: 'Retail Promo',
      })
    })

    test('persistCanonicalAttachmentsToDrive catches duplicate-lookup failures and marks hadErrors', () => {
      const att = {
        getName: () => 'proposal.pdf',
        getContentType: () => 'application/pdf',
        getSize: () => 8192,
        getBytes: () => Buffer.from('pdf', 'utf-8'),
      }
      const thread = {
        getId: () => 't-dup-throw',
        getMessages: () => [
          {
            getAttachments: () => [att],
          },
        ],
      }
      const throwingFolder = {
        getName: () => 'Primary_House',
        getFoldersByName: () => ({ hasNext: () => false }),
        createFolder: () => throwingFolder,
        getFilesByName: () => {
          throw new Error('Drive getFilesByName failed')
        },
      }
      const res = mod.persistCanonicalAttachmentsToDrive(
        thread,
        {
          canonicalDomain: '01_Household',
          subLabel: 'Household/Property',
        },
        { canonicalDomains: DOMAINS },
        {
          DriveApp: {
            getRootFolder: () => throwingFolder,
          },
        }
      )
      expect(res.hadErrors).toBe(true)
    })

    test('processThreadBatch resolves runtime DriveApp and queues retry when Drive is unavailable for eligible attachments', () => {
      const att = {
        getName: () => 'receipt.pdf',
        getContentType: () => 'application/pdf',
        getSize: () => 8192,
        getBytes: () => Buffer.from('pdf', 'utf-8'),
      }
      const makeBatchThread = () => ({
        getId: () => 't-batch-drive',
        getMessages: () => [
          {
            getFrom: () => 'service@paypal.com',
            getSubject: () => 'Receipt for your payment to Acme',
            getPlainBody: () => 'You sent a payment of $25.00 USD',
            getAttachments: () => [att],
          },
        ],
        addLabel: jest.fn(),
        removeLabel: jest.fn(),
        moveToArchive: jest.fn(),
      })

      const prevDrive = global.DriveApp
      try {
        // 1. When global DriveApp is absent and services.DriveApp is omitted, queues retry
        delete global.DriveApp
        const tNoDrive = makeBatchThread()
        const rNoDrive = mod.processThreadBatch(
          [tNoDrive],
          {
            processedLabel: 'Processed',
            retryLabel: 'AI/Needs-Retry',
            canonicalDomains: DOMAINS,
            autoFilterConfidenceThreshold: 0.99,
          },
          {
            GmailApp: {
              getUserLabelByName: (n) => label(n),
              createLabel: (n) => label(n),
            },
            UrlFetchApp: { fetch: jest.fn() },
            Gmail: null,
          }
        )
        expect(rNoDrive[0].status).toBe('attachment_persistence_failed')
        expect(tNoDrive.removeLabel).toHaveBeenCalled()

        // 2. When global DriveApp is available and services.DriveApp is omitted, persists attachment
        const createdFile = {
          getId: () => 'f-global-1',
          getName: () => 'receipt.pdf',
          getUrl: () => 'https://drive.example/f-global-1',
          setDescription: jest.fn(),
        }
        const folder = {
          getName: () => 'Purchases',
          getFoldersByName: () => ({ hasNext: () => false }),
          createFolder: () => folder,
          getFilesByName: () => ({ hasNext: () => false }),
          createFile: jest.fn(() => createdFile),
        }
        global.DriveApp = {
          getRootFolder: () => folder,
        }
        const tGlobalDrive = makeBatchThread()
        const rGlobalDrive = mod.processThreadBatch(
          [tGlobalDrive],
          {
            processedLabel: 'Processed',
            retryLabel: 'AI/Needs-Retry',
            canonicalDomains: DOMAINS,
            autoFilterConfidenceThreshold: 0.99,
          },
          {
            GmailApp: {
              getUserLabelByName: (n) => label(n),
              createLabel: (n) => label(n),
            },
            UrlFetchApp: { fetch: jest.fn() },
            Gmail: null,
          }
        )
        expect(rGlobalDrive[0].status).toBe('classified')
        expect(folder.createFile).toHaveBeenCalledTimes(1)
      } finally {
        global.DriveApp = prevDrive
      }
    })

    test('reclassifyThreadsByQuery realigns extracted ZIP folders/files and re-extracts relocated duplicate ZIP archives', () => {
      const zipBytes = Buffer.from('zip-bytes', 'utf-8')
      const pdfBytes = Buffer.from('agreement-pdf', 'utf-8')
      const zipAtt = {
        getName: () => 'documents.zip',
        getContentType: () => 'application/zip',
        getSize: () => zipBytes.length,
        getBytes: () => zipBytes,
      }
      const entryBlob = {
        getName: () => 'agreement.pdf',
        getContentType: () => 'application/pdf',
        getSize: () => pdfBytes.length + 4096,
        getBytes: () => pdfBytes,
        setName: jest.fn(),
      }
      const zipFileInDrive = {
        getId: () => 'zip-1',
        getName: () => 'documents.zip',
        getUrl: () => 'https://drive.example/zip-1',
        getSize: () => zipBytes.length,
        getBytes: () => zipBytes,
        getBlob: () => ({ getBytes: () => zipBytes }),
        getDescription: () => 'Thread-ID: t-zip-realign',
        moveTo: jest.fn(),
      }
      const extractedFileInOld = {
        getId: () => 'ext-1',
        getName: () => 'agreement.pdf',
        moveTo: jest.fn(),
        makeCopy: jest.fn(),
      }
      const oldExtractedSubfolder = {
        getName: () => 'documents',
        getFiles: () => {
          let done = false
          return {
            hasNext: () => !done,
            next: () => {
              done = true
              return extractedFileInOld
            },
          }
        },
      }
      const destExtractedSubfolder = {
        getName: () => 'documents',
        getFilesByName: () => ({ hasNext: () => false }),
        createFile: jest.fn(() => ({
          getId: () => 'ext-new-1',
          getName: () => 'agreement.pdf',
          getUrl: () => 'https://drive.example/ext-new-1',
          setDescription: jest.fn(),
        })),
      }
      let zipMovedToNew = false
      zipFileInDrive.moveTo = jest.fn(() => {
        zipMovedToNew = true
      })
      const oldFolder = {
        getName: () => 'Bills',
        getFilesByName: () => {
          let done = false
          return {
            hasNext: () => !done,
            next: () => {
              done = true
              return zipFileInDrive
            },
          }
        },
        getFoldersByName: (n) => {
          let done = false
          return {
            hasNext: () => n === 'documents' && !done,
            next: () => {
              done = true
              return oldExtractedSubfolder
            },
          }
        },
      }
      const newFolder = {
        getName: () => 'Career_Interviews',
        getFilesByName: (n) => {
          let done = false
          return {
            hasNext: () => zipMovedToNew && n === 'documents.zip' && !done,
            next: () => {
              done = true
              return zipFileInDrive
            },
          }
        },
        getFoldersByName: () => ({ hasNext: () => false }),
        createFolder: () => destExtractedSubfolder,
        createFile: jest.fn(),
      }
      const rootFolder = {
        getFoldersByName: (n) => ({
          hasNext: () => true,
          next: () => ({
            getFoldersByName: () => ({
              hasNext: () => true,
              next: () => (n === '06_Work_Career' ? newFolder : oldFolder),
            }),
            createFolder: () =>
              n === '06_Work_Career' ? newFolder : oldFolder,
          }),
        }),
        createFolder: () => rootFolder,
      }
      const thread = {
        getId: () => 't-zip-realign',
        getMessages: () => [
          {
            getFrom: () => 'hr@company.example',
            getSubject: () => 'Offer Package',
            getPlainBody: () => 'Attached documents.zip',
            getAttachments: () => [zipAtt],
          },
        ],
        getLabels: () => [label('02_Finance_Legal'), label('Finance/Bills')],
        addLabel: jest.fn(),
        removeLabel: jest.fn(),
      }

      mod.reclassifyThreadsByQuery(
        'q',
        { dryRun: false, maxThreads: 5 },
        {
          canonicalDomains: DOMAINS,
          processedLabel: 'Processed',
        },
        {
          GmailApp: {
            search: () => [thread],
            getUserLabelByName: (n) => label(n),
            createLabel: (n) => label(n),
          },
          DriveApp: {
            getRootFolder: () => rootFolder,
          },
          Utilities: {
            unzip: () => [entryBlob],
          },
          classifyFn: () => ({
            canonicalDomain: '06_Work_Career',
            subLabel: 'Work/Career',
            category: 'Primary',
            action: 'keep',
          }),
          getFileHash: () => 'same-hash',
        }
      )

      expect(zipFileInDrive.moveTo).toHaveBeenCalledWith(newFolder)
      expect(extractedFileInOld.moveTo).toHaveBeenCalledWith(
        destExtractedSubfolder
      )
      expect(destExtractedSubfolder.createFile).toHaveBeenCalledWith(entryBlob)
    })

    test('duplicate renamed ZIP re-extraction uses the saved Drive archive name rather than the original attachment name', () => {
      const zipBytes = Buffer.from('renamed-zip-bytes', 'utf-8')
      const pdfBytes = Buffer.from('contract-b-pdf', 'utf-8')
      const zipAtt = {
        getName: () => 'documents.zip',
        getContentType: () => 'application/zip',
        getSize: () => zipBytes.length,
        getBytes: () => zipBytes,
        copyBlob: () => ({
          getName: () => 'documents.zip',
          getContentType: () => 'application/zip',
          getSize: () => zipBytes.length,
          getBytes: () => zipBytes,
          setName: jest.fn(),
        }),
      }
      const entryBlob = {
        getName: () => 'contract-b.pdf',
        getContentType: () => 'application/pdf',
        getSize: () => pdfBytes.length + 4096,
        getBytes: () => pdfBytes,
        setName: jest.fn(),
      }
      const savedRenamedZip = {
        getId: () => 'zip-renamed-1',
        getName: () => 'documents_120000111.zip',
        getUrl: () => 'https://drive.example/zip-renamed-1',
        getSize: () => zipBytes.length,
        getBytes: () => zipBytes,
        getBlob: () => ({ getBytes: () => zipBytes }),
      }
      const createdSubfolders = []
      const targetFolder = {
        getName: () => 'Career_Interviews',
        getFilesByName: () => ({ hasNext: () => false }),
        searchFiles: () => {
          let done = false
          return {
            hasNext: () => !done,
            next: () => {
              done = true
              return savedRenamedZip
            },
          }
        },
        getFoldersByName: () => ({ hasNext: () => false }),
        createFolder: jest.fn((n) => {
          createdSubfolders.push(n)
          return {
            getName: () => n,
            getFilesByName: () => ({ hasNext: () => false }),
            createFile: jest.fn(() => ({
              getId: () => 'ext-renamed-1',
              getName: () => 'contract-b.pdf',
              getUrl: () => 'https://drive.example/ext-renamed-1',
              setDescription: jest.fn(),
            })),
          }
        }),
      }
      const rootFolder = {
        getFoldersByName: () => ({
          hasNext: () => true,
          next: () => ({
            getFoldersByName: () => ({
              hasNext: () => true,
              next: () => targetFolder,
            }),
          }),
        }),
      }
      const thread = {
        getId: () => 't-dup-renamed-zip',
        getMessages: () => [
          {
            getAttachments: () => [zipAtt],
          },
        ],
      }

      const saved = mod.persistCanonicalAttachmentsToDrive(
        thread,
        {
          canonicalDomain: '06_Work_Career',
          subLabel: 'Work/Career',
        },
        { canonicalDomains: DOMAINS },
        {
          DriveApp: { getRootFolder: () => rootFolder },
          Utilities: { unzip: () => [entryBlob] },
          getFileHash: () => 'same-zip-hash',
        }
      )

      expect(createdSubfolders).toEqual(['documents_120000111'])
      expect(saved[0].name).toBe('documents_120000111/contract-b.pdf')
    })

    test('preserves existing canonical labels when replacement label creation fails across main, batch, and realignment paths', () => {
      const existingBills = label('Finance/Bills')
      const makeFiledThread = (id) => ({
        getId: () => id,
        getFirstMessageSubject: () => 'Employment Offer Letter',
        getMessages: () => [
          {
            getFrom: () => 'hr@company.example',
            getSubject: () => 'Employment Offer Letter',
            getPlainBody: () =>
              'We are pleased to offer you the position of Staff Engineer.',
            getAttachments: () => [],
          },
        ],
        getLabels: () => [existingBills],
        addLabel: jest.fn(),
        removeLabel: jest.fn(),
      })

      const failingGmail = (threads) => ({
        search: () => threads,
        getUserLabelByName: (n) => (n === 'Work/Career' ? null : label(n)),
        createLabel: (n) => {
          if (n === 'Work/Career') throw new Error('label quota')
          return label(n)
        },
      })

      // 1. processEmailsWithAiClassifier
      const tMain = makeFiledThread('t-main-preserve')
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
          GmailApp: failingGmail([tMain]),
        }
      )
      expect(tMain.removeLabel).not.toHaveBeenCalledWith(existingBills)

      // 2. processThreadBatch
      const tBatch = makeFiledThread('t-batch-preserve')
      const batchRes = mod.processThreadBatch(
        [tBatch],
        {
          processedLabel: 'Processed',
          canonicalDomains: DOMAINS,
        },
        {
          GmailApp: failingGmail([tBatch]),
          UrlFetchApp: { fetch: jest.fn() },
          Gmail: null,
        }
      )
      expect(batchRes[0].status).toBe('label_creation_failed')
      expect(tBatch.removeLabel).not.toHaveBeenCalledWith(existingBills)

      // 3. reclassifyThreadsByQuery
      const tReclass = makeFiledThread('t-reclass-preserve')
      mod.reclassifyThreadsByQuery(
        'q',
        { dryRun: false, maxThreads: 5 },
        {
          canonicalDomains: DOMAINS,
          processedLabel: 'Processed',
          retryLabel: 'AI/Needs-Retry',
        },
        {
          GmailApp: failingGmail([tReclass]),
        }
      )
      expect(tReclass.removeLabel).not.toHaveBeenCalledWith(existingBills)
      expect(tReclass.addLabel).toHaveBeenCalled()
    })

    test('reclassifyThreadsByQuery resolves destination filename conflicts before relocating ZIP archives and extracted folders', () => {
      const entryBytesB = Buffer.alloc(4096, 2)
      const zipBytesB = Buffer.alloc(8192, 2)
      const zipBytesA = Buffer.alloc(8192, 1)
      const entryB = {
        getName: () => 'b.pdf',
        getContentType: () => 'application/pdf',
        getSize: () => entryBytesB.length,
        getBytes: () => entryBytesB,
        setName: jest.fn(),
      }
      const zipAttB = {
        getName: () => 'documents.zip',
        getContentType: () => 'application/zip',
        getSize: () => zipBytesB.length,
        getBytes: () => zipBytesB,
        copyBlob: () => ({
          getName: () => 'documents.zip',
          getContentType: () => 'application/zip',
          getSize: () => zipBytesB.length,
          getBytes: () => zipBytesB,
          setName: jest.fn(),
        }),
      }
      const existingZipA = {
        getId: () => 'zip-a-id',
        getName: () => 'documents.zip',
        getUrl: () => 'https://drive.google.com/file/d/zip-a-id',
        getSize: () => zipBytesA.length,
        getDescription: () => 'Thread-ID: t-other',
        getBlob: () => ({
          getBytes: () => zipBytesA,
        }),
      }
      const existingDocsFolderA = {
        getName: () => 'documents',
        getFilesByName: () => ({ hasNext: () => false }),
        createFile: jest.fn(),
      }
      let movedFolderName = 'documents'
      let movedFolderInNew = false
      const oldExtractedFolderB = {
        getName: () => movedFolderName,
        setName: (n) => {
          movedFolderName = n
        },
        moveTo: jest.fn(() => {
          movedFolderInNew = true
        }),
        getFilesByName: (n) => {
          let done = false
          return {
            hasNext: () => n === 'b.pdf' && !done,
            next: () => {
              done = true
              return {
                getName: () => 'b.pdf',
                getSize: () => entryBytesB.length,
                getBlob: () => entryB,
              }
            },
          }
        },
        createFile: jest.fn(),
      }
      let movedZipInNew = false
      const zipFileB = {
        getId: () => 'zip-b-id',
        getName: () => 'documents.zip',
        getUrl: () => 'https://drive.google.com/file/d/zip-b-id',
        getSize: () => zipBytesB.length,
        getDescription: () => 'Thread-ID: t-zip-collide',
        setDescription: jest.fn(),
        getBlob: () => zipAttB,
        moveTo: jest.fn(() => {
          movedZipInNew = true
        }),
      }
      const oldFolder = {
        getName: () => 'Bills',
        getFilesByName: (n) => {
          let done = false
          return {
            hasNext: () => !movedZipInNew && n === 'documents.zip' && !done,
            next: () => {
              done = true
              return zipFileB
            },
          }
        },
        getFoldersByName: (n) => {
          let done = false
          return {
            hasNext: () => !movedFolderInNew && n === 'documents' && !done,
            next: () => {
              done = true
              return oldExtractedFolderB
            },
          }
        },
      }
      const newFolder = {
        getName: () => 'Career_Interviews',
        getFilesByName: (n) => {
          const matches = []
          if (n === 'documents.zip') matches.push(existingZipA)
          if (movedZipInNew && zipFileB.getName() === n) matches.push(zipFileB)
          let idx = 0
          return {
            hasNext: () => idx < matches.length,
            next: () => matches[idx++],
          }
        },
        getFoldersByName: (n) => {
          const matches = []
          if (n === 'documents') matches.push(existingDocsFolderA)
          if (movedFolderInNew && oldExtractedFolderB.getName() === n) {
            matches.push(oldExtractedFolderB)
          }
          let idx = 0
          return {
            hasNext: () => idx < matches.length,
            next: () => matches[idx++],
          }
        },
        createFolder: jest.fn(),
        createFile: jest.fn(),
      }
      const rootFolder = {
        getFoldersByName: (n) => ({
          hasNext: () => true,
          next: () => ({
            getFoldersByName: () => ({
              hasNext: () => true,
              next: () => (n === '06_Work_Career' ? newFolder : oldFolder),
            }),
            createFolder: () =>
              n === '06_Work_Career' ? newFolder : oldFolder,
          }),
        }),
        createFolder: () => rootFolder,
      }
      const thread = {
        getId: () => 't-zip-collide',
        getMessages: () => [
          {
            getFrom: () => 'hr@company.example',
            getSubject: () => 'Offer Package B',
            getPlainBody: () => 'Attached documents.zip',
            getAttachments: () => [zipAttB],
          },
        ],
        getLabels: () => [label('02_Finance_Legal'), label('Finance/Bills')],
        addLabel: jest.fn(),
        removeLabel: jest.fn(),
      }

      mod.reclassifyThreadsByQuery(
        'q',
        { dryRun: false, maxThreads: 5 },
        {
          canonicalDomains: DOMAINS,
          processedLabel: 'Processed',
        },
        {
          GmailApp: {
            search: () => [thread],
            getUserLabelByName: (n) => label(n),
            createLabel: (n) => label(n),
          },
          DriveApp: {
            getRootFolder: () => rootFolder,
          },
          Utilities: {
            formatDate: () => '_091500222',
            unzip: () => [entryB],
          },
          Session: {
            getScriptTimeZone: () => 'GMT',
          },
          classifyFn: () => ({
            canonicalDomain: '06_Work_Career',
            subLabel: 'Work/Career',
            category: 'Primary',
            action: 'keep',
          }),
          getFileHash: (blob) => {
            const bytes =
              typeof blob.getBytes === 'function' ? blob.getBytes() : []
            return bytes[0] === 1
              ? 'hash-a'
              : bytes.length === 8192
                ? 'hash-b'
                : 'hash-entry-b'
          },
        }
      )

      expect(zipFileB.getName()).toBe('documents_091500222.zip')
      expect(oldExtractedFolderB.getName()).toBe('documents_091500222')
      expect(existingDocsFolderA.createFile).not.toHaveBeenCalled()
      expect(newFolder.createFile).not.toHaveBeenCalled()
    })

    test('policy update rule requires broadcast evidence and excludes personal attorney correspondence', () => {
      expect(
        mod.deterministicRuleClassify_(
          'lawyer@example.com',
          'Please review the arbitration clause',
          'Attached is the revised settlement agreement. Please reply today with your approval before we file it.',
          null,
          { canonicalDomains: DOMAINS }
        )
      ).toBeNull()
      expect(
        mod.deterministicRuleClassify_(
          'partner@company.com',
          'Arbitration clause discussion',
          'Let us discuss the clause tomorrow morning.',
          null,
          { canonicalDomains: DOMAINS }
        )
      ).toBeNull()
      const broadcastPolicy = mod.deterministicRuleClassify_(
        'no-reply@service.example.com',
        'Updates to our Terms of Service',
        'We are updating our terms of service effective next month.',
        null,
        { canonicalDomains: DOMAINS }
      )
      expect(broadcastPolicy).toMatchObject({
        canonicalDomain: null,
        category: 'Updates',
        action: 'archive',
      })
    })

    test('validateOntologicalClassification and classifyWithGemini reject non-string subLabel before caching', () => {
      expect(
        mod.validateOntologicalClassification(
          {
            canonicalDomain: '02_Finance_Legal',
            subLabel: ['Finance/Bills'],
            confidence: 0.95,
            category: 'Updates',
            action: 'archive',
          },
          DOMAINS
        )
      ).toBe(false)
      expect(
        mod.validateOntologicalClassification(
          {
            canonicalDomain: '02_Finance_Legal',
            subLabel: { name: 'Finance/Bills' },
            confidence: 0.95,
            category: 'Updates',
            action: 'archive',
          },
          DOMAINS
        )
      ).toBe(false)

      const cachePut = jest.fn()
      const res = mod.classifyWithGemini(
        'billing@vendor.example',
        'Invoice',
        'Amount due',
        {
          geminiApiKey: 'test-key',
          canonicalDomains: DOMAINS,
        },
        {
          CacheService: {
            getScriptCache: () => ({
              get: () => null,
              put: cachePut,
            }),
          },
          UrlFetchApp: {
            fetch: () => ({
              getResponseCode: () => 200,
              getContentText: () =>
                JSON.stringify({
                  candidates: [
                    {
                      content: {
                        parts: [
                          {
                            text: JSON.stringify({
                              canonicalDomain: '02_Finance_Legal',
                              subLabel: ['Finance/Bills'],
                              confidence: 0.95,
                              category: 'Updates',
                              action: 'archive',
                            }),
                          },
                        ],
                      },
                    },
                  ],
                }),
            }),
          },
        }
      )
      expect(res).toBeNull()
      expect(cachePut).not.toHaveBeenCalled()
    })
  })

  describe('review thread follow-ups', () => {
    test('career/ labels resolve to the work/career domain', () => {
      expect(mod.resolveCanonicalDomainFromLabels(['Career/Employer'])).toBe(
        '06_Work_Career'
      )
    })

    test('nonprofit matcher is bypassed for actionable correspondence', () => {
      const result = mod.deterministicRuleClassify_(
        'updates@charity.example',
        'Ministry update',
        'Please confirm your volunteer shift this Saturday. Please reply today so we can finalize staffing.',
        { getMessages: () => [], getLabels: () => [] },
        {
          canonicalDomains: DOMAINS,
          customRuleMatchers: ['nonprofit'],
        }
      )
      expect(!result || result.category !== 'Updates').toBe(true)
    })

    test('processThreadBatch processes threads newest first', () => {
      const mkThread = (id, date) => ({
        getId: () => id,
        getLastMessageDate: () => new Date(date),
        getMessages: () => [],
      })
      const results = mod.processThreadBatch(
        [mkThread('old', '2024-01-01'), mkThread('new', '2025-01-01')],
        { processedLabel: 'Processed' },
        { GmailApp: { getUserLabelByName: (n) => ({ getName: () => n }) } }
      )
      expect(results.map((r) => r.threadId)).toEqual(['new', 'old'])
    })

    test('runMissedEmailsSweep builds the recovery query from configured labels', () => {
      const queries = []
      const gmail = {
        search: jest.fn((q) => {
          queries.push(q)
          return []
        }),
        getUserLabelByName: jest.fn((n) => ({ getName: () => n })),
      }
      mod.runMissedEmailsSweep(
        { retryLabel: 'Ops/Retry', processedLabel: 'Ops Done' },
        { GmailApp: gmail }
      )
      const general = queries.find(
        (q) => q.indexOf('newer_than:14d -label') > -1
      )
      expect(general).toBe(
        'label:Ops/Retry OR (newer_than:14d -label:"Ops Done" -label:AI/Manual-Review)'
      )
    })

    test('realignment restores archived Primary/keep threads to the inbox', () => {
      const moveToInbox = jest.fn()
      const thread = {
        getId: () => 'th-offer-archived',
        getMessages: () => [
          {
            getFrom: () => 'hr@employer.example',
            getSubject: () => 'Employment Agreement',
            getPlainBody: () => 'Here is your official employment agreement.',
            getDate: () => new Date(),
          },
        ],
        getLabels: () => [],
        addLabel: jest.fn(),
        removeLabel: jest.fn(),
        isInInbox: () => false,
        moveToInbox,
      }
      const gmail = {
        search: jest.fn(() => [thread]),
        getUserLabelByName: jest.fn((n) => ({ getName: () => n })),
      }
      mod.runMissedEmailsSweep({}, { GmailApp: gmail })
      expect(moveToInbox).toHaveBeenCalled()
    })

    test('ensureDriveTaxonomyFolder aborts folder creation when script lock cannot be acquired', () => {
      const createFolder = jest.fn()
      const rootFolder = {
        getFoldersByName: () => ({ hasNext: () => false }),
        createFolder,
      }
      expect(() =>
        mod.ensureDriveTaxonomyFolder(
          '02_Finance_Legal',
          'Bills',
          { getRootFolder: () => rootFolder },
          {
            lockService: {
              getScriptLock: () => ({
                hasLock: () => false,
                tryLock: () => false,
                releaseLock: jest.fn(),
              }),
            },
          }
        )
      ).toThrow('Unable to acquire script lock to create Drive folder')
      expect(createFolder).not.toHaveBeenCalled()
    })
  })
})
