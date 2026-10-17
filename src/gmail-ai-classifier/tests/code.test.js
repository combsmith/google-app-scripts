const {
  validateClassification,
  classifyEmailWithGemini,
  ensureGmailLabel,
  createPermanentGmailFilter,
  processThreadBatch,
} = require('../src/index.js')

const TEST_DOMAINS = [
  '01_Household/Primary_House',
  '02_Finance_Legal/Taxes',
  '04_Family_Health/General',
]

const makeConfig = (overrides = {}) => ({
  modelEndpoint:
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent',
  geminiApiKey: process.env.TEST_GEMINI_API_KEY || '',
  processedLabel: 'Processed',
  autoFilterConfidenceThreshold: 0.95,
  canonicalDomains: TEST_DOMAINS,
  ...overrides,
})

const makeLabel = (name) => ({
  getName: () => name,
  getId: () => 'label-' + name,
})

const makeGmailApp = ({ existingLabel = null, createFails = false } = {}) => ({
  getUserLabelByName: jest.fn(() => existingLabel),
  createLabel: createFails
    ? jest.fn(() => {
        throw new Error('Label creation failed')
      })
    : jest.fn((name) => makeLabel(name)),
})

const makeThread = ({
  id = 't1',
  sender = 'user@example.com',
  subject = 'Test',
  body = 'body text',
} = {}) => ({
  getId: () => id,
  getMessages: () => [
    {
      getFrom: () => sender,
      getSubject: () => subject,
      getPlainBody: () => body,
    },
  ],
  addLabel: jest.fn(),
})

const makeGeminiResponse = (classification) => ({
  getResponseCode: () => 200,
  getContentText: () =>
    JSON.stringify({
      candidates: [
        { content: { parts: [{ text: JSON.stringify(classification) }] } },
      ],
    }),
})

