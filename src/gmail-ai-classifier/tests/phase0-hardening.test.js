/**
 * Phase 0 hardening: word-bounded matching, field-scoped exclusions, shield
 * fixes, sharded note paths, marker idempotency and the 1 MB Contents API guard.
 */

const gitHubSync = require('../gitHubSync.gs')

const modules = [
  ['code.gs', require('../code.gs')],
  ['src/index.js', require('../src/index.js')],
]

describe.each(modules)('Phase 0 rule hardening (%s)', (_name, mod) => {
  const classify = (sender, subject, snippet, config) =>
    mod.deterministicRuleClassify_(sender, subject, snippet, null, config || {})

  describe('word-bounded subject matching in any-mode rules', () => {
    test('"Unified" in a subject from an unrelated sender is not UniFi telemetry', () => {
      const res = classify(
        'Enrollment Office <office@springfield-usd.org>',
        'Unified School District enrollment packet',
        'Please complete the attached enrollment forms.'
      )
      expect(res === null || res.reasoning !== 'UniFi Telemetry').toBe(true)
    })

    test('a real UniFi subject and the UniFi sender still match', () => {
      expect(
        classify(
          'controller@home.example',
          'UniFi alert: gateway offline',
          'Your gateway went offline.'
        )
      ).toEqual(expect.objectContaining({ reasoning: 'UniFi Telemetry' }))
      expect(
        classify(
          'UniFi <noreply@ui.com>',
          'Device adopted',
          'A new device was adopted.'
        )
      ).toEqual(expect.objectContaining({ reasoning: 'UniFi Telemetry' }))
    })

    test('containsAnyWord_ honours boundaries only on alphanumeric term edges', () => {
      expect(mod.containsAnyWord_('unified district', 'unifi')).toBe(false)
      expect(mod.containsAnyWord_('new unifi alert', 'unifi')).toBe(true)
      expect(mod.containsAnyWord_('[pypi] release', '[pypi]')).toBe(true)
      expect(mod.containsAnyWord_('billing address', 'bill')).toBe(false)
      expect(mod.containsAnyWord_('the bill, please', 'bill')).toBe(true)
      expect(mod.containsAnyWord_('', 'bill')).toBe(false)
      expect(mod.containsAnyWord_('a b', '')).toBe(false)
    })
  })

  describe('field-scoped exclusions', () => {
    test('PayPal receipt whose body mentions a billing address stays on the fast path', () => {
      expect(
        classify(
          'PayPal <service@paypal.com>',
          'Receipt for your payment to Example Store',
          'Billing address: 1 Main St. Invoice ID: 123. Paid due to your order.'
        )
      ).toEqual(
        expect.objectContaining({
          subLabel: 'Finance/Purchases',
          action: 'archive',
        })
      )
    })

    test('PayPal receipt whose body says the payment failed falls through', () => {
      expect(
        classify(
          'PayPal <service@paypal.com>',
          'Receipt for your payment to Example Store',
          'Your payment failed and the merchant was not paid.'
        )
      ).toBeNull()
    })

    test('newsletter mentioning national security is still routed as Social', () => {
      expect(
        classify(
          'The Daily <nytdirect@nytimes.com>',
          'The Morning: a new budget deal',
          'Lawmakers debated national security and social security funding.'
        )
      ).toEqual(expect.objectContaining({ category: 'Social' }))
    })

    test('AI product update mentioning SSO login keeps the fast path', () => {
      expect(
        classify(
          'Claude <no-reply@email.claude.com>',
          'What’s new in Claude: projects and SSO',
          'Admins can now enforce SSO login and security fixes shipped.'
        )
      ).toEqual(
        expect.objectContaining({ reasoning: 'AI Platform Product Update' })
      )
    })
  })

  describe('insurance claim / EOB notices', () => {
    const sender = 'Blue Cross <noreply@bcbsal.org>'

    test('routine EOB with appeal-rights boilerplate is archived', () => {
      expect(
        classify(
          sender,
          'Your Explanation of Benefits is ready',
          'This is not a bill. You have the right to appeal this decision.'
        )
      ).toEqual(
        expect.objectContaining({
          reasoning: 'Insurance Claim / EOB Notice',
          action: 'archive',
        })
      )
    })

    test('denials and records requests are not auto-archived', () => {
      expect(
        classify(sender, 'Claim denied - appeal deadline', 'See details.')
      ).toBeNull()
      expect(
        classify(
          sender,
          'Update on your claim',
          'Your claim was denied because we need medical records.'
        )
      ).toBeNull()
    })
  })

  describe('career shield', () => {
    test('cold sales outreach with an "introductory call" is not career mail', () => {
      const res = classify(
        'Alex <alex@saasvendor.example>',
        'Introductory call next week?',
        'I would love to discuss the opportunity to cut your cloud costs.'
      )
      expect(res === null || res.canonicalDomain !== '06_Work_Career').toBe(
        true
      )
    })

    test('volunteer "opportunities at" is not career mail', () => {
      const res = classify(
        'Food Bank <news@foodbank.example>',
        'Volunteer opportunities at the food bank',
        'Sign up for a shift this weekend.'
      )
      expect(res === null || res.canonicalDomain !== '06_Work_Career').toBe(
        true
      )
    })

    test('recruiter outreach with an introductory call is career mail', () => {
      expect(
        classify(
          'Sam <sam@talentfirm.example>',
          'Introductory call about a platform role',
          'I am a recruiter hiring for a staff engineering position.'
        )
      ).toEqual(
        expect.objectContaining({
          canonicalDomain: '06_Work_Career',
          category: 'Primary',
        })
      )
    })

    test('strong career subjects still match without context', () => {
      expect(
        classify(
          'HR <hr@company.example>',
          'Your Offer Letter',
          'Please review the attached.'
        )
      ).toEqual(expect.objectContaining({ canonicalDomain: '06_Work_Career' }))
    })
  })

  describe('document signature shield', () => {
    test('files signature requests by content', () => {
      expect(
        classify(
          'DocuSign <dse@docusign.net>',
          'Please DocuSign: Field Trip Permission Slip',
          'Your student needs a signed permission slip.'
        )
      ).toEqual(
        expect.objectContaining({
          canonicalDomain: '04_Family_Health',
          subLabel: 'Family/School-Student',
          category: 'Primary',
        })
      )
      expect(
        classify(
          'DocuSign <dse@docusign.net>',
          'Please DocuSign: Patient consent for treatment',
          'Your clinic has sent a document to review and sign.'
        )
      ).toEqual(
        expect.objectContaining({
          canonicalDomain: '04_Family_Health',
          subLabel: 'Family/Medical',
        })
      )
      expect(
        classify(
          'DocuSign <dse@docusign.net>',
          'Please DocuSign: Lease renewal',
          'Your landlord has sent you a document to review and sign.'
        )
      ).toEqual(
        expect.objectContaining({
          canonicalDomain: '02_Finance_Legal',
          subLabel: 'Finance/Legal',
        })
      )
    })

    test('a request from a non-platform sender is still kept in Primary', () => {
      expect(
        classify(
          'Paralegal <office@lawfirm.example>',
          'Signature requested: settlement release',
          'Please review and sign.'
        )
      ).toEqual(
        expect.objectContaining({
          canonicalDomain: '02_Finance_Legal',
          subLabel: 'Finance/Legal',
          category: 'Primary',
          action: 'keep',
        })
      )
    })

    test('signatureDocumentFiling_ maps employment paperwork to Work/Career', () => {
      expect(
        mod.signatureDocumentFiling_('please docusign: offer letter', '')
      ).toEqual(['06_Work_Career', 'Work/Career'])
    })
  })

  describe('security warning shield', () => {
    test('bank fraud alerts are filed with banking', () => {
      expect(
        classify(
          'Chase <no.reply.alerts@chase.com>',
          'Unusual activity on your account',
          'We noticed a charge you may not recognize.'
        )
      ).toEqual(
        expect.objectContaining({
          canonicalDomain: '02_Finance_Legal',
          subLabel: 'Finance/Banking',
          category: 'Primary',
          action: 'keep',
        })
      )
    })

    test('a suspicious sign-in stays with tech security', () => {
      expect(
        classify(
          'Google <no-reply@accounts.google.com>',
          'Suspicious sign-in prevented',
          'Someone tried to sign in to your account.'
        )
      ).toEqual(
        expect.objectContaining({
          canonicalDomain: '05_Tech_Infrastructure',
          subLabel: 'Tech/Security',
        })
      )
    })
  })

  describe('school routing', () => {
    test('tuition bills from a school domain stay in Primary', () => {
      expect(
        classify(
          'Business Office <billing@school.example>',
          'Tuition billing statement for November',
          'Your balance is shown below.',
          { schoolDomains: 'school.example' }
        )
      ).toEqual(
        expect.objectContaining({
          subLabel: 'Family/School-Student',
          category: 'Primary',
          action: 'keep',
        })
      )
    })

    test('a configured full address matches that sender exactly', () => {
      const config = { schoolDomains: 'admissions@college.example' }
      expect(
        classify(
          'Admissions <admissions@college.example>',
          'Your campus visit',
          'We look forward to meeting you.',
          config
        )
      ).toEqual(expect.objectContaining({ reasoning: 'Teacher 1:1 Shield' }))
      const other = classify(
        'Alumni <alumni@college.example>',
        'Your campus visit',
        'We look forward to meeting you.',
        config
      )
      expect(other === null || other.reasoning !== 'Teacher 1:1 Shield').toBe(
        true
      )
    })
  })

  describe('note paths and entries', () => {
    const originalProps = global.PropertiesService
    afterEach(() => {
      global.PropertiesService = originalProps
    })
    const withProps = (all) => {
      global.PropertiesService = {
        getScriptProperties: () => ({
          getProperties: () => all,
          getProperty: (k) => all[k] || null,
        }),
      }
    }

    test('quarterly and monthly sharding', () => {
      withProps({ NOTE_LOG_SHARDING: 'quarterly' })
      expect(
        mod.getNotePathForDomain('02_Finance_Legal', null, '2026-11-12')
      ).toBe('02_Finance_Legal/activity/2026-Q4.md')
      expect(
        mod.getNotePathForDomain(
          '03_Vehicles',
          null,
          new Date(Date.UTC(2027, 0, 5))
        )
      ).toBe('03_Vehicles/activity/2027-Q1.md')
      withProps({ NOTE_LOG_SHARDING: 'monthly' })
      expect(mod.getNotePathForDomain('01_Household', null, '2026-03-02')).toBe(
        '01_Household/activity/2026-03.md'
      )
    })

    test('unsharded, undated, custom and unknown paths', () => {
      withProps({})
      expect(mod.getNotePathForDomain('01_Household', null, '2026-11-12')).toBe(
        '01_Household/index.md'
      )
      withProps({ NOTE_LOG_SHARDING: 'quarterly' })
      expect(mod.getNotePathForDomain('01_Household', null, 'n/a')).toBe(
        '01_Household/index.md'
      )
      expect(mod.getNotePathForDomain('99_Unknown', null, '2026-11-12')).toBe(
        null
      )
      withProps({
        NOTE_LOG_SHARDING: 'quarterly',
        CUSTOM_NOTE_PATHS: JSON.stringify({ '01_Household': 'home/log.md' }),
      })
      expect(mod.getNotePathForDomain('01_Household', null, '2026-11-12')).toBe(
        'home/log.md'
      )
    })

    test('noteLogShardSuffix_ rejects unreadable dates', () => {
      expect(mod.noteLogShardSuffix_('', 'quarterly')).toBe('')
      expect(mod.noteLogShardSuffix_('2026-13-01', 'quarterly')).toBe('')
      expect(mod.noteLogShardSuffix_(new Date('x'), 'monthly')).toBe('')
    })

    test('entries carry a source marker when a source is given', () => {
      const entry = mod.formatProgressiveDisclosureEntry(
        '2026-11-12',
        'Shell E-Receipt',
        'Shell <receipts@ereceiptshell.com>',
        'Shell E-Receipt',
        'Fuel purchase.',
        'user@example.com',
        [],
        'gmail thread=abc msg=def'
      )
      expect(entry).toContain('<!-- source: gmail thread=abc msg=def -->')
      expect(
        mod.formatProgressiveDisclosureEntry(
          '2026-11-12',
          'T',
          'S',
          'T',
          '',
          'user@example.com',
          []
        )
      ).not.toContain('<!-- source:')
    })
  })

  test('NOTE_EXCLUDED_SUBLABELS matches exact labels and branches', () => {
    const cfg = { noteExcludedSubLabels: ' Tech/Alerts , Promotions/* ' }
    expect(mod.isSubLabelExcludedFromNotes_('tech/alerts', cfg)).toBe(true)
    expect(mod.isSubLabelExcludedFromNotes_('Tech/Security', cfg)).toBe(false)
    expect(mod.isSubLabelExcludedFromNotes_('Promotions/Retail', cfg)).toBe(
      true
    )
    expect(mod.isSubLabelExcludedFromNotes_('Promotions', cfg)).toBe(true)
    expect(mod.isSubLabelExcludedFromNotes_('', cfg)).toBe(false)
    expect(mod.isSubLabelExcludedFromNotes_('Tech/Alerts', {})).toBe(false)
  })

  test('career recovery search excludes promotional categories', () => {
    const queries = []
    const gmail = {
      search: (q) => {
        queries.push(q)
        return []
      },
      getUserLabelByName: () => ({ getName: () => 'x' }),
      createLabel: () => ({ getName: () => 'x' }),
    }
    mod.revertAndQueueMissedCareerEmails(gmail, {
      processedLabel: 'Processed',
      retryLabel: 'AI/Needs-Retry',
    })
    expect(queries.length).toBe(1)
    expect(queries[0]).toContain('-category:promotions')
  })
})

