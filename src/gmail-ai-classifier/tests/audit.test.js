const { auditClassifications, formatAuditDigest } = require('../src/index.js')

describe('Gmail AI Classifier Audit System', () => {
  const config = {
    canonicalDomains: [
      '01_Household',
      '02_Finance_Legal',
      '03_Vehicles',
      '04_Family_Health',
      '05_Tech_Infrastructure',
      '06_Work_Career',
      '07_Community_NonProfit',
    ],
    processedLabel: 'Processed',
    auditDigestEmail: 'user@example.com',
  }

  describe('auditClassifications', () => {
    test('handles empty or non-array input gracefully', () => {
      const reportNull = auditClassifications(null, config)
      expect(reportNull.scannedCount).toBe(0)
      expect(reportNull.flaggedCount).toBe(0)
      expect(reportNull.findings).toHaveLength(0)

      const reportEmpty = auditClassifications([], config)
      expect(reportEmpty.scannedCount).toBe(0)
      expect(reportEmpty.flaggedCount).toBe(0)
    })

    test('passes compliant threads with no flags', () => {
      const compliantThread = {
        getId: () => 't1',
        getFirstMessageSubject: () => 'Home HVAC Filter Replacement',
        getMessages: () => [{ getFrom: () => 'service@homehvac.example.com' }],
        getLabels: () => [
          { getName: () => 'Processed' },
          { getName: () => '01_Household' },
        ],
      }

      const report = auditClassifications([compliantThread], config)
      expect(report.scannedCount).toBe(1)
      expect(report.flaggedCount).toBe(0)
      expect(report.findings).toHaveLength(0)
    })

    test('passes compliant thread with single canonical sub-label (single-label model)', () => {
      const singleLabelThread = {
        getId: () => 't-single',
        getFirstMessageSubject: () => 'Quarterly Statement',
        getMessages: () => [{ getFrom: () => 'statements@mybank.example.com' }],
        getLabels: () => [
          { getName: () => 'Processed' },
          { getName: () => 'Finance/Banking' },
        ],
      }

      const report = auditClassifications([singleLabelThread], config)
      expect(report.scannedCount).toBe(1)
      expect(report.flaggedCount).toBe(0)
      expect(report.findings).toHaveLength(0)
    })

    test('flags missing canonical domain (orphan processed thread)', () => {
      const orphanThread = {
        getId: () => 't2',
        getFirstMessageSubject: () => 'General Update',
        getMessages: () => [{ getFrom: () => 'info@example.com' }],
        getLabels: () => [{ getName: () => 'Processed' }],
      }

      const report = auditClassifications([orphanThread], config)
      expect(report.scannedCount).toBe(1)
      expect(report.flaggedCount).toBe(1)
      expect(report.findings[0].flags).toContainEqual(
        expect.stringContaining('MISSING_CANONICAL_DOMAIN')
      )
    })

    test('flags conflicting multiple domain labels', () => {
      const conflictingThread = {
        getId: () => 't3',
        getFirstMessageSubject: () => 'Family Health Insurance Invoice',
        getMessages: () => [
          { getFrom: () => 'billing@healthprovider.example.com' },
        ],
        getLabels: () => [
          { getName: () => 'Processed' },
          { getName: () => '02_Finance_Legal' },
          { getName: () => '04_Family_Health' },
        ],
      }

      const report = auditClassifications([conflictingThread], config)
      expect(report.scannedCount).toBe(1)
      expect(report.flaggedCount).toBe(1)
      expect(report.findings[0].flags).toContainEqual(
        expect.stringContaining('CONFLICTING_DOMAINS')
      )
    })

    test('does not flag conflicting domains when thread carries both domain and domain-prefixed sub-label', () => {
      const threadWithSublabel = {
        getId: () => 't-same-domain',
        getFirstMessageSubject: () => 'Monthly Statement',
        getMessages: () => [{ getFrom: () => 'statements@mybank.example.com' }],
        getLabels: () => [
          { getName: () => 'Processed' },
          { getName: () => '02_Finance_Legal' },
          { getName: () => '02_Finance_Legal/Purchases' },
        ],
      }

      const report = auditClassifications([threadWithSublabel], config)
      expect(report.scannedCount).toBe(1)
      expect(report.flaggedCount).toBe(0)
    })

    test('flags purchase/receipt keywords when routed to non-finance domain', () => {
      const misroutedReceiptThread = {
        getId: () => 't4',
        getFirstMessageSubject: () => 'Your Order Confirmation #98765',
        getMessages: () => [{ getFrom: () => 'orders@merchant.example.com' }],
        getLabels: () => [
          { getName: () => 'Processed' },
          { getName: () => '07_Community_NonProfit' },
        ],
      }

      const report = auditClassifications([misroutedReceiptThread], config)
      expect(report.scannedCount).toBe(1)
      expect(report.flaggedCount).toBe(1)
      expect(report.findings[0].flags).toContainEqual(
        expect.stringContaining('SUSPICIOUS_ROUTING')
      )
    })

    test('passes purchase/receipt keywords when routed to 02_Finance_Legal', () => {
      const financeReceiptThread = {
        getId: () => 't5',
        getFirstMessageSubject: () => 'Your Order Confirmation #98765',
        getMessages: () => [{ getFrom: () => 'orders@merchant.example.com' }],
        getLabels: () => [
          { getName: () => 'Processed' },
          { getName: () => '02_Finance_Legal' },
          { getName: () => 'Finance/Purchases' },
        ],
      }

      const report = auditClassifications([financeReceiptThread], config)
      expect(report.scannedCount).toBe(1)
      expect(report.flaggedCount).toBe(0)
    })

    test('flags promotional sales keywords without marketing sub-label', () => {
      const promoThread = {
        getId: () => 't6',
        getFirstMessageSubject: () => 'Flash Sale! 50% Off Everything Today',
        getMessages: () => [{ getFrom: () => 'deals@retailer.example.com' }],
        getLabels: () => [
          { getName: () => 'Processed' },
          { getName: () => '01_Household' },
        ],
      }

      const report = auditClassifications([promoThread], config)
      expect(report.scannedCount).toBe(1)
      expect(report.flaggedCount).toBe(1)
      expect(report.findings[0].flags).toContainEqual(
        expect.stringContaining('PROMOTIONAL_CONTENT')
      )
    })

    test('passes promotional sales keywords when marketing sub-label is present', () => {
      const promoWithSublabelThread = {
        getId: () => 't7',
        getFirstMessageSubject: () => 'Flash Sale! 50% Off Everything Today',
        getMessages: () => [{ getFrom: () => 'deals@retailer.example.com' }],
        getLabels: () => [
          { getName: () => 'Processed' },
          { getName: () => '01_Household' },
          { getName: () => 'Household/Marketing' },
        ],
      }

      const report = auditClassifications([promoWithSublabelThread], config)
      expect(report.scannedCount).toBe(1)
      expect(report.flaggedCount).toBe(0)
    })

    test('flags generic newsletter subjects without newsletter sub-label', () => {
      const newsletterThread = {
        getId: () => 't8',
        getFirstMessageSubject: () => 'Weekly Digest: Top Stories in Tech',
        getMessages: () => [{ getFrom: () => 'digest@technews.example.com' }],
        getLabels: () => [
          { getName: () => 'Processed' },
          { getName: () => '05_Tech_Infrastructure' },
        ],
      }

      const report = auditClassifications([newsletterThread], config)
      expect(report.scannedCount).toBe(1)
      expect(report.flaggedCount).toBe(1)
      expect(report.findings[0].flags).toContainEqual(
        expect.stringContaining('UNLABELED_NEWSLETTER')
      )
    })

    test('supports plain object thread representations', () => {
      const plainThread = {
        id: 't9',
        subject: 'Invoice #101',
        sender: 'billing@utility.example.com',
        labels: ['Processed'],
      }

      const report = auditClassifications([plainThread], config)
      expect(report.scannedCount).toBe(1)
      expect(report.flaggedCount).toBe(1)
      expect(report.findings[0].flags).toContainEqual(
        expect.stringContaining('MISSING_CANONICAL_DOMAIN')
      )
    })

    test('flags commercial Terms of Service / Privacy Policy update under 02_Finance_Legal', () => {
      const tosThread = {
        getId: () => 't-tos-1',
        getFirstMessageSubject: () => 'Updates to the Waymo Terms of Service',
        getMessages: () => [{ getFrom: () => 'noreply@waymo.com' }],
        getLabels: () => [
          { getName: () => 'Processed' },
          { getName: () => '02_Finance_Legal' },
          { getName: () => 'Finance/Legal' },
        ],
      }

      const report = auditClassifications([tosThread], config)
      expect(report.scannedCount).toBe(1)
      expect(report.flaggedCount).toBe(1)
      expect(report.findings[0].flags).toContainEqual(
        expect.stringContaining('COMMERCIAL_TOS_IN_LEGAL')
      )
    })

    test('does not flag compliant non-canonical processed threads (retail promos, newsletters, surveys, TOS)', () => {
      const promoThread = {
        getId: () => 't-promo-noncanon',
        getFirstMessageSubject: () => 'Flash Sale! 50% Off Everything Today',
        getMessages: () => [{ getFrom: () => 'deals@retailer.example.com' }],
        getLabels: () => [{ getName: () => 'Processed' }],
      }

      const newsletterThread = {
        getId: () => 't-news-noncanon',
        getFirstMessageSubject: () => 'Weekly Digest: Top Stories in Tech',
        getMessages: () => [{ getFrom: () => 'digest@technews.example.com' }],
        getLabels: () => [{ getName: () => 'Processed' }],
      }

      const surveyThread = {
        getId: () => 't-survey-noncanon',
        getFirstMessageSubject: () =>
          'How did we do? Rate your recent experience',
        getMessages: () => [{ getFrom: () => 'feedback@airline.example.com' }],
        getLabels: () => [{ getName: () => 'Processed' }],
      }

      const tosThread = {
        getId: () => 't-tos-noncanon',
        getFirstMessageSubject: () =>
          'Upcoming updates to our Terms of Service',
        getMessages: () => [
          { getFrom: () => 'notifications@cloudservice.example.com' },
        ],
        getLabels: () => [{ getName: () => 'Processed' }],
      }

      const categoryThread = {
        getId: () => 't-category-noncanon',
        getFirstMessageSubject: () => 'New connection request',
        getMessages: () => [
          { getFrom: () => 'invitations@social.example.com' },
        ],
        getLabels: () => [
          { getName: () => 'Processed' },
          { getName: () => 'Promotions' },
        ],
      }

      const report = auditClassifications(
        [
          promoThread,
          newsletterThread,
          surveyThread,
          tosThread,
          categoryThread,
        ],
        config
      )
      expect(report.scannedCount).toBe(5)
      expect(report.flaggedCount).toBe(0)
      expect(report.findings).toHaveLength(0)
    })

    test('does not flag trashed threads or non-canonical sender stream threads as missing domain', () => {
      const trashedThread = {
        getId: () => 't-trashed',
        getFirstMessageSubject: () => 'Unwanted Cold Pitch',
        getMessages: () => [
          { getFrom: () => 'spammer@coldoutreach.example.com' },
        ],
        getLabels: () => [{ getName: () => 'Processed' }],
        isInTrash: () => true,
      }

      const redditThread = {
        getId: () => 't-reddit',
        getFirstMessageSubject: () => 'Antigravity posted in r/google',
        getMessages: () => [{ getFrom: () => 'noreply@redditmail.com' }],
        getLabels: () => [{ getName: () => 'Processed' }],
        isInTrash: () => false,
      }

      const substackThread = {
        getId: () => 't-substack',
        getFirstMessageSubject: () => 'Thoughts on Autumn',
        getMessages: () => [
          { getFrom: () => 'writer@newsletter.substack.com' },
        ],
        getLabels: () => [{ getName: () => 'Processed' }],
      }

      const report = auditClassifications(
        [trashedThread, redditThread, substackThread],
        config
      )
      expect(report.scannedCount).toBe(3)
      expect(report.flaggedCount).toBe(0)
      expect(report.findings).toHaveLength(0)
    })

    test('flags canonical thread archived from inbox without user action as ARCHIVED_WITHOUT_ACTION', () => {
      const archivedWithoutActionThread = {
        getId: () => 't-archived',
        getFirstMessageSubject: () => 'Empower Cash APY Increase',
        isInInbox: () => false,
        isStarred: () => false,
        getMessages: () => [{ getFrom: () => 'EPC@email.empower.com' }],
        getLabels: () => [
          { getName: () => 'Processed' },
          { getName: () => '02_Finance_Legal' },
        ],
      }

      const report = auditClassifications([archivedWithoutActionThread], config)
      expect(report.flaggedCount).toBe(1)
      expect(report.findings[0].flags[0]).toContain('ARCHIVED_WITHOUT_ACTION')
      expect(report.findings[0].flags[0]).toContain(
        'candidate for secondary stream routing'
      )
    })

    test('does not flag archived thread if it already carries a secondary category label', () => {
      const archivedWithUpdatesLabel = {
        getId: () => 't-archived-updates',
        getFirstMessageSubject: () => 'Empower Cash APY Increase',
        isInInbox: () => false,
        isStarred: () => false,
        getMessages: () => [{ getFrom: () => 'EPC@email.empower.com' }],
        getLabels: () => [
          { getName: () => 'Processed' },
          { getName: () => '02_Finance_Legal' },
          { getName: () => 'Updates' },
        ],
      }

      const report = auditClassifications([archivedWithUpdatesLabel], config)
      expect(report.flaggedCount).toBe(0)
    })

    test('does not flag archived thread if user starred or replied to it', () => {
      const starredThread = {
        getId: () => 't-starred',
        getFirstMessageSubject: () => 'Important Tax Notice',
        isInInbox: () => false,
        isStarred: () => true,
        getMessages: () => [{ getFrom: () => 'tax@cpa.example.com' }],
        getLabels: () => [
          { getName: () => 'Processed' },
          { getName: () => '02_Finance_Legal' },
        ],
      }

      const repliedThread = {
        getId: () => 't-replied',
        getFirstMessageSubject: () => 'Contract Revision',
        isInInbox: () => false,
        isStarred: () => false,
        getMessages: () => [
          { getFrom: () => 'lawyer@example.com' },
          { getFrom: () => 'user@example.com' },
        ],
        getLabels: () => [
          { getName: () => 'Processed' },
          { getName: () => '02_Finance_Legal' },
        ],
      }

      const report = auditClassifications([starredThread, repliedThread], {
        ...config,
        userAccountEmail: 'user@example.com',
      })
      expect(report.flaggedCount).toBe(0)
    })
  })

  describe('formatAuditDigest', () => {
    test('returns clean compliance message when no anomalies exist', () => {
      const cleanReport = {
        scannedCount: 15,
        flaggedCount: 0,
        findings: [],
        summary: 'Audited 15 thread(s); 0 anomaly flag(s) identified.',
      }

      const digest = formatAuditDigest(cleanReport)
      expect(digest).toContain('All 15 analyzed threads are compliant')
      expect(digest).toContain('No anomalies detected')
    })

    test('formats multi-item report with subjects, senders, and flags', () => {
      const anomalousReport = {
        scannedCount: 20,
        flaggedCount: 2,
        findings: [
          {
            threadId: 't1',
            subject: 'Flash Sale 40% Off',
            sender: 'store@example.com',
            canonicalLabels: ['01_Household'],
            flags: [
              'PROMOTIONAL_CONTENT: Promotional sale keywords in subject...',
            ],
          },
          {
            threadId: 't2',
            subject: 'Order Receipt',
            sender: 'pay@example.com',
            canonicalLabels: ['07_Community_NonProfit'],
            flags: [
              'SUSPICIOUS_ROUTING: Purchase/receipt keywords detected...',
            ],
          },
        ],
        summary: 'Audited 20 thread(s); 2 anomaly flag(s) identified.',
      }

      const digest = formatAuditDigest(anomalousReport)
      expect(digest).toContain('GMAIL AI CLASSIFICATION AUDIT REPORT')
      expect(digest).toContain('Flash Sale 40% Off')
      expect(digest).toContain('store@example.com')
      expect(digest).toContain('Order Receipt')
      expect(digest).toContain('pay@example.com')
      expect(digest).toContain(
        'Tuning Action: Update ScriptProperty CUSTOM_PROMPT_RULES'
      )
    })

    test('handles report with missing or malformed finding properties without throwing', () => {
      const malformedReport = {
        scannedCount: 1,
        flaggedCount: 1,
        findings: [
          {
            threadId: 't-bad',
            subject: null,
            sender: undefined,
            canonicalLabels: null,
            flags: null,
          },
        ],
        summary: 'Audited 1 thread(s); 1 anomaly flag(s) identified.',
      }

      expect(() => {
        const digest = formatAuditDigest(malformedReport)
        expect(digest).toContain('(no subject)')
        expect(digest).toContain('(unknown)')
        expect(digest).toContain('(none)')
      }).not.toThrow()
    })
  })
})