// ---------------------------------------------------------------------------
// validateClassification
// ---------------------------------------------------------------------------
describe('validateClassification', () => {
  test('returns true for a valid classification matching a canonical domain', () => {
    expect(
      validateClassification(
        {
          canonical_label: '01_Household/Primary_House',
          confidence: 0.97,
          reasoning: 'ok',
        },
        TEST_DOMAINS
      )
    ).toBe(true)
  })

  test('returns false when canonical_label is missing', () => {
    expect(validateClassification({ confidence: 0.9 }, TEST_DOMAINS)).toBe(
      false
    )
  })

  test('returns false when confidence is above 1', () => {
    expect(
      validateClassification(
        { canonical_label: '01_Household/Primary_House', confidence: 1.5 },
        TEST_DOMAINS
      )
    ).toBe(false)
  })

  test('returns false when confidence is below 0', () => {
    expect(
      validateClassification(
        { canonical_label: '01_Household/Primary_House', confidence: -0.1 },
        TEST_DOMAINS
      )
    ).toBe(false)
  })

  test('returns false when confidence is NaN', () => {
    expect(
      validateClassification(
        {
          canonical_label: '01_Household/Primary_House',
          confidence: NaN,
          reasoning: 'ok',
        },
        TEST_DOMAINS
      )
    ).toBe(false)
  })

  test('returns false for null input', () => {
    expect(validateClassification(null, TEST_DOMAINS)).toBe(false)
  })

  test('returns false when label is not in canonical domains', () => {
    expect(
      validateClassification(
        { canonical_label: 'Unknown/Domain', confidence: 0.9, reasoning: 'ok' },
        TEST_DOMAINS
      )
    ).toBe(false)
  })

  test('returns false when reasoning is missing', () => {
    expect(
      validateClassification(
        { canonical_label: '01_Household/Primary_House', confidence: 0.9 },
        TEST_DOMAINS
      )
    ).toBe(false)
  })

  test('returns false when reasoning is not a string', () => {
    expect(
      validateClassification(
        {
          canonical_label: '01_Household/Primary_House',
          confidence: 0.9,
          reasoning: 42,
        },
        TEST_DOMAINS
      )
    ).toBe(false)
  })

  test('skips domain check when canonicalDomains is omitted', () => {
    expect(
      validateClassification({
        canonical_label: 'Anything',
        confidence: 0.8,
        reasoning: 'ok',
      })
    ).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// ensureGmailLabel
// ---------------------------------------------------------------------------
describe('ensureGmailLabel', () => {
  test('returns existing label without creating a new one', () => {
    const existing = makeLabel('Processed')
    const gmailApp = makeGmailApp({ existingLabel: existing })
    expect(ensureGmailLabel('Processed', gmailApp)).toBe(existing)
    expect(gmailApp.createLabel).not.toHaveBeenCalled()
  })

  test('creates and returns label when it does not exist', () => {
    const gmailApp = makeGmailApp()
    const label = ensureGmailLabel('NewLabel', gmailApp)
    expect(gmailApp.createLabel).toHaveBeenCalledWith('NewLabel')
    expect(label.getName()).toBe('NewLabel')
  })

  test('returns null when label creation throws', () => {
    const gmailApp = makeGmailApp({ createFails: true })
    expect(ensureGmailLabel('FailLabel', gmailApp)).toBeNull()
  })

  test('creates label via advanced Gmail service with messageListVisibility: hide when available', () => {
    const mockCreated = makeLabel('AdvancedLabel')
    let advancedCall = null
    const gmailAdvanced = {
      Users: {
        Labels: {
          create: jest.fn((params, userId) => {
            advancedCall = { params, userId }
            return { id: 'adv-1', name: params.name }
          }),
        },
      },
    }
    const gmailApp = {
      getUserLabelByName: jest.fn((name) => {
        if (advancedCall && name === 'AdvancedLabel') return mockCreated
        return null
      }),
      createLabel: jest.fn(),
    }
    const label = ensureGmailLabel('AdvancedLabel', gmailApp, gmailAdvanced)
    expect(label).toBe(mockCreated)
    expect(gmailAdvanced.Users.Labels.create).toHaveBeenCalledWith(
      {
        name: 'AdvancedLabel',
        labelListVisibility: 'labelShow',
        messageListVisibility: 'hide',
      },
      'me'
    )
    expect(gmailApp.createLabel).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// createPermanentGmailFilter
// ---------------------------------------------------------------------------
describe('createPermanentGmailFilter', () => {
  const makeGmailService = (
    createFn = jest.fn(),
    listFn = jest.fn(() => ({ filter: [] }))
  ) => ({
    Users: { Settings: { Filters: { create: createFn, list: listFn } } },
  })

  test('returns false without throwing when senderEmail is null, undefined, or empty', () => {
    const gmailApp = makeGmailApp()
    expect(
      createPermanentGmailFilter(
        null,
        '01_Household/Primary_House',
        makeGmailService(),
        gmailApp
      )
    ).toBe(false)
    expect(
      createPermanentGmailFilter(
        undefined,
        '01_Household/Primary_House',
        makeGmailService(),
        gmailApp
      )
    ).toBe(false)
    expect(
      createPermanentGmailFilter(
        '',
        '01_Household/Primary_House',
        makeGmailService(),
        gmailApp
      )
    ).toBe(false)
  })

  test('creates filter via Gmail service and returns true', () => {
    const gmailApp = makeGmailApp({
      existingLabel: makeLabel('01_Household/Primary_House'),
    })
    const mockCreate = jest.fn()
    const result = createPermanentGmailFilter(
      'sender@example.com',
      '01_Household/Primary_House',
      makeGmailService(mockCreate),
      gmailApp
    )
    expect(result).toBe(true)
    expect(mockCreate).toHaveBeenCalledWith(
      {
        criteria: { from: 'sender@example.com' },
        action: { addLabelIds: ['label-01_Household/Primary_House'] },
      },
      'me'
    )
  })

  test('extracts bare email address from "Display Name <email>" format', () => {
    const gmailApp = makeGmailApp({
      existingLabel: makeLabel('01_Household/Primary_House'),
    })
    const mockCreate = jest.fn()
    createPermanentGmailFilter(
      'John Doe <john@example.com>',
      '01_Household/Primary_House',
      makeGmailService(mockCreate),
      gmailApp
    )
    expect(mockCreate.mock.calls[0][0].criteria.from).toBe('john@example.com')
  })

  test('returns false when Gmail advanced service is null', () => {
    const gmailApp = makeGmailApp({
      existingLabel: makeLabel('01_Household/Primary_House'),
    })
    expect(
      createPermanentGmailFilter(
        'sender@example.com',
        '01_Household/Primary_House',
        null,
        gmailApp
      )
    ).toBe(false)
  })

  test('returns false when target label cannot be created', () => {
    const gmailApp = makeGmailApp({ createFails: true })
    expect(
      createPermanentGmailFilter(
        'sender@example.com',
        '01_Household/Primary_House',
        makeGmailService(),
        gmailApp
      )
    ).toBe(false)
  })

  test('returns false when Gmail service create throws', () => {
    const gmailApp = makeGmailApp({
      existingLabel: makeLabel('01_Household/Primary_House'),
    })
    const throwingService = makeGmailService(
      jest.fn(() => {
        throw new Error('API error')
      })
    )
    expect(
      createPermanentGmailFilter(
        'sender@example.com',
        '01_Household/Primary_House',
        throwingService,
        gmailApp
      )
    ).toBe(false)
  })

  test('returns true without creating a duplicate filter for the same sender', () => {
    const gmailApp = makeGmailApp({
      existingLabel: makeLabel('01_Household/Primary_House'),
    })
    const mockCreate = jest.fn()
    const mockList = jest.fn(() => ({
      filter: [{ criteria: { from: 'sender@example.com' } }],
    }))
    const result = createPermanentGmailFilter(
      'sender@example.com',
      '01_Household/Primary_House',
      makeGmailService(mockCreate, mockList),
      gmailApp
    )
    expect(result).toBe(true)
    expect(mockCreate).not.toHaveBeenCalled()
  })

  test('extracts bare address before duplicate check with display-name format', () => {
    const gmailApp = makeGmailApp({
      existingLabel: makeLabel('01_Household/Primary_House'),
    })
    const mockCreate = jest.fn()
    const mockList = jest.fn(() => ({
      filter: [{ criteria: { from: 'john@example.com' } }],
    }))
    const result = createPermanentGmailFilter(
      'John Doe <john@example.com>',
      '01_Household/Primary_House',
      makeGmailService(mockCreate, mockList),
      gmailApp
    )
    expect(result).toBe(true)
    expect(mockCreate).not.toHaveBeenCalled()
  })

  test('creates filter when no existing filter matches the sender', () => {
    const gmailApp = makeGmailApp({
      existingLabel: makeLabel('01_Household/Primary_House'),
    })
    const mockCreate = jest.fn()
    const mockList = jest.fn(() => ({
      filter: [{ criteria: { from: 'other@example.com' } }],
    }))
    const result = createPermanentGmailFilter(
      'sender@example.com',
      '01_Household/Primary_House',
      makeGmailService(mockCreate, mockList),
      gmailApp
    )
    expect(result).toBe(true)
    expect(mockCreate).toHaveBeenCalled()
  })

  test('still creates filter when list call throws', () => {
    const gmailApp = makeGmailApp({
      existingLabel: makeLabel('01_Household/Primary_House'),
    })
    const mockCreate = jest.fn()
    const throwingList = jest.fn(() => {
      throw new Error('List failed')
    })
    const result = createPermanentGmailFilter(
      'sender@example.com',
      '01_Household/Primary_House',
      makeGmailService(mockCreate, throwingList),
      gmailApp
    )
    expect(result).toBe(true)
    expect(mockCreate).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// classifyEmailWithGemini
// ---------------------------------------------------------------------------
describe('classifyEmailWithGemini', () => {
  const config = makeConfig()

  test('returns validated classification on successful API response', () => {
    const classification = {
      canonical_label: '01_Household/Primary_House',
      confidence: 0.97,
      reasoning: 'test',
    }
    const urlFetchApp = {
      fetch: jest.fn(() => makeGeminiResponse(classification)),
    }
    expect(
      classifyEmailWithGemini(
        config,
        'test@example.com',
        'Subject',
        'body',
        urlFetchApp
      )
    ).toEqual(classification)
  })

  test('returns null when API call throws a network error', () => {
    const urlFetchApp = {
      fetch: jest.fn(() => {
        throw new Error('Network error')
      }),
    }
    expect(
      classifyEmailWithGemini(
        config,
        'test@example.com',
        'Subject',
        'body',
        urlFetchApp
      )
    ).toBeNull()
  })

  test('returns null when API response contains invalid JSON', () => {
    const urlFetchApp = {
      fetch: jest.fn(() => ({
        getResponseCode: () => 200,
        getContentText: () => 'not-json',
      })),
    }
    expect(
      classifyEmailWithGemini(
        config,
        'test@example.com',
        'Subject',
        'body',
        urlFetchApp
      )
    ).toBeNull()
  })

  test('returns null when classification label is not in canonical domains', () => {
    const classification = {
      canonical_label: 'Unknown/Domain',
      confidence: 0.97,
      reasoning: 'test',
    }
    const urlFetchApp = {
      fetch: jest.fn(() => makeGeminiResponse(classification)),
    }
    expect(
      classifyEmailWithGemini(
        config,
        'test@example.com',
        'Subject',
        'body',
        urlFetchApp
      )
    ).toBeNull()
  })

  test('returns null when confidence is out of range', () => {
    const classification = {
      canonical_label: '01_Household/Primary_House',
      confidence: 1.5,
      reasoning: 'test',
    }
    const urlFetchApp = {
      fetch: jest.fn(() => makeGeminiResponse(classification)),
    }
    expect(
      classifyEmailWithGemini(
        config,
        'test@example.com',
        'Subject',
        'body',
        urlFetchApp
      )
    ).toBeNull()
  })

  test('returns null after retrying a 429 response the maximum number of times', () => {
    jest.useFakeTimers()
    try {
      const urlFetchApp = {
        fetch: jest.fn(() => ({
          getResponseCode: () => 429,
          getContentText: () => '{"error":"rate limited"}',
        })),
      }
      const mockSleep = jest.fn()
      expect(
        classifyEmailWithGemini(
          config,
          'test@example.com',
          'Subject',
          'body',
          urlFetchApp,
          mockSleep
        )
      ).toBeNull()
      expect(urlFetchApp.fetch).toHaveBeenCalledTimes(3)
      expect(mockSleep).toHaveBeenCalledTimes(2)
    } finally {
      jest.useRealTimers()
    }
  })

  test('returns null after retrying a 500 response the maximum number of times', () => {
    jest.useFakeTimers()
    try {
      const urlFetchApp = {
        fetch: jest.fn(() => ({
          getResponseCode: () => 500,
          getContentText: () => '{"error":"server error"}',
        })),
      }
      const mockSleep = jest.fn()
      expect(
        classifyEmailWithGemini(
          config,
          'test@example.com',
          'Subject',
          'body',
          urlFetchApp,
          mockSleep
        )
      ).toBeNull()
      expect(urlFetchApp.fetch).toHaveBeenCalledTimes(3)
      expect(mockSleep).toHaveBeenCalledTimes(2)
    } finally {
      jest.useRealTimers()
    }
  })

  test('returns null immediately and does not retry a non-transient HTTP error', () => {
    const urlFetchApp = {
      fetch: jest.fn(() => ({
        getResponseCode: () => 400,
        getContentText: () => '{"error":"bad request"}',
      })),
    }
    expect(
      classifyEmailWithGemini(
        config,
        'test@example.com',
        'Subject',
        'body',
        urlFetchApp
      )
    ).toBeNull()
    expect(urlFetchApp.fetch).toHaveBeenCalledTimes(1)
  })

  test('returns classification on success after a transient failure', () => {
    jest.useFakeTimers()
    try {
      const classification = {
        canonical_label: '01_Household/Primary_House',
        confidence: 0.97,
        reasoning: 'test',
      }
      const urlFetchApp = {
        fetch: jest
          .fn()
          .mockReturnValueOnce({
            getResponseCode: () => 429,
            getContentText: () => '{}',
          })
          .mockReturnValueOnce(makeGeminiResponse(classification)),
      }
      const mockSleep = jest.fn()
      expect(
        classifyEmailWithGemini(
          config,
          'test@example.com',
          'Subject',
          'body',
          urlFetchApp,
          mockSleep
        )
      ).toEqual(classification)
      expect(urlFetchApp.fetch).toHaveBeenCalledTimes(2)
      expect(mockSleep).toHaveBeenCalledTimes(1)
    } finally {
      jest.useRealTimers()
    }
  })
})

// ---------------------------------------------------------------------------
// processThreadBatch
// ---------------------------------------------------------------------------
describe('processThreadBatch', () => {
  const config = makeConfig()

  const makeServices = ({
    fetchResponse = null,
    gmailService = null,
    labelExists = true,
  } = {}) => ({
    GmailApp: makeGmailApp({
      existingLabel: labelExists ? makeLabel('Processed') : null,
    }),
    UrlFetchApp: { fetch: jest.fn(() => fetchResponse) },
    Gmail: gmailService,
  })

  test('classifies and applies both category and processed labels on success', () => {
    const thread = makeThread()
    const classification = {
      canonical_label: '01_Household/Primary_House',
      confidence: 0.97,
      reasoning: 'ok',
    }
    const services = makeServices({
      fetchResponse: makeGeminiResponse(classification),
    })
    services.GmailApp.getUserLabelByName = jest.fn((name) => makeLabel(name))

    const results = processThreadBatch([thread], config, services)

    expect(results[0].status).toBe('classified')
    expect(results[0].label).toBe('01_Household/Primary_House')
    expect(thread.addLabel).toHaveBeenCalledTimes(2)
  })

  test('creates Gmail filter when confidence meets threshold', () => {
    const thread = makeThread()
    const classification = {
      canonical_label: '01_Household/Primary_House',
      confidence: 0.98,
      reasoning: 'ok',
    }
    const mockCreate = jest.fn()
    const services = {
      GmailApp: makeGmailApp({
        existingLabel: makeLabel('01_Household/Primary_House'),
      }),
      UrlFetchApp: { fetch: jest.fn(() => makeGeminiResponse(classification)) },
      Gmail: {
        Users: {
          Settings: {
            Filters: {
              create: mockCreate,
              list: jest.fn(() => ({ filter: [] })),
            },
          },
        },
      },
    }
    services.GmailApp.getUserLabelByName = jest.fn((name) => makeLabel(name))

    const results = processThreadBatch([thread], config, services)

    expect(results[0].filterCreated).toBe(true)
    expect(mockCreate).toHaveBeenCalled()
  })

  test('skips filter creation when confidence is below threshold', () => {
    const thread = makeThread()
    const classification = {
      canonical_label: '01_Household/Primary_House',
      confidence: 0.9,
      reasoning: 'ok',
    }
    const mockCreate = jest.fn()
    const services = {
      GmailApp: makeGmailApp({ existingLabel: makeLabel('Processed') }),
      UrlFetchApp: { fetch: jest.fn(() => makeGeminiResponse(classification)) },
      Gmail: { Users: { Settings: { Filters: { create: mockCreate } } } },
    }
    services.GmailApp.getUserLabelByName = jest.fn((name) => makeLabel(name))

    const results = processThreadBatch([thread], config, services)

    expect(results[0].filterCreated).toBe(false)
    expect(mockCreate).not.toHaveBeenCalled()
  })

  test('returns unclassified status when Gemini call fails', () => {
    const thread = makeThread()
    const services = {
      GmailApp: makeGmailApp({ existingLabel: makeLabel('Processed') }),
      UrlFetchApp: {
        fetch: jest.fn(() => {
          throw new Error('fail')
        }),
      },
      Gmail: null,
    }

    const results = processThreadBatch([thread], config, services)

    expect(results[0].status).toBe('unclassified')
    expect(thread.addLabel).not.toHaveBeenCalled()
  })

  test('returns empty status for thread with no messages', () => {
    const emptyThread = {
      getId: () => 'empty',
      getMessages: () => [],
      addLabel: jest.fn(),
    }
    const services = makeServices()

    const results = processThreadBatch([emptyThread], config, services)

    expect(results[0].status).toBe('empty')
  })

  test('returns label_creation_failed and skips processed label when category label creation fails', () => {
    const thread = makeThread()
    const classification = {
      canonical_label: '01_Household/Primary_House',
      confidence: 0.97,
      reasoning: 'ok',
    }
    const processedLabelObj = makeLabel('Processed')
    const gmailApp = {
      getUserLabelByName: jest.fn((name) =>
        name === 'Processed' ? processedLabelObj : null
      ),
      createLabel: jest.fn(() => {
        throw new Error('Label creation failed')
      }),
    }
    const services = {
      GmailApp: gmailApp,
      UrlFetchApp: { fetch: jest.fn(() => makeGeminiResponse(classification)) },
      Gmail: null,
    }

    const results = processThreadBatch([thread], config, services)

    expect(results[0].status).toBe('label_creation_failed')
    expect(thread.addLabel).not.toHaveBeenCalled()
  })

  test('returns empty array and aborts batch when processed label cannot be resolved', () => {
    const thread = makeThread()
    const services = {
      GmailApp: makeGmailApp({ createFails: true }),
      UrlFetchApp: { fetch: jest.fn() },
      Gmail: null,
    }

    const results = processThreadBatch([thread], config, services)

    expect(results).toEqual([])
    expect(thread.addLabel).not.toHaveBeenCalled()
    expect(services.UrlFetchApp.fetch).not.toHaveBeenCalled()
  })

  test('uses first message (not last) for classification in multi-message threads', () => {
    const originalSender = 'original@example.com'
    const replierSender = 'replier@example.com'
    const multiMessageThread = {
      getId: () => 'multi-t1',
      getMessages: () => [
        {
          getFrom: () => originalSender,
          getSubject: () => 'Original subject',
          getPlainBody: () => 'original body',
        },
        {
          getFrom: () => replierSender,
          getSubject: () => 'Re: Original subject',
          getPlainBody: () => 'reply body',
        },
      ],
      addLabel: jest.fn(),
    }
    const classification = {
      canonical_label: '01_Household/Primary_House',
      confidence: 0.97,
      reasoning: 'ok',
    }
    const mockFetch = jest.fn(() => makeGeminiResponse(classification))
    const services = {
      GmailApp: { getUserLabelByName: jest.fn((name) => makeLabel(name)) },
      UrlFetchApp: { fetch: mockFetch },
      Gmail: null,
    }

    processThreadBatch([multiMessageThread], config, services)

    const fetchCall = mockFetch.mock.calls[0]
    const requestBody = JSON.parse(fetchCall[1].payload)
    const promptText = requestBody.contents[0].parts[0].text
    expect(promptText).toContain(originalSender)
    expect(promptText).not.toContain(replierSender)
  })

  test('processes multiple threads independently', () => {
    const thread1 = makeThread({ id: 't1', sender: 'a@example.com' })
    const thread2 = makeThread({ id: 't2', sender: 'b@example.com' })
    const classification = {
      canonical_label: '01_Household/Primary_House',
      confidence: 0.97,
      reasoning: 'ok',
    }
    const services = {
      GmailApp: {
        getUserLabelByName: jest.fn((name) => makeLabel(name)),
        createLabel: jest.fn((name) => makeLabel(name)),
      },
      UrlFetchApp: { fetch: jest.fn(() => makeGeminiResponse(classification)) },
      Gmail: null,
    }

    const results = processThreadBatch([thread1, thread2], config, services)

    expect(results).toHaveLength(2)
    expect(results[0].threadId).toBe('t1')
    expect(results[1].threadId).toBe('t2')
  })

  test('persists attachments when services.DriveApp is provided', () => {
    const thread = makeThread({ id: 't-attach' })
    const classification = {
      canonical_label: '01_Household/Primary_House',
      confidence: 0.98,
      reasoning: 'ok',
    }
    const mockDriveApp = {
      getRootFolder: jest.fn(() => ({
        getFoldersByName: jest.fn(() => ({
          hasNext: () => true,
          next: () => ({
            getFoldersByName: jest.fn(() => ({
              hasNext: () => true,
              next: () => ({
                getFilesByName: jest.fn(() => ({ hasNext: () => false })),
                createFile: jest.fn(() => ({
                  getId: () => 'f1',
                  getName: () => 'file.pdf',
                  getUrl: () => 'https://drive.google.com/file/d/f1',
                })),
              }),
            })),
            createFolder: jest.fn(),
          }),
        })),
        createFolder: jest.fn(),
      })),
    }
    const services = {
      GmailApp: {
        getUserLabelByName: jest.fn((name) => makeLabel(name)),
        createLabel: jest.fn((name) => makeLabel(name)),
      },
      UrlFetchApp: { fetch: jest.fn(() => makeGeminiResponse(classification)) },
      Gmail: null,
      DriveApp: mockDriveApp,
    }

    const results = processThreadBatch([thread], config, services)
    expect(results).toHaveLength(1)
    expect(results[0].threadId).toBe('t-attach')
    expect(Array.isArray(results[0].savedAttachments)).toBe(true)
  })
})

describe('Ontological Knowledge Graph and Triage Matrix Prompt Architecture', () => {
  const codeGs = require('../code.gs')
  const { buildOntologicalPrompt } = require('../src/index')

  test('buildOntologicalPrompt builds 3-Tier positive invariant prompt without negative exclusions', () => {
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
      customPromptRules:
        'entities:\n  - name: "Entity Alpha"\n    domain: "04_Family_Health"\n    sublabel: "Family/Legal"',
    }

    const prompt = buildOntologicalPrompt(
      config,
      'alerts@example.com',
      'Alert - Entity Alpha',
      'Summary of news mention for Entity Alpha'
    )

    // Tier 1: Positive Domain Taxonomy Ontology
    expect(prompt).toContain(
      '=== TIER 1: DOMAIN TAXONOMY ONTOLOGY (POSITIVE INVARIANTS) ==='
    )
    expect(prompt).toContain('01_Household')
    expect(prompt).toContain('02_Finance_Legal')
    expect(prompt).toContain('03_Vehicles')
    expect(prompt).toContain('04_Family_Health')
    expect(prompt).toContain('05_Tech_Infrastructure')
    expect(prompt).toContain('06_Work_Career')
    expect(prompt).toContain('07_Community_NonProfit')
    expect(prompt).toContain('NON-CANONICAL EMAILS (canonicalDomain: null)')
    expect(prompt).toContain('Customer satisfaction surveys')
    expect(prompt).toContain('Political campaign communications')
    expect(prompt).toContain('equipment supply store sales')
    expect(prompt).toContain(
      'enterprise daily/weekly activity digests and newsletters'
    )

    // Positive Search & Monitoring Alerts routing
    expect(prompt).toContain('AUTOMATED SEARCH & MONITORING ALERTS')
    expect(prompt).toContain('Google Alerts')
    expect(prompt).toContain(
      'Student or school sub-labels apply only when the monitored alert query specifically targets an academic program or school'
    )

    // Tier 2: Orthogonal Triage Matrix
    expect(prompt).toContain(
      '=== TIER 2: ORTHOGONAL TRIAGE MATRIX (LIFECYCLE STATE) ==='
    )
    expect(prompt).toContain('Action_Required')
    expect(prompt).toContain('Informational_Feed')
    expect(prompt).toContain('Completed_Transaction')
    expect(prompt).toContain('Broadcast_Marketing')
    expect(prompt).toContain('Spam_Solicitation')
    expect(prompt).toContain('CATEGORY-DRIVEN INBOX RETENTION INVARIANT')
    expect(prompt).toContain(
      'Primary Inbox is an Action Queue: Only emails categorized as "Primary" belong in the Primary Inbox'
    )
    expect(prompt).toContain(
      'All non-Primary streams ("Updates", "Promotions", "Social", "Forums") are Informational Feeds that must be archived out of the Inbox'
    )

    // Tier 3: Injected Entity Knowledge Graph
    expect(prompt).toContain(
      '=== TIER 3: USER ENTITY KNOWLEDGE GRAPH & CUSTOM RULES ==='
    )
    expect(prompt).toContain('Entity Alpha')

    // Constraints & Contract
    expect(prompt).toContain('Single Sub-Label Invariant')
    expect(prompt).toContain('Return JSON ONLY')

    // Zero negative exclusions invariant verification
    expect(prompt).not.toContain('Under NO circumstances')
    expect(prompt).not.toContain('Do NOT classify')
    expect(prompt).not.toContain('Reserve strictly for')
  })

  test('classifyWithGemini in code.gs constructs and sends ontological prompt', () => {
    let capturedPrompt = ''
    global.UrlFetchApp = {
      fetch: jest.fn((url, opts) => {
        const payload = JSON.parse(opts.payload)
        capturedPrompt = payload.contents[0].parts[0].text
        return {
          getResponseCode: () => 200,
          getContentText: () =>
            JSON.stringify({
              candidates: [
                {
                  content: {
                    parts: [
                      {
                        text: JSON.stringify({
                          canonicalDomain: '04_Family_Health',
                          subLabel: 'Family/Legal',
                          category: 'Updates',
                          action: 'keep',
                          confidence: 0.98,
                          title: 'Alert Title',
                          summary: 'Executive summary',
                        }),
                      },
                    ],
                  },
                },
              ],
            }),
        }
      }),
    }

    const testConfig = {
      canonicalDomains: ['01_Household', '04_Family_Health'],
      geminiApiKey: 'test-key',
    }

    const result = codeGs.classifyWithGemini(
      'googlealerts-noreply@google.com',
      'Google Alert - Elder Relative',
      'news summary snippet',
      testConfig
    )

    expect(capturedPrompt).toContain(
      '=== TIER 1: DOMAIN TAXONOMY ONTOLOGY (POSITIVE INVARIANTS) ==='
    )
    expect(capturedPrompt).toContain(
      '=== TIER 2: ORTHOGONAL TRIAGE MATRIX (LIFECYCLE STATE) ==='
    )
    expect(capturedPrompt).toContain('Google Alerts')
    expect(capturedPrompt).not.toContain('Under NO circumstances')
    expect(result).toEqual({
      canonicalDomain: '04_Family_Health',
      subLabel: 'Family/Legal',
      category: 'Updates',
      action: 'keep',
      confidence: 0.98,
      title: 'Alert Title',
      summary: 'Executive summary',
    })
  })

  test('classifyWithGemini returns cached classification immediately on cache hit', () => {
    const cachedObj = {
      canonicalDomain: '01_Household',
      subLabel: 'Household/Property',
      category: 'Updates',
      action: 'archive',
      confidence: 0.99,
      title: 'Plumbing Receipt',
      summary: 'Water heater repair receipt.',
    }
    const mockCache = {
      get: jest.fn(() => JSON.stringify(cachedObj)),
      put: jest.fn(),
    }
    const mockFetch = jest.fn()

    const result = codeGs.classifyWithGemini(
      'contractor@plumbing.com',
      'Invoice #1042',
      'Water heater repaired.',
      { geminiApiKey: 'test-key' },
      { CacheService: mockCache, UrlFetchApp: { fetch: mockFetch } }
    )

    expect(result).toEqual(cachedObj)
    expect(mockCache.get).toHaveBeenCalled()
    expect(mockFetch).not.toHaveBeenCalled()
  })

  test('classifyWithGemini stores result in CacheService with 21600s TTL on cache miss', () => {
    const freshObj = {
      canonicalDomain: '02_Finance_Legal',
      subLabel: 'Finance/Banking',
      category: 'Updates',
      action: 'archive',
      confidence: 0.95,
      title: 'Monthly Statement',
      summary: 'Bank statement available.',
    }
    const mockCache = {
      get: jest.fn(() => null),
      put: jest.fn(),
    }
    const mockFetch = jest.fn(() => ({
      getResponseCode: () => 200,
      getContentText: () =>
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{ text: JSON.stringify(freshObj) }],
              },
            },
          ],
        }),
    }))

    const result = codeGs.classifyWithGemini(
      'alerts@bank.com',
      'e-Statement Ready',
      'Your monthly bank statement is now ready.',
      { geminiApiKey: 'test-key' },
      { CacheService: mockCache, UrlFetchApp: { fetch: mockFetch } }
    )

    expect(result).toEqual(freshObj)
    expect(mockCache.get).toHaveBeenCalled()
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(mockCache.put).toHaveBeenCalledWith(
      expect.stringMatching(/^cls_[a-f0-9]+$/),
      JSON.stringify(freshObj),
      21600
    )
  })

  test('classifyWithGemini cascades through fallback models on HTTP 429 and parses retry delay', () => {
    let callCount = 0
    const sleepMock = jest.fn()
    const mockFetch = jest.fn(() => {
      callCount++
      if (callCount === 1) {
        return {
          getResponseCode: () => 429,
          getHeaders: () => ({ 'Retry-After': '2' }),
          getContentText: () =>
            JSON.stringify({ error: { message: 'Quota exceeded' } }),
        }
      }
      return {
        getResponseCode: () => 200,
        getContentText: () =>
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: '```json\n{"canonicalDomain": "05_Tech_Infrastructure", "subLabel": "Tech/Alerts", "category": "Updates", "action": "archive", "confidence": 0.92, "title": "Server Alert", "summary": "High CPU alert."}\n```',
                    },
                  ],
                },
              },
            ],
          }),
      }
    })

    const result = codeGs.classifyWithGemini(
      'alerts@cloud.com',
      'CPU Warning',
      'Server CPU at 95%',
      {
        modelEndpoint:
          'https://generativelanguage.googleapis.com/v1beta/models/gemini-custom:generateContent',
        geminiApiKey: 'test-key',
      },
      { UrlFetchApp: { fetch: mockFetch }, sleepFn: sleepMock }
    )

    expect(callCount).toBe(2)
    expect(sleepMock).toHaveBeenCalledWith(2000)
    expect(result.canonicalDomain).toBe('05_Tech_Infrastructure')
  })

  test('extractJsonSubstring parses JSON and rescues trailing commas before closing braces/brackets', () => {
    const rawWithTrailingCommas =
      '```json\n{\n  "canonicalDomain": "01_Household",\n  "subLabel": "Household/Property",\n  "items": [1, 2, ],\n}\n```'
    const parsed = codeGs.extractJsonSubstring(rawWithTrailingCommas)
    expect(parsed).toEqual({
      canonicalDomain: '01_Household',
      subLabel: 'Household/Property',
      items: [1, 2],
    })
  })

  test('parseRetryDelayMs parses Retry-After header and clamps between 1000ms and 30000ms', () => {
    const mockResponse1 = {
      getHeaders: () => ({ 'Retry-After': '12' }),
      getContentText: () => '',
    }
    expect(codeGs.parseRetryDelayMs(mockResponse1)).toBe(12000)

    const mockResponseMax = {
      getHeaders: () => ({ 'Retry-After': '90' }),
      getContentText: () => '',
    }
    expect(codeGs.parseRetryDelayMs(mockResponseMax)).toBe(30000)

    const mockResponseDetail = {
      getHeaders: () => ({}),
      getContentText: () =>
        JSON.stringify({
          error: {
            details: [{ retryDelay: '3.5s' }],
          },
        }),
    }
    expect(codeGs.parseRetryDelayMs(mockResponseDetail)).toBe(3500)
  })

  test('computeStringHash generates stable MD5 digest', () => {
    const hash1 = codeGs.computeStringHash('test string')
    const hash2 = codeGs.computeStringHash('test string')
    const hash3 = codeGs.computeStringHash('different string')
    expect(hash1).toBe(hash2)
    expect(hash1).not.toBe(hash3)
    expect(hash1).toMatch(/^[a-f0-9]{32}$/)
  })

  test('getNotePathForDomain supports CUSTOM_NOTE_PATHS from PropertiesService', () => {
    expect(codeGs.getNotePathForDomain('04_Family_Health')).toBe(
      '04_Family_Health/index.md'
    )

    global.PropertiesService = {
      getScriptProperties: () => ({
        getProperty: (key) => {
          if (key === 'CUSTOM_NOTE_PATHS') {
            return JSON.stringify({
              '04_Family_Health': 'custom-domain/kids/index.md',
            })
          }
          return null
        },
      }),
    }

    expect(codeGs.getNotePathForDomain('04_Family_Health')).toBe(
      'custom-domain/kids/index.md'
    )
    delete global.PropertiesService
  })

  test('buildOntologicalPrompt includes telemetry and school/student positive invariants', () => {
    const config = {
      canonicalDomains: [
        '04_Family_Health',
        '05_Tech_Infrastructure',
        '07_Community_NonProfit',
      ],
    }
    const prompt = buildOntologicalPrompt(
      config,
      'noreply@parentsquad.com',
      'Weekly Newsletter',
      'School news and lunch menu'
    )
    expect(prompt).toContain('AUTOMATED MACHINE & SENSOR TELEMETRY')
    expect(prompt).toContain('BroodMinder')
    expect(prompt).toContain('Projects/Telemetry')
    expect(prompt).toContain('Tech/Alerts')
    expect(prompt).toContain(
      'Always route machine telemetry to category "Updates" with action "archive"'
    )
    expect(prompt).toContain(
      'SCHOOL & STUDENT ANNOUNCEMENTS VS DIRECT CORRESPONDENCE'
    )
    expect(prompt).toContain('MCAA')
    expect(prompt).toContain('Briarwood')
    expect(prompt).toContain('FACTS')
    expect(prompt).toContain('PowerSchool')
    expect(prompt).toContain('ParentSquare')
    expect(prompt).toContain('Google Classroom')
    expect(prompt).toContain('Family/School-Student')
    expect(prompt).toContain('PRIMARY PARTY ATTRIBUTION PRINCIPLE')
    expect(prompt).toContain('Family/Kids/Tide')
    expect(prompt).toContain('Family/Kids/Toby')
    expect(prompt).toContain(
      'NON-PROFIT & CHARITY BROADCASTS VS DIRECT CORRESPONDENCE'
    )
    expect(prompt).toContain(
      'TECH PLATFORM NOTIFICATIONS & SYSTEM ANNOUNCEMENTS'
    )
    expect(prompt).not.toContain('Under NO circumstances')
    expect(prompt).not.toContain('Do NOT classify')
    expect(prompt).not.toContain('Reserve strictly for')
  })
})