describe('processEmailsWithAiClassifier no longer runs the career recovery sweep', () => {
  const originalProps = global.PropertiesService
  const originalGetConfig = global.getAiClassifierConfig
  afterEach(() => {
    global.PropertiesService = originalProps
    global.getAiClassifierConfig = originalGetConfig
  })

  test.each(modules)('%s', (_name, mod) => {
    // code.gs reads its config through the Apps Script global scope.
    global.getAiClassifierConfig = require('../config.gs').getAiClassifierConfig
    const all = { GEMINI_API_KEY: 'test-key' }
    global.PropertiesService = {
      getScriptProperties: () => ({
        getProperties: () => all,
        getProperty: (k) => all[k] || null,
        setProperty: (k, v) => {
          all[k] = v
        },
        deleteProperty: (k) => {
          delete all[k]
        },
      }),
    }
    const queries = []
    const gmail = {
      search: (q) => {
        queries.push(q)
        return []
      },
    }
    mod.processEmailsWithAiClassifier(undefined, { GmailApp: gmail })
    expect(queries.length).toBeGreaterThan(0)
    expect(queries.some((q) => q.indexOf('Employment Agreement') !== -1)).toBe(
      false
    )
  })
})

describe('gitHubSync.gs hardening', () => {
  const originalProps = global.PropertiesService
  const originalFetch = global.UrlFetchApp
  const originalUtils = global.Utilities
  let props

  const b64 = (s) => Buffer.from(s, 'utf8').toString('base64')
  const utils = {
    base64Decode: (s) => Buffer.from(s, 'base64'),
    base64Encode: (bytes) => Buffer.from(bytes).toString('base64'),
    newBlob: (data) => ({
      getDataAsString: () => Buffer.from(data).toString('utf8'),
      getBytes: () => Buffer.from(data, 'utf8'),
    }),
    formatDate: () => '2026-11-12',
  }

  beforeEach(() => {
    props = {
      GITHUB_PAT: 'token',
      GITHUB_REPO_OWNER: 'owner',
      GITHUB_REPO_NAME: 'repo',
    }
    global.PropertiesService = {
      getScriptProperties: () => ({
        getProperty: (k) => props[k] || null,
        setProperty: (k, v) => {
          props[k] = v
        },
      }),
    }
    global.Utilities = utils
  })

  afterEach(() => {
    global.PropertiesService = originalProps
    global.UrlFetchApp = originalFetch
    global.Utilities = originalUtils
  })

  const fetchReturning = (getBody) => {
    const calls = []
    global.UrlFetchApp = {
      fetch: (url, opts) => {
        calls.push(opts.method)
        if (opts.method === 'get') {
          return {
            getResponseCode: () => 200,
            getContentText: () => JSON.stringify(getBody),
          }
        }
        return { getResponseCode: () => 200, getContentText: () => '{}' }
      },
    }
    return calls
  }

  test('refuses to overwrite a note over the 1 MB read limit, without retrying', () => {
    const calls = fetchReturning({
      sha: 'abc',
      size: 1200000,
      encoding: 'none',
      content: '',
    })
    const sleeps = []
    const ok = gitHubSync.appendMarkdownEntryToGitHubRepo(
      '02_Finance_Legal/index.md',
      '\n### 2026-11-12 — Entry\n',
      'feat(ingestion): Entry',
      { sleepFn: (ms) => sleeps.push(ms) }
    )
    expect(ok).toBe(false)
    expect(calls).toEqual(['get'])
    expect(sleeps).toEqual([])
    expect(props.GITHUB_SYNC_LAST_STATUS).toContain('FILE_TOO_LARGE')
  })

  test('refuses when a non-empty file decodes to nothing', () => {
    fetchReturning({ sha: 'abc', size: 500, content: '' })
    expect(
      gitHubSync.executeGitHubCommit(
        'a/index.md',
        '\n### x\n',
        'feat(ingestion): x',
        'token'
      )
    ).toBe('FILE_TOO_LARGE')
  })

  test('source markers decide idempotency, not entry text', () => {
    const existing =
      '## 3. Ingested Activity Logs\n<details open>\n### 2026-11-12 — Shell E-Receipt\n<!-- source: gmail thread=t1 msg=m1 -->\n</details>\n'
    const calls = fetchReturning({
      sha: 'abc',
      size: existing.length,
      content: b64(existing),
    })
    // Same marker, different wording: skipped.
    expect(
      gitHubSync.executeGitHubCommit(
        'a/activity/2026-Q4.md',
        '\n### 2026-11-12 — Shell receipt (reworded)\n<!-- source: gmail thread=t1 msg=m1 -->\n',
        'feat(ingestion): Shell E-Receipt',
        'token'
      )
    ).toBe('IDEMPOTENT_SKIP')
    // Same text and commit message, different message: committed.
    expect(
      gitHubSync.executeGitHubCommit(
        'a/activity/2026-Q4.md',
        '\n### 2026-11-12 — Shell E-Receipt\n<!-- source: gmail thread=t2 msg=m2 -->\n',
        'feat(ingestion): Shell E-Receipt',
        'token'
      )
    ).toBe(true)
    expect(calls).toEqual(['get', 'get', 'put'])
  })

  test('records OK and NO_TOKEN statuses', () => {
    fetchReturning({ sha: 'abc', size: 3, content: b64('abc') })
    expect(
      gitHubSync.appendMarkdownEntryToGitHubRepo(
        'a/index.md',
        '\n### new\n',
        'feat(ingestion): new'
      )
    ).toBe(true)
    expect(props.GITHUB_SYNC_LAST_STATUS).toMatch(/ OK a\/index\.md$/)
    delete props.GITHUB_PAT
    expect(
      gitHubSync.appendMarkdownEntryToGitHubRepo('a/index.md', 'x', 'y')
    ).toBe(false)
    expect(props.GITHUB_SYNC_LAST_STATUS).toContain('NO_TOKEN')
  })

  test('status recording never throws', () => {
    global.PropertiesService = {
      getScriptProperties: () => {
        throw new Error('boom')
      },
    }
    expect(() =>
      gitHubSync.recordGitHubSyncStatus_(null, 'OK', 'x')
    ).not.toThrow()
  })

  test('shard files get a domain-and-period title', () => {
    expect(
      gitHubSync.extractTopicTitleFromPath(
        '02_Finance_Legal/activity/2026-Q4.md'
      )
    ).toBe('02_Finance_Legal activity log 2026-Q4')
    expect(gitHubSync.extractEntrySourceMarker_('no marker here')).toBe('')
  })
})