describe('setGmailCategoryTab Category Shifting', () => {
  const { setGmailCategoryTab: setCatIndex } = require('../src/index')
  const { setGmailCategoryTab: setCatCodeGs } = require('../code.gs')

  ;[
    { name: 'src/index.js implementation', fn: setCatIndex },
    { name: 'code.gs implementation', fn: setCatCodeGs },
  ].forEach(({ name, fn }) => {
    describe(name, () => {
      let mockModify
      let mockGmailService
      let mockThread

      beforeEach(() => {
        mockModify = jest.fn()
        mockGmailService = {
          Users: {
            Threads: {
              modify: mockModify,
            },
          },
        }
        mockThread = {
          getId: () => 'thread_123',
          getFirstMessageSubject: () => 'Test Subject',
        }
      })

      test('assigns Updates category and strips other categories', () => {
        fn(mockThread, 'Updates', mockGmailService)
        expect(mockModify).toHaveBeenCalledWith(
          {
            addLabelIds: ['CATEGORY_UPDATES'],
            removeLabelIds: [
              'CATEGORY_PERSONAL',
              'CATEGORY_PROMOTIONS',
              'CATEGORY_SOCIAL',
              'CATEGORY_FORUMS',
            ],
          },
          'me',
          'thread_123'
        )
      })

      test('assigns Primary category and strips other categories', () => {
        fn(mockThread, 'Primary', mockGmailService)
        expect(mockModify).toHaveBeenCalledWith(
          {
            addLabelIds: ['CATEGORY_PERSONAL'],
            removeLabelIds: [
              'CATEGORY_UPDATES',
              'CATEGORY_PROMOTIONS',
              'CATEGORY_SOCIAL',
              'CATEGORY_FORUMS',
            ],
          },
          'me',
          'thread_123'
        )
      })

      test('assigns Social category and strips other categories', () => {
        fn(mockThread, 'Social', mockGmailService)
        expect(mockModify).toHaveBeenCalledWith(
          {
            addLabelIds: ['CATEGORY_SOCIAL'],
            removeLabelIds: [
              'CATEGORY_PERSONAL',
              'CATEGORY_UPDATES',
              'CATEGORY_PROMOTIONS',
              'CATEGORY_FORUMS',
            ],
          },
          'me',
          'thread_123'
        )
      })

      test('handles unknown category gracefully as no-op', () => {
        fn(mockThread, 'UnknownCategory', mockGmailService)
        expect(mockModify).not.toHaveBeenCalled()
      })

      test('handles missing or disabled Advanced Gmail API gracefully', () => {
        expect(() => {
          fn(mockThread, 'Updates', null)
        }).not.toThrow()
        expect(mockModify).not.toHaveBeenCalled()
      })

      test('handles thread without getFirstMessageSubject safely', () => {
        const bareThread = {
          getId: () => 'bare_thread_456',
        }
        expect(() => {
          fn(bareThread, 'Updates', mockGmailService)
        }).not.toThrow()
        expect(mockModify).toHaveBeenCalledWith(
          expect.objectContaining({
            addLabelIds: ['CATEGORY_UPDATES'],
          }),
          'me',
          'bare_thread_456'
        )
      })

      test('handles null or invalid thread gracefully without throwing', () => {
        expect(() => {
          fn(null, 'Updates', mockGmailService)
        }).not.toThrow()
        expect(() => {
          fn({}, 'Updates', mockGmailService)
        }).not.toThrow()
        expect(mockModify).not.toHaveBeenCalled()
      })
    })
  })
})

describe('cleanConflictingLabels Sub-Label Cleansing', () => {
  const { cleanConflictingLabels: cleanIndex } = require('../src/index')
  const { cleanConflictingLabels: cleanCodeGs } = require('../code.gs')

  ;[
    { name: 'src/index.js implementation', fn: cleanIndex },
    { name: 'code.gs implementation', fn: cleanCodeGs },
  ].forEach(({ name, fn }) => {
    describe(name, () => {
      test('strips conflicting sub-labels such as Family/Sisters/Kristien when primary is Family/Kids/Tide', () => {
        const removed = []
        const mockLabels = [
          { getName: () => 'Family/Sisters/Kristien' },
          { getName: () => '04_Family_Health' },
          { getName: () => 'Retention/Permanent' },
          { getName: () => 'Processed' },
          { getName: () => 'Retention/30d' },
          { getName: () => 'Archives/2026' },
        ]
        const mockThread = {
          getLabels: () => mockLabels,
          removeLabel: jest.fn((lObj) => {
            removed.push(lObj.getName())
          }),
        }
        const config = {
          canonicalDomains: ['04_Family_Health'],
          processedLabel: 'Processed',
        }

        fn(mockThread, '04_Family_Health', 'Family/Kids/Tide', config)

        // Conflicting sub-label Family/Sisters/Kristien MUST be removed
        expect(removed).toContain('Family/Sisters/Kristien')
        // Domain code 04_Family_Health removed when targetSubLabel is set
        expect(removed).toContain('04_Family_Health')
        // Redundant Retention/Permanent removed
        expect(removed).toContain('Retention/Permanent')
        // Protected labels MUST NOT be removed
        expect(removed).not.toContain('Processed')
        expect(removed).not.toContain('Retention/30d')
        expect(removed).not.toContain('Archives/2026')
      })

      test('strips legacy flat labels like Family and Household', () => {
        const removed = []
        const mockLabels = [
          { getName: () => 'Family' },
          { getName: () => 'Household' },
        ]
        const mockThread = {
          getLabels: () => mockLabels,
          removeLabel: jest.fn((lObj) => {
            removed.push(lObj.getName())
          }),
        }
        const config = { canonicalDomains: [] }

        fn(mockThread, '04_Family_Health', 'Family/Kids/Tide', config)

        expect(removed).toContain('Family')
        expect(removed).toContain('Household')
      })

      test('unconditionally strips root domain codes even when targetSubLabel is null', () => {
        const removed = []
        const mockLabels = [
          { getName: () => '04_Family_Health' },
          { getName: () => '01_Household' },
          { getName: () => '05_Tech_Infrastructure' },
        ]
        const mockThread = {
          getLabels: () => mockLabels,
          removeLabel: jest.fn((lObj) => {
            removed.push(lObj.getName())
          }),
        }
        const config = {
          canonicalDomains: [
            '01_Household',
            '04_Family_Health',
            '05_Tech_Infrastructure',
          ],
        }

        fn(mockThread, '04_Family_Health', null, config)

        expect(removed).toContain('04_Family_Health')
        expect(removed).toContain('01_Household')
        expect(removed).toContain('05_Tech_Infrastructure')
      })

      test('safely handles null/undefined config and string label objects without throwing', () => {
        const removed = []
        const mockLabels = ['Family', '01_Household', 'Processed']
        const mockThread = {
          getLabels: () => mockLabels,
          removeLabel: jest.fn((lObj) => {
            removed.push(
              typeof lObj.getName === 'function' ? lObj.getName() : String(lObj)
            )
          }),
        }

        expect(() => {
          fn(mockThread, '01_Household', 'Household/General', null)
        }).not.toThrow()
        expect(removed).toContain('Family')
        expect(removed).toContain('01_Household')
        expect(removed).not.toContain('Processed')
      })

      test('safely handles null thread without throwing or aborting', () => {
        expect(() => {
          fn(null, '01_Household', 'Household/General', null)
        }).not.toThrow()
      })

      test('continues removing other labels even if one label removal throws', () => {
        const removed = []
        const mockLabels = [
          { getName: () => '01_Household' },
          { getName: () => 'Finance/Purchases' },
        ]
        const mockThread = {
          getLabels: () => mockLabels,
          removeLabel: jest.fn((lObj) => {
            if (lObj.getName() === '01_Household') throw new Error('API locked')
            removed.push(lObj.getName())
          }),
        }
        fn(mockThread, '02_Finance_Legal', 'Finance/Banking', {
          canonicalDomains: ['01_Household'],
        })
        expect(removed).toContain('Finance/Purchases')
      })
    })
  })
})

describe('DEFAULT_DOMAIN_SUBLABEL_MAP and isRootDomainLabel', () => {
  const {
    DEFAULT_DOMAIN_SUBLABEL_MAP: mapIndex,
    isRootDomainLabel: isRootIndex,
  } = require('../src/index')
  const {
    DEFAULT_DOMAIN_SUBLABEL_MAP: mapCodeGs,
    isRootDomainLabel: isRootCodeGs,
  } = require('../code.gs')

  ;[
    { name: 'src/index.js', map: mapIndex, isRoot: isRootIndex },
    { name: 'code.gs', map: mapCodeGs, isRoot: isRootCodeGs },
  ].forEach(({ name, map, isRoot }) => {
    describe(name, () => {
      test('maps all 7 core domains to canonical sublabels', () => {
        expect(map['01_Household']).toBe('Household/General')
        expect(map['02_Finance_Legal']).toBe('Finance/Banking')
        expect(map['03_Vehicles']).toBe('Vehicles/General')
        expect(map['04_Family_Health']).toBe('Family/General')
        expect(map['05_Tech_Infrastructure']).toBe('Tech/Infrastructure')
        expect(map['06_Work_Career']).toBe('Work/General')
        expect(map['07_Community_NonProfit']).toBe('Community/NonProfit')
      })

      test('correctly identifies root domain labels vs sub-labels', () => {
        expect(isRoot('01_Household')).toBe(true)
        expect(isRoot('05_Tech_Infrastructure')).toBe(true)
        expect(isRoot('Household/General')).toBe(false)
        expect(isRoot('Tech/Infrastructure')).toBe(false)
        expect(isRoot('01_Household/Primary_House')).toBe(false)
        expect(isRoot(null)).toBe(false)
        expect(isRoot('')).toBe(false)
      })
    })
  })
})

describe('Sparse Body Attachment Filename Enrichment', () => {
  const { processThreadBatch } = require('../src/index')

  test('enriches snippet with attachment filenames when body is sparse', () => {
    let capturedPrompt = ''
    const mockThread = {
      getId: () => 't-sparse',
      getMessages: () => [
        {
          getFrom: () => 'sender@example.com',
          getSubject: () => 'Fwd: scan',
          getPlainBody: () => '   ',
          getAttachments: () => [
            { getName: () => 'Receipt_2026.pdf' },
            { getName: () => 'Contract_Doc.pdf' },
          ],
        },
      ],
      getLabels: () => [],
      addLabel: jest.fn(),
    }
    const mockFetch = jest.fn((url, opts) => {
      const payload = JSON.parse(opts.payload)
      capturedPrompt = payload.contents[0].parts[0].text
      return {
        getResponseCode: () => 200,
        getContentText: () =>
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        canonical_label: '02_Finance_Legal/Purchases',
                        canonicalDomain: '02_Finance_Legal',
                        subLabel: 'Finance/Purchases',
                        confidence: 0.95,
                        reasoning: 'Attached receipt document',
                      }),
                    },
                  ],
                },
              },
            ],
          }),
      }
    })
    const config = {
      modelEndpoint: 'https://example.com/gemini',
      geminiApiKey: 'test-key',
      canonicalDomains: ['02_Finance_Legal/Purchases'],
      processedLabel: 'Processed',
      autoFilterConfidenceThreshold: 0.99,
    }
    const services = {
      GmailApp: {
        getUserLabelByName: jest.fn((name) => ({ getName: () => name })),
        createLabel: jest.fn((name) => ({ getName: () => name })),
      },
      UrlFetchApp: { fetch: mockFetch },
      Gmail: null,
    }

    processThreadBatch([mockThread], config, services)

    expect(capturedPrompt).toContain(
      '[Attached: Receipt_2026.pdf, Contract_Doc.pdf]'
    )
  })

  test('enriches snippet with attachment filenames even when body is not sparse', () => {
    let capturedPrompt = ''
    const mockThread = {
      getId: () => 't-non-sparse',
      getMessages: () => [
        {
          getFrom: () => 'contractor@example.com',
          getSubject: () => 'Roof estimate for review',
          getPlainBody: () =>
            'Hi Client, please find attached the detailed estimate for the residential porch and roof repair project.',
          getAttachments: () => [
            { getName: () => 'Roof_Estimate_2026.pdf' },
            { getName: () => 'company_logo.png' },
          ],
        },
      ],
      getLabels: () => [],
      addLabel: jest.fn(),
    }
    const mockFetch = jest.fn((url, opts) => {
      const payload = JSON.parse(opts.payload)
      capturedPrompt = payload.contents[0].parts[0].text
      return {
        getResponseCode: () => 200,
        getContentText: () =>
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        canonical_label: '01_Household/Property',
                        canonicalDomain: '01_Household',
                        subLabel: 'Household/Property',
                        confidence: 0.98,
                        reasoning: 'Roof repair estimate',
                      }),
                    },
                  ],
                },
              },
            ],
          }),
      }
    })
    const config = {
      modelEndpoint: 'https://example.com/gemini',
      geminiApiKey: 'test-key',
      canonicalDomains: ['01_Household/Property'],
      processedLabel: 'Processed',
      autoFilterConfidenceThreshold: 0.99,
    }
    const services = {
      GmailApp: {
        getUserLabelByName: jest.fn((name) => ({ getName: () => name })),
        createLabel: jest.fn((name) => ({ getName: () => name })),
      },
      UrlFetchApp: { fetch: mockFetch },
      Gmail: null,
    }

    processThreadBatch([mockThread], config, services)

    expect(capturedPrompt).toContain('[Attached: Roof_Estimate_2026.pdf]')
    expect(capturedPrompt).not.toContain('company_logo.png')
  })
})

describe('enrichSnippetWithAttachments_ Unit Tests', () => {
  const { enrichSnippetWithAttachments_: enrichIndex } = require('../src/index')
  const { enrichSnippetWithAttachments_: enrichCodeGs } = require('../code.gs')

  ;[
    { name: 'src/index.js', fn: enrichIndex },
    { name: 'code.gs', fn: enrichCodeGs },
  ].forEach(({ name, fn }) => {
    describe(`${name} implementation`, () => {
      test('returns base snippet untouched when message has no attachments', () => {
        const msg = { getAttachments: () => [] }
        expect(fn('Hello world', msg)).toBe('Hello world')
        expect(fn('', msg)).toBe('')
        expect(fn(null, msg)).toBe('')
      })

      test('appends document attachment names to non-empty snippet', () => {
        const msg = {
          getAttachments: () => [
            { getName: () => 'Inspection_Report.pdf' },
            { getName: () => 'Invoice.xlsx' },
          ],
        }
        const result = fn('Please review findings.', msg)
        expect(result).toBe(
          'Please review findings. [Attached: Inspection_Report.pdf, Invoice.xlsx]'
        )
      })

      test('enriches sparse/empty snippet with attachment names', () => {
        const msg = {
          getAttachments: () => [{ getName: () => 'Signed_Waiver.pdf' }],
        }
        expect(fn('', msg)).toBe('[Attached: Signed_Waiver.pdf]')
        expect(fn('   ', msg)).toBe('[Attached: Signed_Waiver.pdf]')
      })

      test('filters signature icons, tracking pixels, and non-document formats', () => {
        const msg = {
          getAttachments: () => [
            { getName: () => 'logo.png' },
            { getName: () => 'company_logo.jpeg' },
            { getName: () => 'signature_banner.jpg' },
            { getName: () => 'spacer.gif' },
            { getName: () => 'invite.ics' },
            { getName: () => 'contact.vcf' },
            { getName: () => 'disclaimer.htm' },
            { getName: () => 'Valid_Contract.docx' },
          ],
        }
        const result = fn('Agreement attached.', msg)
        expect(result).toBe(
          'Agreement attached. [Attached: Valid_Contract.docx]'
        )
      })

      test('is idempotent when [Attached: already present in snippet', () => {
        const msg = {
          getAttachments: () => [{ getName: () => 'Existing.pdf' }],
        }
        const snippet = 'Here is the doc. [Attached: Existing.pdf]'
        expect(fn(snippet, msg)).toBe(snippet)
      })
    })
  })
})

describe('reclassifyThreadsByQuery Historical Realignment', () => {
  const {
    reclassifyThreadsByQuery: reclassifyIndex,
    runRealignmentAudit: auditIndex,
    sweepAllUnreadInboxEmails: sweepIndex,
  } = require('../src/index')
  const {
    reclassifyThreadsByQuery: reclassifyCodeGs,
    runRealignmentAudit: auditCodeGs,
    sweepAllUnreadInboxEmails: sweepCodeGs,
  } = require('../code.gs')

  ;[
    {
      name: 'src/index.js implementation',
      fn: reclassifyIndex,
      auditFn: auditIndex,
      sweepFn: sweepIndex,
    },
    {
      name: 'code.gs implementation',
      fn: reclassifyCodeGs,
      auditFn: auditCodeGs,
      sweepFn: sweepCodeGs,
    },
  ].forEach(({ name, fn, auditFn, sweepFn }) => {
    describe(name, () => {
      test('reclassifies historical threads and strips conflicting labels in live mode', () => {
        const addedLabels = []
        const removedLabels = []
        const mockLabels = [{ getName: () => 'Family/Sisters/Kristien' }]
        const mockThread = {
          getId: () => 'thread-xyz',
          getMessages: () => [
            {
              getFrom: () => 'probate@example.com',
              getSubject: () => 'Name Change Decree',
              getPlainBody: () => 'Order regarding Tide name change petition.',
            },
          ],
          getLabels: () => mockLabels,
          addLabel: jest.fn((l) =>
            addedLabels.push(
              typeof l.getName === 'function' ? l.getName() : String(l)
            )
          ),
          removeLabel: jest.fn((l) =>
            removedLabels.push(
              typeof l.getName === 'function' ? l.getName() : String(l)
            )
          ),
        }
        const mockGmail = {
          search: jest.fn(() => [mockThread]),
          getUserLabelByName: jest.fn((name) => ({ getName: () => name })),
          createLabel: jest.fn((name) => ({ getName: () => name })),
        }
        const mockClassify = jest.fn(() => ({
          canonicalDomain: '04_Family_Health',
          subLabel: 'Family/Kids/Tide',
          action: 'keep',
          category: 'Primary',
        }))

        const report = fn(
          'label:"Family/Sisters" Tide',
          { maxThreads: 10, dryRun: false },
          { processedLabel: 'Processed' },
          { GmailApp: mockGmail, classifyFn: mockClassify }
        )

        expect(report.scanned).toBe(1)
        expect(report.reclassified).toBe(1)
        expect(report.items[0].newSubLabel).toBe('Family/Kids/Tide')
        expect(removedLabels).toContain('Family/Sisters/Kristien')
        expect(addedLabels).toContain('Family/Kids/Tide')
        expect(addedLabels).toContain('Processed')
      })

      test('does not modify thread labels when dryRun is true', () => {
        const addedLabels = []
        const removedLabels = []
        const mockLabels = [{ getName: () => 'Family/Sisters/Kristien' }]
        const mockThread = {
          getId: () => 'thread-dry',
          getMessages: () => [
            {
              getFrom: () => 'probate@example.com',
              getSubject: () => 'Tide Document',
              getPlainBody: () => 'Tide paperwork details',
            },
          ],
          getLabels: () => mockLabels,
          addLabel: jest.fn((l) => addedLabels.push(l)),
          removeLabel: jest.fn((l) => removedLabels.push(l)),
        }
        const mockGmail = {
          search: jest.fn(() => [mockThread]),
        }
        const mockClassify = jest.fn(() => ({
          canonicalDomain: '04_Family_Health',
          subLabel: 'Family/Kids/Tide',
          action: 'keep',
          category: 'Primary',
        }))

        const report = fn(
          'label:"Family/Sisters" Tide',
          { maxThreads: 10, dryRun: true },
          { processedLabel: 'Processed' },
          { GmailApp: mockGmail, classifyFn: mockClassify }
        )

        expect(report.scanned).toBe(1)
        expect(report.dryRun).toBe(true)
        expect(addedLabels).toHaveLength(0)
        expect(removedLabels).toHaveLength(0)
      })

      test('detects tldChanged and relocates attachments via file.moveTo', () => {
        const mockMovedFiles = []
        const mockFile = {
          getName: () => 'decree.pdf',
          moveTo: jest.fn((destFolder) => {
            mockMovedFiles.push({
              file: 'decree.pdf',
              dest: destFolder.getName(),
            })
          }),
        }
        const mockOldFolder = {
          getName: () => 'Banking',
          getFilesByName: jest.fn((_name) => ({
            hasNext: jest.fn().mockReturnValueOnce(true).mockReturnValue(false),
            next: jest.fn(() => mockFile),
          })),
        }
        const mockNewFolder = {
          getName: () => 'Students',
          getFilesByName: jest.fn(() => ({
            hasNext: () => false,
          })),
          createFile: jest.fn(),
        }
        const mockDrive = {
          getRootFolder: () => ({
            getFoldersByName: (_name) => ({
              hasNext: () => true,
              next: () => ({
                getFoldersByName: (subName) => ({
                  hasNext: () => true,
                  next: () =>
                    subName === 'Students' ? mockNewFolder : mockOldFolder,
                }),
                createFolder: (subName) =>
                  subName === 'Students' ? mockNewFolder : mockOldFolder,
              }),
            }),
            createFolder: () => ({
              getFoldersByName: () => ({
                hasNext: () => true,
                next: () => mockNewFolder,
              }),
            }),
          }),
        }

        const mockAttachment = {
          getName: () => 'decree.pdf',
          getContentType: () => 'application/pdf',
          getSize: () => 15000,
          getBytes: () => new Uint8Array([1, 2, 3]),
        }

        const mockThread = {
          getId: () => 'thread-tld-change',
          getMessages: () => [
            {
              getFrom: () => 'probate@court.gov',
              getSubject: () => 'Order Granting Petition',
              getPlainBody: () => 'Legal decree details.',
              getAttachments: () => [mockAttachment],
            },
          ],
          getLabels: () => [
            { getName: () => '02_Finance_Legal' },
            { getName: () => 'Finance/Banking' },
          ],
          addLabel: jest.fn(),
          removeLabel: jest.fn(),
        }

        const mockGmail = {
          search: jest.fn(() => [mockThread]),
          getUserLabelByName: jest.fn((name) => ({ getName: () => name })),
          createLabel: jest.fn((name) => ({ getName: () => name })),
        }
        const mockClassify = jest.fn(() => ({
          canonicalDomain: '04_Family_Health',
          subLabel: 'Family/Kids/Tide',
          action: 'keep',
          category: 'Primary',
        }))

        const report = fn(
          'Tide Name Change',
          { maxThreads: 5, dryRun: false },
          {
            canonicalDomains: ['02_Finance_Legal', '04_Family_Health'],
            processedLabel: 'Processed',
          },
          {
            GmailApp: mockGmail,
            DriveApp: mockDrive,
            classifyFn: mockClassify,
            getFileHash: () => 'hash123',
          }
        )

        expect(report.scanned).toBe(1)
        expect(report.items[0].tldChanged).toBe(true)
        expect(report.items[0].oldDomain).toBe('02_Finance_Legal')
        expect(report.items[0].newDomain).toBe('04_Family_Health')
        expect(mockFile.moveTo).toHaveBeenCalledWith(mockNewFolder)
        expect(mockMovedFiles).toHaveLength(1)
        expect(mockMovedFiles[0].dest).toBe('Students')
      })

      test('deterministically sets action archive and calls moveToArchive for non-Primary categories', () => {
        const mockMoveToArchive = jest.fn()
        const mockThread = {
          getId: () => 'thread-nonprimary',
          getMessages: () => [
            {
              getFrom: () => 'newsletter@school.org',
              getSubject: () => 'Weekly Update',
              getPlainBody: () => 'Routine school announcements',
            },
          ],
          getLabels: () => [],
          addLabel: jest.fn(),
          removeLabel: jest.fn(),
          moveToArchive: mockMoveToArchive,
        }
        const mockGmail = {
          search: jest.fn(() => [mockThread]),
          getUserLabelByName: jest.fn((name) => ({ getName: () => name })),
          createLabel: jest.fn((name) => ({ getName: () => name })),
        }
        const mockClassify = jest.fn(() => ({
          canonicalDomain: '04_Family_Health',
          subLabel: 'Family/School-Student',
          action: 'keep',
          category: 'Updates',
        }))

        const report = fn(
          'school newsletter',
          { maxThreads: 5, dryRun: false },
          {
            canonicalDomains: ['04_Family_Health'],
            processedLabel: 'Processed',
          },
          {
            GmailApp: mockGmail,
            classifyFn: mockClassify,
          }
        )

        expect(report.scanned).toBe(1)
        expect(report.items[0].action).toBe('archive')
        expect(mockMoveToArchive).toHaveBeenCalledTimes(1)
      })

      it('dynamically discovers sister labels and includes name change query in runRealignmentAudit', () => {
        const mockLabels = [
          { getName: () => 'Family/Sisters/SubSister' },
          { getName: () => 'Finance/Banking' },
        ]

        const mockGmail = {
          getUserLabels: jest.fn(() => mockLabels),
          search: jest.fn(() => []),
        }

        const report = auditFn(
          null,
          { maxThreads: 10 },
          { canonicalDomains: ['04_Family_Health'] },
          { GmailApp: mockGmail, classifyFn: jest.fn() }
        )

        expect(mockGmail.getUserLabels).toHaveBeenCalled()
        expect(mockGmail.search).toHaveBeenCalledWith(
          'label:"Family/Sisters/SubSister" OR "name change"',
          0,
          10
        )
        expect(report.dryRun).toBe(true)
      })

      test('safely handles missing services.Utilities when global Utilities is undefined', () => {
        const originalUtilities = global.Utilities
        delete global.Utilities
        try {
          const mockThread = {
            getId: () => 'thread-util-test',
            getMessages: () => [
              {
                getFrom: () => 'test@example.com',
                getSubject: () => 'Doc Test',
                getPlainBody: () => 'Test body',
                getAttachments: () => [],
              },
            ],
            getLabels: () => [],
            addLabel: jest.fn(),
            removeLabel: jest.fn(),
            moveToArchive: jest.fn(),
          }
          const mockGmail = {
            search: jest.fn(() => [mockThread]),
            getUserLabelByName: jest.fn((name) => ({ getName: () => name })),
            createLabel: jest.fn((name) => ({ getName: () => name })),
          }
          const mockClassify = jest.fn(() => ({
            canonicalDomain: '01_Household',
            subLabel: 'Household/General',
            action: 'keep',
            category: 'Primary',
          }))
          const mockDrive = {
            getRootFolder: () => ({
              getFoldersByName: jest.fn(() => ({
                hasNext: () => false,
              })),
              createFolder: jest.fn(() => ({
                getFoldersByName: jest.fn(() => ({ hasNext: () => false })),
                createFolder: jest.fn(),
                getFilesByName: jest.fn(() => ({ hasNext: () => false })),
                createFile: jest.fn(),
              })),
            }),
          }

          expect(() => {
            fn(
              'test query',
              { maxThreads: 1, dryRun: false },
              { canonicalDomains: ['01_Household'] },
              {
                GmailApp: mockGmail,
                DriveApp: mockDrive,
                classifyFn: mockClassify,
              }
            )
          }).not.toThrow()
        } finally {
          global.Utilities = originalUtilities
        }
      })

      test('resolves oldDomain and detects tldChanged when historical thread carries only a sub-label', () => {
        const mockThread = {
          getId: () => 't-single-sublabel',
          getMessages: () => [
            {
              getFrom: () => 'partner@example.com',
              getSubject: () => 'Invoice Note',
              getPlainBody: () => 'Invoice details',
              getAttachments: () => [],
            },
          ],
          getLabels: () => [
            { getName: () => 'Finance/Banking' },
            { getName: () => 'Processed' },
          ],
          addLabel: jest.fn(),
          removeLabel: jest.fn(),
          moveToArchive: jest.fn(),
        }
        const mockGmail = {
          search: jest.fn(() => [mockThread]),
        }
        const mockClassify = jest.fn(() => ({
          canonicalDomain: '01_Household',
          subLabel: 'Household/Property',
          action: 'archive',
          category: 'Updates',
        }))

        const report = fn(
          'test query',
          { maxThreads: 1, dryRun: true },
          { canonicalDomains: ['01_Household', '02_Finance_Legal'] },
          {
            GmailApp: mockGmail,
            classifyFn: mockClassify,
          }
        )

        expect(report.scanned).toBe(1)
        expect(report.items[0].oldDomain).toBe('02_Finance_Legal')
        expect(report.items[0].newDomain).toBe('01_Household')
        expect(report.items[0].tldChanged).toBe(true)
      })

      test('sweepAllUnreadInboxEmails queries in:inbox is:unread', () => {
        const mockGmail = {
          search: jest.fn(() => []),
        }
        const report = sweepFn(
          { maxThreads: 20 },
          { canonicalDomains: ['04_Family_Health'] },
          { GmailApp: mockGmail, classifyFn: jest.fn() }
        )
        expect(mockGmail.search).toHaveBeenCalledWith(
          'in:inbox is:unread',
          0,
          20
        )
        expect(report.dryRun).toBe(false)
      })
    })
  })

  describe('deterministicRuleClassify_ Scarsella curriculum handling', () => {
    const implementations = [
      {
        name: 'src/index.js',
        fn: require('../src/index').deterministicRuleClassify_,
      },
      {
        name: 'code.gs',
        fn: require('../code.gs').deterministicRuleClassify_,
      },
    ]

    implementations.forEach(({ name, fn }) => {
      describe(name, () => {
        test('classifies generic Scarsella promo as Promotions archive', () => {
          const res = fn(
            'info@scarsellakarate.com',
            'Special Summer Camp Discount!',
            'Sign up today and get 20% off uniforms'
          )
          expect(res).not.toBeNull()
          expect(res.category).toBe('Promotions')
          expect(res.canonicalDomain).toBeNull()
        })

        test('bypasses marketing promo block when Scarsella email contains curriculum or testing', () => {
          const resCurriculum = fn(
            'info@scarsellakarate.com',
            'March Belt Testing & Curriculum Schedule',
            'Attached is the testing schedule and curriculum form'
          )
          expect(
            resCurriculum === null || resCurriculum.canonicalDomain !== null
          ).toBe(true)
          if (resCurriculum) {
            expect(resCurriculum.category).not.toBe('Promotions')
          }
        })

        test('shields school 1:1 teacher correspondence (bcs-lions.org) into Primary', () => {
          const res = fn(
            'asmith@bcs-lions.org',
            'Student - Math Progress & Tutoring Schedule',
            'Hello Parents, the student did great on the algebra quiz today...'
          )
          expect(res).not.toBeNull()
          expect(res.canonicalDomain).toBe('04_Family_Health')
          expect(res.subLabel).toBe('Family/School-Student')
          expect(res.category).toBe('Primary')
          expect(res.action).toBe('keep')
          expect(res.reasoning).toBe('Teacher 1:1 Shield')
        })

        test('shields school 1:1 teacher correspondence (briarwoodchristianschool.org) into Primary', () => {
          const res = fn(
            'teacher@briarwoodchristianschool.org',
            'Student - Chemistry Study Guide & Quiz Update',
            'Hello Parents, here is the study guide for tomorrow...'
          )
          expect(res).not.toBeNull()
          expect(res.canonicalDomain).toBe('04_Family_Health')
          expect(res.subLabel).toBe('Family/School-Student')
          expect(res.category).toBe('Primary')
          expect(res.action).toBe('keep')
          expect(res.reasoning).toBe('Teacher 1:1 Shield')
        })
      })
    })
  })

  describe('processEmailsWithAiClassifier execution & concurrency guard', () => {
    const {
      processEmailsWithAiClassifier: processEmailsCodeGs,
    } = require('../code.gs')
    const {
      processEmailsWithAiClassifier: processEmailsIndex,
    } = require('../src/index')

    const implementations = [
      { name: 'code.gs', fn: processEmailsCodeGs },
      { name: 'src/index.js', fn: processEmailsIndex },
    ]

    implementations.forEach(({ name, fn }) => {
      describe(name, () => {
        const config = {
          geminiApiKey: 'test-key',
          unprocessedQuery: 'in:inbox -label:Processed',
          processedLabel: 'Processed',
          userAccountEmail: 'test@example.com',
        }

        test('skips processing if LockService cannot acquire script lock within 10s', () => {
          expect(typeof fn).toBe('function')
          const mockLock = {
            tryLock: jest.fn(() => false),
            releaseLock: jest.fn(),
          }
          const mockLockService = {
            getScriptLock: jest.fn(() => mockLock),
          }
          const mockGmail = {
            search: jest.fn(),
          }

          fn(config, {
            LockService: mockLockService,
            GmailApp: mockGmail,
          })

          expect(mockLockService.getScriptLock).toHaveBeenCalled()
          expect(mockLock.tryLock).toHaveBeenCalledWith(10000)
          expect(mockGmail.search).not.toHaveBeenCalled()
          expect(mockLock.releaseLock).not.toHaveBeenCalled()
        })

        test('acquires lock, processes threads, and releases lock in finally block', () => {
          expect(typeof fn).toBe('function')
          const mockLock = {
            tryLock: jest.fn(() => true),
            releaseLock: jest.fn(),
          }
          const mockLockService = {
            getScriptLock: jest.fn(() => mockLock),
          }
          const mockGmail = {
            search: jest.fn(() => []),
          }

          fn(config, {
            LockService: mockLockService,
            GmailApp: mockGmail,
          })

          expect(mockLockService.getScriptLock).toHaveBeenCalled()
          expect(mockLock.tryLock).toHaveBeenCalledWith(10000)
          expect(mockGmail.search).toHaveBeenCalled()
          expect(mockLock.releaseLock).toHaveBeenCalled()
        })

        test('releases lock in finally block even if search throws', () => {
          expect(typeof fn).toBe('function')
          const mockLock = {
            tryLock: jest.fn(() => true),
            releaseLock: jest.fn(),
          }
          const mockLockService = {
            getScriptLock: jest.fn(() => mockLock),
          }
          const mockGmail = {
            search: jest.fn(() => {
              throw new Error('API failure')
            }),
          }

          expect(() => {
            fn(config, {
              LockService: mockLockService,
              GmailApp: mockGmail,
            })
          }).toThrow('API failure')

          expect(mockLock.releaseLock).toHaveBeenCalled()
        })

        test('secondary sweep query includes -label:Processed to prevent infinite loop', () => {
          expect(typeof fn).toBe('function')
          const mockLock = {
            tryLock: jest.fn(() => true),
            releaseLock: jest.fn(),
          }
          const mockLockService = {
            getScriptLock: jest.fn(() => mockLock),
          }
          const mockGmail = {
            search: jest.fn(() => []),
          }

          fn(config, {
            LockService: mockLockService,
            GmailApp: mockGmail,
          })

          expect(mockGmail.search).toHaveBeenCalledTimes(2)
          expect(mockGmail.search.mock.calls[0][0]).toBe(
            'in:inbox -label:Processed'
          )
          const sweepQuery = mockGmail.search.mock.calls[1][0]
          expect(sweepQuery).toContain('-label:Processed')
          expect(sweepQuery).toBe(
            'in:inbox is:unread -category:primary -label:Processed'
          )
        })

        test('gracefully skips empty threads without throwing TypeError', () => {
          const emptyThread = {
            getId: () => 'th-empty',
            getMessages: () => [],
          }
          const mockLock = {
            tryLock: jest.fn(() => true),
            releaseLock: jest.fn(),
          }
          const mockLockService = {
            getScriptLock: jest.fn(() => mockLock),
          }
          const mockGmail = {
            search: jest.fn(() => [emptyThread]),
            getUserLabelByName: jest.fn((name) => ({ getName: () => name })),
          }

          expect(() => {
            fn(config, {
              LockService: mockLockService,
              GmailApp: mockGmail,
            })
          }).not.toThrow()
          expect(mockLock.releaseLock).toHaveBeenCalled()
        })

        test('treats GitHub sync failures as non-blocking and preserves thread labeling', () => {
          const mockMessage = {
            getFrom: () => 'sender@example.com',
            getSubject: () => 'Invoice Document',
            getPlainBody: () => 'Please find attached invoice.',
            getDate: () => new Date(),
            getAttachments: () => [],
          }
          const addedLabels = []
          const mockThread = {
            getId: () => 'th-doc-1',
            getMessages: () => [mockMessage],
            addLabel: jest.fn((l) =>
              addedLabels.push(
                typeof l.getName === 'function' ? l.getName() : String(l)
              )
            ),
            getLabels: () => [],
            markRead: jest.fn(),
            moveToArchive: jest.fn(),
          }
          const mockLock = {
            tryLock: jest.fn(() => true),
            releaseLock: jest.fn(),
          }
          const mockLockService = {
            getScriptLock: jest.fn(() => mockLock),
          }
          const mockGmail = {
            search: jest.fn(() => [mockThread]),
            getUserLabelByName: jest.fn((name) => ({ getName: () => name })),
          }

          const ghFailingConfig = {
            ...config,
            githubToken: 'gh-mock-token',
          }

          global.UrlFetchApp = {
            fetch: jest.fn(() => {
              throw new Error('GitHub network connection timeout')
            }),
          }

          expect(() => {
            fn(ghFailingConfig, {
              LockService: mockLockService,
              GmailApp: mockGmail,
              classifyFn: () => ({
                canonicalDomain: '02_Finance_Legal',
                subLabel: 'Finance/Bills',
                category: 'Updates',
                action: 'archive',
                confidence: 0.99,
                title: 'Invoice',
                summary: 'Invoice document',
              }),
            })
          }).not.toThrow()

          expect(addedLabels).toContain('Processed')
          expect(mockLock.releaseLock).toHaveBeenCalled()
        })

        test('gracefully breaks thread processing loop when approaching 270s execution budget', () => {
          const createThread = (id) => ({
            getId: () => id,
            getMessages: () => [
              {
                getFrom: () => 'sender@example.com',
                getSubject: () => 'Sub ' + id,
                getPlainBody: () => 'body ' + id,
                getDate: () => new Date(),
                getAttachments: () => [],
              },
            ],
            addLabel: jest.fn(),
            getLabels: () => [],
            markRead: jest.fn(),
            moveToArchive: jest.fn(),
          })

          const threads = [
            createThread('t-1'),
            createThread('t-2'),
            createThread('t-3'),
          ]
          const mockLock = {
            tryLock: jest.fn(() => true),
            releaseLock: jest.fn(),
          }
          const mockLockService = {
            getScriptLock: jest.fn(() => mockLock),
          }
          const mockGmail = {
            search: jest.fn(() => threads),
            getUserLabelByName: jest.fn((name) => ({ getName: () => name })),
          }

          let callCount = 0
          const initialTime = 1000000
          jest.spyOn(Date, 'now').mockImplementation(() => {
            callCount++
            if (callCount > 3) {
              return initialTime + 275000
            }
            return initialTime
          })

          try {
            fn(config, {
              LockService: mockLockService,
              GmailApp: mockGmail,
              classifyFn: () => ({
                canonicalDomain: '01_Household',
                subLabel: 'Household/Property',
                category: 'Updates',
                action: 'archive',
                confidence: 0.99,
                title: 'Household Note',
                summary: 'Household item',
              }),
            })

            expect(threads[0].addLabel).toHaveBeenCalled()
            expect(threads[2].addLabel).not.toHaveBeenCalled()
            expect(mockLock.releaseLock).toHaveBeenCalled()
          } finally {
            Date.now.mockRestore()
          }
        })
      })
    })

    describe('getFileHash blob safety', () => {
      const { getFileHash: getHashCodeGs } = require('../code.gs')
      const { getFileHash: getHashIndexJs } = require('../src/index.js')

      test('code.gs getFileHash safely handles null and invalid blobs without throwing', () => {
        expect(getHashCodeGs(null)).toBe('')
        expect(getHashCodeGs(undefined)).toBe('')
        expect(getHashCodeGs({})).toBe('')
      })

      test('src/index.js getFileHash safely handles null and invalid blobs without throwing', () => {
        if (typeof getHashIndexJs === 'function') {
          expect(getHashIndexJs(null)).toBe('')
          expect(getHashIndexJs(undefined)).toBe('')
          expect(getHashIndexJs({})).toBe('')
        }
      })
    })

    describe('isThreadSentOrRepliedByUser user reply shield', () => {
      const {
        isThreadSentOrRepliedByUser: isSentCodeGs,
      } = require('../code.gs')
      const {
        isThreadSentOrRepliedByUser: isSentIndexJs,
      } = require('../src/index.js')

      const implementations = [
        { name: 'code.gs', fn: isSentCodeGs },
        { name: 'src/index.js', fn: isSentIndexJs },
      ]

      implementations.forEach(({ name, fn }) => {
        describe(name, () => {
          test('returns true when message sender contains user email case-insensitively', () => {
            const thread = {
              getMessages: () => [
                { getFrom: () => 'Partner <partner@example.com>' },
                { getFrom: () => 'Account Owner <DON@EXAMPLE.COM>' },
              ],
            }
            expect(fn(thread, 'don@example.com')).toBe(true)
          })

          test('returns false when no messages are from user email', () => {
            const thread = {
              getMessages: () => [
                { getFrom: () => 'Partner <partner@example.com>' },
              ],
            }
            expect(fn(thread, 'don@example.com')).toBe(false)
          })

          test('returns false safely without throwing when userEmail is empty or missing', () => {
            const thread = {
              getMessages: () => [{ getFrom: () => 'any@example.com' }],
            }
            expect(fn(thread, '')).toBe(false)
            expect(fn(thread, null)).toBe(false)
            expect(fn(thread, undefined)).toBe(false)
          })

          test('handles malformed messages with null getFrom safely', () => {
            const thread = {
              getMessages: () => [
                null,
                { getFrom: () => null },
                { getFrom: () => undefined },
              ],
            }
            expect(() => {
              expect(fn(thread, 'don@example.com')).toBe(false)
            }).not.toThrow()
          })
        })
      })
    })

    describe('purgeExpiredEmailsByRetentionPolicy safety & error boundary', () => {
      const {
        purgeExpiredEmailsByRetentionPolicy: purgeCodeGs,
      } = require('../code.gs')
      const {
        purgeExpiredEmailsByRetentionPolicy: purgeIndexJs,
      } = require('../src/index.js')

      const implementations = [
        { name: 'code.gs', fn: purgeCodeGs },
        { name: 'src/index.js', fn: purgeIndexJs },
      ]

      implementations.forEach(({ name, fn }) => {
        describe(name, () => {
          test('moves non-exempt expired thread to trash while exempting core sub-label and user replies', () => {
            const trashableThread = {
              getId: () => 't-trash',
              getFirstMessageSubject: () => 'Expired Promo 2024',
              getLabels: () => [{ getName: () => 'Promotions' }],
              getMessages: () => [{ getFrom: () => 'promo@store.example.com' }],
              moveToTrash: jest.fn(),
            }

            const coreSublabelThread = {
              getId: () => 't-core-sublabel',
              getFirstMessageSubject: () => 'Bank Notice 2024',
              getLabels: () => [{ getName: () => 'Finance/Banking' }],
              getMessages: () => [
                { getFrom: () => 'service@bank.example.com' },
              ],
              moveToTrash: jest.fn(),
            }

            const userRepliedThread = {
              getId: () => 't-user-replied',
              getFirstMessageSubject: () => 'Old Discussion 2024',
              getLabels: () => [{ getName: () => 'Forums' }],
              getMessages: () => [
                { getFrom: () => 'stranger@forum.example.com' },
                { getFrom: () => 'Account Owner <don@example.com>' },
              ],
              moveToTrash: jest.fn(),
            }

            const throwingThread = {
              getId: () => 't-throw',
              getFirstMessageSubject: () => 'Locked Thread',
              getLabels: () => [{ getName: () => 'Social' }],
              getMessages: () => [{ getFrom: () => 'social@app.example.com' }],
              moveToTrash: jest.fn(() => {
                throw new Error('Thread locked')
              }),
            }

            const followingThread = {
              getId: () => 't-following',
              getFirstMessageSubject: () => 'Expired Deal 2024',
              getLabels: () => [{ getName: () => 'Promotions' }],
              getMessages: () => [{ getFrom: () => 'deals@store.example.com' }],
              moveToTrash: jest.fn(),
            }

            const mockGmailApp = {
              search: jest.fn(() => [
                trashableThread,
                coreSublabelThread,
                userRepliedThread,
                throwingThread,
                followingThread,
              ]),
            }

            const testConfig = {
              userAccountEmail: 'don@example.com',
              canonicalDomains: ['01_Household', '02_Finance_Legal'],
            }

            const result = fn(testConfig, { GmailApp: mockGmailApp })

            expect(trashableThread.moveToTrash).toHaveBeenCalled()
            expect(coreSublabelThread.moveToTrash).not.toHaveBeenCalled()
            expect(userRepliedThread.moveToTrash).not.toHaveBeenCalled()
            expect(throwingThread.moveToTrash).toHaveBeenCalled()
            expect(followingThread.moveToTrash).toHaveBeenCalled()
            expect(result.trashedCount).toBe(2)
          })
        })
      })
    })

    describe('auditEmailClassifications daily audit sweep', () => {
      const { auditEmailClassifications: auditCodeGs } = require('../code.gs')
      const {
        auditEmailClassifications: auditIndexJs,
      } = require('../src/index.js')

      const implementations = [
        { name: 'code.gs', fn: auditCodeGs },
        { name: 'src/index.js', fn: auditIndexJs },
      ]

      implementations.forEach(({ name, fn }) => {
        describe(name, () => {
          test('scans processed threads, generates report, and dispatches email digest when anomalies found', () => {
            const anomalousThread = {
              getId: () => 't-anomaly',
              getFirstMessageSubject: () => 'Huge Clearance Sale 70% Off',
              getMessages: () => [{ getFrom: () => 'store@deals.example.com' }],
              getLabels: () => [
                { getName: () => 'Processed' },
                { getName: () => '01_Household' },
              ],
            }
            const mockSendEmail = jest.fn()
            const mockGmail = {
              search: jest.fn(() => [anomalousThread]),
              sendEmail: mockSendEmail,
            }
            const testConfig = {
              processedLabel: 'Processed',
              auditLookbackDays: 2,
              auditDigestEmail: 'digest@example.com',
              canonicalDomains: ['01_Household'],
            }

            const report = fn(testConfig, { GmailApp: mockGmail })

            expect(mockGmail.search).toHaveBeenCalledWith(
              'label:Processed newer_than:2d',
              0,
              50
            )
            expect(report.scannedCount).toBe(1)
            expect(report.flaggedCount).toBe(1)
            expect(mockSendEmail).toHaveBeenCalledWith(
              'digest@example.com',
              expect.stringContaining(
                'Daily Classification Audit: 1 anomalies detected'
              ),
              expect.stringContaining('GMAIL AI CLASSIFICATION AUDIT REPORT')
            )
          })

          test('does not send email when all threads are compliant', () => {
            const compliantThread = {
              getId: () => 't-compliant',
              getFirstMessageSubject: () => 'Quarterly Bank Statement',
              getMessages: () => [{ getFrom: () => 'bank@example.com' }],
              getLabels: () => [
                { getName: () => 'Processed' },
                { getName: () => 'Finance/Banking' },
              ],
            }
            const mockSendEmail = jest.fn()
            const mockGmail = {
              search: jest.fn(() => [compliantThread]),
              sendEmail: mockSendEmail,
            }
            const testConfig = {
              processedLabel: 'Processed',
              auditLookbackDays: 2,
              auditDigestEmail: 'digest@example.com',
              canonicalDomains: ['02_Finance_Legal'],
            }

            const report = fn(testConfig, { GmailApp: mockGmail })

            expect(report.scannedCount).toBe(1)
            expect(report.flaggedCount).toBe(0)
            expect(mockSendEmail).not.toHaveBeenCalled()
          })
        })
      })
    })
  })
})
