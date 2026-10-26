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

  test('handles messages with plain object fallback properties without throwing', () => {
    const plainMsgThread = {
      id: 't-plain',
      getMessages: () => [
        {
          from: 'alert@apcocu.org',
          subject: 'Monthly Statement Ready',
          snippet: 'Your account statement is available.',
        },
      ],
      addLabel: jest.fn(),
      getId: () => 't-plain',
    }
    const services = makeServices()
    const results = processThreadBatch([plainMsgThread], config, services)
    expect(results).toHaveLength(1)
    expect(results[0].status).toBe('classified')
    expect(results[0].threadId).toBe('t-plain')
  })

  test('falls back to thread.id when getId is missing', () => {
    const threadWithoutGetId = {
      id: 't-noid',
      getMessages: () => [],
      addLabel: jest.fn(),
    }
    const services = makeServices()
    const results = processThreadBatch([threadWithoutGetId], config, services)
    expect(results).toHaveLength(1)
    expect(results[0].status).toBe('empty')
    expect(results[0].threadId).toBe('t-noid')
  })
})

describe('Ontological Knowledge Graph and Triage Matrix Prompt Architecture', () => {
  const codeGs = require('../code.gs')
  const indexJs = require('../src/index')
  const { buildOntologicalPrompt } = indexJs

  test('src/index.js and code.gs export identical function and constant keys', () => {
    expect(Object.keys(indexJs).sort()).toEqual(Object.keys(codeGs).sort())
  })
  ;[
    { name: 'src/index.js', mod: indexJs },
    { name: 'code.gs', mod: codeGs },
  ].forEach(({ name, mod }) => {
    describe(name, () => {
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

        const prompt = mod.buildOntologicalPrompt(
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

      test('classifyWithGemini constructs ontological prompt and sends x-goog-api-key header', () => {
        let capturedPrompt = ''
        let capturedUrl = ''
        let capturedHeaders = null
        global.UrlFetchApp = {
          fetch: jest.fn((url, opts) => {
            capturedUrl = url
            capturedHeaders = opts.headers
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

        const result = mod.classifyWithGemini(
          'googlealerts-noreply@google.com',
          'Google Alert - Elder Relative',
          'news summary snippet',
          testConfig
        )

        expect(capturedUrl).not.toContain('key=')
        expect(capturedHeaders).toEqual({ 'x-goog-api-key': 'test-key' })
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

        const result = mod.classifyWithGemini(
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

      test('classifyWithGemini rejects malformed or out-of-schema response and cascades to fallback', () => {
        let callCount = 0
        const mockCache = {
          get: jest.fn(() => null),
          put: jest.fn(),
        }
        const validObj = {
          canonicalDomain: '01_Household',
          subLabel: 'Household/Property',
          category: 'Updates',
          action: 'archive',
          confidence: 0.96,
          title: 'Valid',
          summary: 'Valid summary.',
        }
        const mockFetch = jest.fn(() => {
          callCount++
          const badOrGood =
            callCount === 1
              ? {
                  canonicalDomain: '99_Hallucinated_Domain',
                  category: 'Updates',
                  action: 'archive',
                  confidence: 0.95,
                }
              : validObj
          return {
            getResponseCode: () => 200,
            getContentText: () =>
              JSON.stringify({
                candidates: [
                  {
                    content: {
                      parts: [{ text: JSON.stringify(badOrGood) }],
                    },
                  },
                ],
              }),
          }
        })

        const result = mod.classifyWithGemini(
          'contractor@plumbing.com',
          'Invoice #1042',
          'Water heater repaired.',
          {
            geminiApiKey: 'test-key',
            canonicalDomains: ['01_Household', '02_Finance_Legal'],
          },
          { CacheService: mockCache, UrlFetchApp: { fetch: mockFetch } }
        )

        expect(callCount).toBe(2)
        expect(result).toEqual(validObj)
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

        const result = mod.classifyWithGemini(
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

      test('classifyWithGemini cascades through fallback models on HTTP 429 and records circuit breaker failure once if all fail', () => {
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

        const mockPropsStore = {}
        const mockProps = {
          getProperty: jest.fn((k) => mockPropsStore[k] || null),
          setProperty: jest.fn((k, v) => {
            mockPropsStore[k] = String(v)
          }),
          deleteProperty: jest.fn((k) => {
            delete mockPropsStore[k]
          }),
        }

        const result = mod.classifyWithGemini(
          'alerts@cloud.com',
          'CPU Warning',
          'Server CPU at 95%',
          {
            modelEndpoint:
              'https://generativelanguage.googleapis.com/v1beta/models/gemini-custom:generateContent',
            geminiApiKey: 'test-key',
          },
          {
            UrlFetchApp: { fetch: mockFetch },
            sleepFn: sleepMock,
            properties: mockProps,
          }
        )

        expect(callCount).toBe(2)
        expect(sleepMock).toHaveBeenCalledWith(2000)
        expect(result.canonicalDomain).toBe('05_Tech_Infrastructure')
        expect(mockPropsStore['GEMINI_BACKOFF_FAILURES']).toBeUndefined()

        // Now verify all endpoints returning 429 increments GEMINI_BACKOFF_FAILURES only ONCE
        const mockAll429Fetch = jest.fn(() => ({
          getResponseCode: () => 429,
          getHeaders: () => ({ 'Retry-After': '15' }),
          getContentText: () =>
            JSON.stringify({ error: { message: 'Quota exceeded' } }),
        }))
        const failRes = mod.classifyWithGemini(
          'alerts@cloud.com',
          'CPU Warning',
          'Server CPU at 95%',
          { geminiApiKey: 'test-key' },
          {
            UrlFetchApp: { fetch: mockAll429Fetch },
            sleepFn: sleepMock,
            properties: mockProps,
          }
        )
        expect(failRes).toBeNull()
        expect(mockPropsStore['GEMINI_BACKOFF_FAILURES']).toBe('1')
      })

      test('extractJsonSubstring parses JSON and rescues trailing commas before closing braces/brackets', () => {
        const rawWithTrailingCommas =
          '```json\n{\n  "canonicalDomain": "01_Household",\n  "subLabel": "Household/Property",\n  "items": [1, 2, ],\n}\n```'
        const parsed = mod.extractJsonSubstring(rawWithTrailingCommas)
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
        expect(mod.parseRetryDelayMs(mockResponse1)).toBe(12000)

        const mockResponseMax = {
          getHeaders: () => ({ 'Retry-After': '90' }),
          getContentText: () => '',
        }
        expect(mod.parseRetryDelayMs(mockResponseMax)).toBe(30000)

        const mockResponseDetail = {
          getHeaders: () => ({}),
          getContentText: () =>
            JSON.stringify({
              error: {
                details: [{ retryDelay: '3.5s' }],
              },
            }),
        }
        expect(mod.parseRetryDelayMs(mockResponseDetail)).toBe(3500)
      })

      test('computeStringHash generates stable hex digest', () => {
        const hash1 = mod.computeStringHash('test string')
        const hash2 = mod.computeStringHash('test string')
        const hash3 = mod.computeStringHash('different string')
        expect(hash1).toBe(hash2)
        expect(hash1).not.toBe(hash3)
        expect(hash1).toMatch(/^[a-f0-9]{32}$/)
      })

      test('getNotePathForDomain supports CUSTOM_NOTE_PATHS from PropertiesService', () => {
        const savedProps = global.PropertiesService
        try {
          expect(mod.getNotePathForDomain('04_Family_Health')).toBe(
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

          expect(mod.getNotePathForDomain('04_Family_Health')).toBe(
            'custom-domain/kids/index.md'
          )
        } finally {
          global.PropertiesService = savedProps
        }
      })
    })
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
          confidence: 0.95,
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

      test('reclassifyThreadsByQuery shields user-sent/replied threads and low-confidence destructive actions', () => {
        const mockArchiveSent = jest.fn()
        const mockTrashLowConf = jest.fn()
        const userSentThread = {
          getId: () => 'th-user-sent',
          getMessages: () => [
            {
              getFrom: () => 'sender@example.com',
              getSubject: () => 'Update',
              getPlainBody: () => 'Body',
            },
            {
              getFrom: () => 'User <owner@example.com>',
              getSubject: () => 'Re: Update',
              getPlainBody: () => 'Reply',
            },
          ],
          getLabels: () => [],
          addLabel: jest.fn(),
          removeLabel: jest.fn(),
          moveToArchive: mockArchiveSent,
        }
        const lowConfThread = {
          getId: () => 'th-low-conf',
          getMessages: () => [
            {
              getFrom: () => 'promo@example.com',
              getSubject: () => 'Promo',
              getPlainBody: () => 'Body',
            },
          ],
          getLabels: () => [],
          addLabel: jest.fn(),
          removeLabel: jest.fn(),
          moveToTrash: mockTrashLowConf,
        }
        const mockGmail = {
          search: jest.fn(() => [userSentThread, lowConfThread]),
          getUserLabelByName: jest.fn((name) => ({ getName: () => name })),
          createLabel: jest.fn((name) => ({ getName: () => name })),
        }
        let callIdx = 0
        const mockClassify = jest.fn(() => {
          callIdx++
          if (callIdx === 1) {
            return {
              canonicalDomain: '01_Household',
              subLabel: 'Household/General',
              action: 'archive',
              category: 'Updates',
              confidence: 0.95,
            }
          }
          return {
            canonicalDomain: null,
            subLabel: null,
            action: 'trash',
            category: 'Promotions',
            confidence: 0.5,
          }
        })

        const report = fn(
          'test query',
          { maxThreads: 5, dryRun: false },
          {
            canonicalDomains: ['01_Household'],
            processedLabel: 'Processed',
            userAccountEmail: 'owner@example.com',
          },
          {
            GmailApp: mockGmail,
            classifyFn: mockClassify,
          }
        )

        expect(report.scanned).toBe(2)
        expect(mockArchiveSent).not.toHaveBeenCalled()
        expect(mockTrashLowConf).not.toHaveBeenCalled()
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

      test('reclassifyThreadsByQuery uses deterministicRuleClassify_ prior to remote classifyFn', () => {
        const mockThread = {
          getId: () => 't-deterministic',
          getMessages: () => [
            {
              getFrom: () => 'security@example.com',
              getSubject: () => 'Your login code is 123456',
              getPlainBody: () => 'Enter this code to complete sign in.',
              getAttachments: () => [],
            },
          ],
          getLabels: () => [{ getName: () => 'Processed' }],
          addLabel: jest.fn(),
          removeLabel: jest.fn(),
          moveToArchive: jest.fn(),
        }
        const mockGmail = {
          search: jest.fn(() => [mockThread]),
        }
        const mockClassify = jest.fn()

        const report = fn(
          'in:inbox is:unread',
          { maxThreads: 1, dryRun: true },
          { canonicalDomains: ['05_Tech_Infrastructure'] },
          {
            GmailApp: mockGmail,
            classifyFn: mockClassify,
          }
        )

        expect(report.scanned).toBe(1)
        expect(report.items[0].newDomain).toBe('05_Tech_Infrastructure')
        expect(report.items[0].newSubLabel).toBe('Tech/Security')
        expect(mockClassify).not.toHaveBeenCalled()
      })

      test('sweepAllUnreadInboxEmails queries in:inbox is:unread -is:starred -from:me', () => {
        const mockGmail = {
          search: jest.fn(() => []),
        }
        const report = sweepFn(
          { maxThreads: 20 },
          { canonicalDomains: ['04_Family_Health'] },
          { GmailApp: mockGmail, classifyFn: jest.fn() }
        )
        expect(mockGmail.search).toHaveBeenCalledWith(
          'in:inbox is:unread -is:starred -from:me',
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

        test('classifies developer CI/CD monitoring alerts (SonarCloud, Sentry, Vercel) into Tech/Alerts', () => {
          const sonarRes = fn(
            'notifications@sonarcloud.io',
            'Quality Gate passed on project',
            'Analysis report complete',
            null,
            {}
          )
          expect(sonarRes).not.toBeNull()
          expect(sonarRes.canonicalDomain).toBe('05_Tech_Infrastructure')
          expect(sonarRes.subLabel).toBe('Tech/Alerts')
          expect(sonarRes.category).toBe('Updates')
          expect(sonarRes.action).toBe('archive')

          const vercelRes = fn(
            'notifications@vercel.com',
            'Deployment Succeeded',
            'Preview ready',
            null,
            {}
          )
          expect(vercelRes).not.toBeNull()
          expect(vercelRes.canonicalDomain).toBe('05_Tech_Infrastructure')
          expect(vercelRes.subLabel).toBe('Tech/Alerts')
        })

        test('classifies utility bills (Alabama Power, BWWB) into Finance/Bills', () => {
          const powerRes = fn(
            'ebill@alabamapower.com',
            'Your monthly electric bill is ready to view',
            'Account ending in 1234',
            null,
            {}
          )
          expect(powerRes).not.toBeNull()
          expect(powerRes.canonicalDomain).toBe('02_Finance_Legal')
          expect(powerRes.subLabel).toBe('Finance/Bills')
          expect(powerRes.category).toBe('Updates')
          expect(powerRes.action).toBe('archive')

          const waterRes = fn(
            'ebilling@bwwb.org',
            'Water service statement available',
            'Your current statement',
            null,
            {}
          )
          expect(waterRes).not.toBeNull()
          expect(waterRes.canonicalDomain).toBe('02_Finance_Legal')
          expect(waterRes.subLabel).toBe('Finance/Bills')
        })

        test('classifies carrier parcel shipments (UPS, FedEx, USPS) into Finance/Purchases', () => {
          const upsRes = fn(
            'pkginfo@ups.com',
            'UPS Update: Package Scheduled Delivery',
            'Tracking number 1Z9999999999999999',
            null,
            {}
          )
          expect(upsRes).not.toBeNull()
          expect(upsRes.canonicalDomain).toBe('02_Finance_Legal')
          expect(upsRes.subLabel).toBe('Finance/Purchases')
          expect(upsRes.category).toBe('Updates')
          expect(upsRes.action).toBe('archive')
          expect(upsRes.reasoning).toBe('Carrier Tracking')

          const fedexRes = fn(
            'TrackingUpdates@fedex.com',
            'FedEx Shipment Delivered',
            'Your shipment was delivered to your front door',
            null,
            {}
          )
          expect(fedexRes).not.toBeNull()
          expect(fedexRes.canonicalDomain).toBe('02_Finance_Legal')
          expect(fedexRes.subLabel).toBe('Finance/Purchases')

          const uspsRes = fn(
            'auto-reply@usps.com',
            'USPS Tracking: Package Out for Delivery',
            'Your item is out for delivery today',
            null,
            {}
          )
          expect(uspsRes).not.toBeNull()
          expect(uspsRes.canonicalDomain).toBe('02_Finance_Legal')
          expect(uspsRes.subLabel).toBe('Finance/Purchases')
        })

        test('classifies extended banking statements and payment confirmations (Citi, Amex, APCO CU, Rocket Mortgage)', () => {
          const citiRes = fn(
            'citicards@info.citi.com',
            'Your Costco Anywhere Visa statement is available',
            'Your monthly statement is ready to view',
            null,
            {}
          )
          expect(citiRes).not.toBeNull()
          expect(citiRes.canonicalDomain).toBe('02_Finance_Legal')
          expect(citiRes.subLabel).toBe('Finance/Bills')
          expect(citiRes.category).toBe('Updates')
          expect(citiRes.action).toBe('archive')

          const amexRes = fn(
            'AmericanExpress@welcome.americanexpress.com',
            'Payment Confirmation',
            'Your payment scheduled for today was received',
            null,
            {}
          )
          expect(amexRes).not.toBeNull()
          expect(amexRes.canonicalDomain).toBe('02_Finance_Legal')
          expect(amexRes.subLabel).toBe('Finance/Bills')

          const apcoRes = fn(
            'noreplies@apcocu.org',
            'Credit Union e-Statement Notification',
            'Your e-statement is ready',
            null,
            {}
          )
          expect(apcoRes).not.toBeNull()
          expect(apcoRes.canonicalDomain).toBe('02_Finance_Legal')
          expect(apcoRes.subLabel).toBe('Finance/Bills')

          const mortgageRes = fn(
            'RocketMortgage@tc.rocketmortgage.com',
            'Monthly Mortgage Statement Available',
            'Your statement is ready',
            null,
            {}
          )
          expect(mortgageRes).not.toBeNull()
          expect(mortgageRes.canonicalDomain).toBe('02_Finance_Legal')
          expect(mortgageRes.subLabel).toBe('Finance/Bills')
        })

        test('classifies payment receipts and retail orders (PayPal, Home Depot) into Finance/Purchases', () => {
          const paypalRes = fn(
            'service@paypal.com',
            'Receipt for your PayPal payment',
            'You sent a payment of $25.00 USD',
            null,
            {}
          )
          expect(paypalRes).not.toBeNull()
          expect(paypalRes.canonicalDomain).toBe('02_Finance_Legal')
          expect(paypalRes.subLabel).toBe('Finance/Purchases')
          expect(paypalRes.category).toBe('Updates')
          expect(paypalRes.action).toBe('archive')
          expect(paypalRes.reasoning).toBe('Payment Receipt')

          const hdRes = fn(
            'HomeDepotPro@order.homedepot.com',
            'Your Home Depot Order Confirmation',
            'Your order has been received and is being processed',
            null,
            {}
          )
          expect(hdRes).not.toBeNull()
          expect(hdRes.canonicalDomain).toBe('02_Finance_Legal')
          expect(hdRes.subLabel).toBe('Finance/Purchases')
          expect(hdRes.category).toBe('Updates')
          expect(hdRes.action).toBe('archive')
          expect(hdRes.reasoning).toBe('Retail Order / Receipt')
        })

        test('classifies Vera/MiOS alerts into Household/Property and Apps Script alerts into Tech/Alerts', () => {
          const veraRes = fn(
            'noreply3@notify.mios.com',
            'Vera Home Automation: Garage Door Opened',
            'Sensor triggered at front garage',
            null,
            {}
          )
          expect(veraRes).not.toBeNull()
          expect(veraRes.canonicalDomain).toBe('01_Household')
          expect(veraRes.subLabel).toBe('Household/Property')
          expect(veraRes.category).toBe('Updates')
          expect(veraRes.action).toBe('archive')

          const appsScriptRes = fn(
            'noreply-apps-scripts-notifications@google.com',
            'Apps Script: Authorization Notification',
            'Summary of failures for Google Apps Script',
            null,
            {}
          )
          expect(appsScriptRes).not.toBeNull()
          expect(appsScriptRes.canonicalDomain).toBe('05_Tech_Infrastructure')
          expect(appsScriptRes.subLabel).toBe('Tech/Alerts')
          expect(appsScriptRes.category).toBe('Updates')
          expect(appsScriptRes.action).toBe('archive')
        })

        test('classifies credit score notifications (CreditWise, Experian) into Finance/Banking archive', () => {
          const capOneScore = fn(
            'capitalone@notification.capitalone.com',
            'Hi Alex, your score went up',
            'Your credit score increased on CreditWise.',
            null,
            {}
          )
          expect(capOneScore).not.toBeNull()
          expect(capOneScore.canonicalDomain).toBe('02_Finance_Legal')
          expect(capOneScore.subLabel).toBe('Finance/Banking')
          expect(capOneScore.category).toBe('Updates')
          expect(capOneScore.action).toBe('archive')
          expect(capOneScore.reasoning).toBe('Credit Score Alert')

          const experianScore = fn(
            'creditmonitoring@experian.com',
            'Your Experian Credit Report and Score Changed',
            'A new credit alert has been detected.',
            null,
            {}
          )
          expect(experianScore).not.toBeNull()
          expect(experianScore.canonicalDomain).toBe('02_Finance_Legal')
          expect(experianScore.subLabel).toBe('Finance/Banking')
          expect(experianScore.category).toBe('Updates')
          expect(experianScore.action).toBe('archive')
        })

        test('classifies smart reorder and consumable replenishments into Household/Supplies archive', () => {
          const inkAlert = fn(
            'no-reply@amazon.com',
            "It's time to order the Canon CLI-281 Yellow Toner for your Canon TS6300 series-AirPrint",
            'Yellow toner level is at 0%',
            null,
            {}
          )
          expect(inkAlert).not.toBeNull()
          expect(inkAlert.canonicalDomain).toBe('01_Household')
          expect(inkAlert.subLabel).toBe('Household/Supplies')
          expect(inkAlert.category).toBe('Updates')
          expect(inkAlert.action).toBe('archive')
          expect(inkAlert.reasoning).toBe('Smart Reorder')

          const hpReplenish = fn(
            'instantink@hp.com',
            'Low ink alert: Replacement cartridges shipped automatically',
            'Smart reorder auto-replenishment status',
            null,
            {}
          )
          expect(hpReplenish).not.toBeNull()
          expect(hpReplenish.canonicalDomain).toBe('01_Household')
          expect(hpReplenish.subLabel).toBe('Household/Supplies')
          expect(hpReplenish.category).toBe('Updates')
          expect(hpReplenish.action).toBe('archive')
        })

        test('classifies BrightArrow broadcasts and school announcements into Family/School-Student archive', () => {
          const brightArrow = fn(
            'Notification@target10112.brightarrow.com',
            'Oakridge Community School for (Student, Alex)',
            'PowerSchool semester grades glitch is resolved',
            null,
            {}
          )
          expect(brightArrow).not.toBeNull()
          expect(brightArrow.canonicalDomain).toBe('04_Family_Health')
          expect(brightArrow.subLabel).toBe('Family/School-Student')
          expect(brightArrow.category).toBe('Updates')
          expect(brightArrow.action).toBe('archive')
          expect(brightArrow.reasoning).toBe('School Broadcast')

          const elearningDay = fn(
            'announcements@bcsk12.org',
            'E Learning Day Tomorrow: Weather Announcement',
            'Campus closed for e-learning day tomorrow',
            null,
            {}
          )
          expect(elearningDay).not.toBeNull()
          expect(elearningDay.canonicalDomain).toBe('04_Family_Health')
          expect(elearningDay.subLabel).toBe('Family/School-Student')
          expect(elearningDay.category).toBe('Updates')
          expect(elearningDay.action).toBe('archive')
        })

        test('classifies general retail promo and marketing blasts with promotional subjects into Promotions archive', () => {
          const promoRes = fn(
            'deals@store.example.com',
            'Flash Sale: 40% Off Limited Time Offer!',
            'Shop now and save on all clearance items',
            null,
            {}
          )
          expect(promoRes).not.toBeNull()
          expect(promoRes.canonicalDomain).toBeNull()
          expect(promoRes.category).toBe('Promotions')
          expect(promoRes.action).toBe('archive')
          expect(promoRes.reasoning).toBe('Retail Promo')

          const receiptRes = fn(
            'store@example.com',
            'Order Receipt #12345 for your purchase',
            'Thank you for your order',
            null,
            {}
          )
          if (receiptRes) {
            expect(receiptRes.category).not.toBe('Promotions')
          }
        })

        test('classifies "Events in your apiaries" and apiary telemetry into Projects/Telemetry archive', () => {
          const apiaryEvents = fn(
            'alerts@broodminder.com',
            'Events in your apiaries',
            'An automated alert notification regarding device issues and status updates for hives in your apiaries.',
            null,
            {}
          )
          expect(apiaryEvents).not.toBeNull()
          expect(apiaryEvents.canonicalDomain).toBe('07_Community_NonProfit')
          expect(apiaryEvents.subLabel).toBe('Projects/Telemetry')
          expect(apiaryEvents.category).toBe('Updates')
          expect(apiaryEvents.action).toBe('archive')
          expect(apiaryEvents.reasoning).toBe('BroodMinder Telemetry')

          const myBroodminderAlert = fn(
            'notifications@mybroodminder.com',
            'Apiary Alert: Scale weight threshold exceeded',
            'Battery and weight report for yard',
            null,
            {}
          )
          expect(myBroodminderAlert).not.toBeNull()
          expect(myBroodminderAlert.canonicalDomain).toBe(
            '07_Community_NonProfit'
          )
          expect(myBroodminderAlert.subLabel).toBe('Projects/Telemetry')
          expect(myBroodminderAlert.category).toBe('Updates')
          expect(myBroodminderAlert.action).toBe('archive')
        })

        test('classifies bank APY and interest rate increase notices into Finance/Banking archive', () => {
          const apyRes = fn(
            'EPC@email.empower.com',
            'Your Cash account now earns a higher APY',
            'Your account rate has increased to 3.70% APY automatically.',
            null,
            {}
          )
          expect(apyRes).not.toBeNull()
          expect(apyRes.canonicalDomain).toBe('02_Finance_Legal')
          expect(apyRes.subLabel).toBe('Finance/Banking')
          expect(apyRes.category).toBe('Updates')
          expect(apyRes.action).toBe('archive')
          expect(apyRes.reasoning).toBe('Bank Rate Update')
        })

        test('classifies school travel solicitations (EF Tours) into Family/School-Student Promotions archive', () => {
          const efRes = fn(
            'consultant@ef.com',
            '2028 Trip to South Korea',
            'Informational interest meeting announced for educational tour with early enrollment discount.',
            null,
            {}
          )
          expect(efRes).not.toBeNull()
          expect(efRes.canonicalDomain).toBe('04_Family_Health')
          expect(efRes.subLabel).toBe('Family/School-Student')
          expect(efRes.category).toBe('Promotions')
          expect(efRes.action).toBe('archive')
          expect(efRes.reasoning).toBe('School Travel Solicitation')
        })

        test('classifies SaaS trial expirations and cloud account plan notices into Tech/Alerts archive', () => {
          const awsPlanRes = fn(
            'billing-subscriptions@aws.com',
            'Your AWS account was upgraded to a paid plan',
            'AWS account has been upgraded from the Free Tier to a paid subscription.',
            null,
            {}
          )
          expect(awsPlanRes).not.toBeNull()
          expect(awsPlanRes.canonicalDomain).toBe('05_Tech_Infrastructure')
          expect(awsPlanRes.subLabel).toBe('Tech/Alerts')
          expect(awsPlanRes.category).toBe('Updates')
          expect(awsPlanRes.action).toBe('archive')
          expect(awsPlanRes.reasoning).toBe('SaaS / Cloud Plan Alert')

          const trialEndingRes = fn(
            'notifications@example-saas.com',
            'Your free trial is ending in 3 days',
            'Your 14-day trial will expire soon. Upgrade your plan to keep access.',
            null,
            {}
          )
          expect(trialEndingRes).not.toBeNull()
          expect(trialEndingRes.canonicalDomain).toBe('05_Tech_Infrastructure')
          expect(trialEndingRes.subLabel).toBe('Tech/Alerts')
          expect(trialEndingRes.category).toBe('Updates')
          expect(trialEndingRes.action).toBe('archive')
          expect(trialEndingRes.reasoning).toBe('SaaS / Cloud Plan Alert')
        })

        test('shields third-party app authorization and Google account data sharing notices into Primary keep', () => {
          const authNotice = fn(
            'noreply-accounts@google.com',
            'You shared some Google Account data with example-app.com',
            'Google confirmed an authorization event where Sign in with Google was used to log into example-app.',
            null,
            {}
          )
          expect(authNotice).not.toBeNull()
          expect(authNotice.canonicalDomain).toBe('05_Tech_Infrastructure')
          expect(authNotice.subLabel).toBe('Tech/Security')
          expect(authNotice.category).toBe('Primary')
          expect(authNotice.action).toBe('keep')
          expect(authNotice.reasoning).toBe('Third-Party Authorization Shield')
        })

        test('classifies package registry and PyPI trusted publisher alerts into Tech/Alerts archive', () => {
          const pypiRes = fn(
            'noreply@pypi.org',
            '[PyPI] Trusted publisher removed from example-package',
            'PyPI reported that user example removed a GitHub Actions trusted publisher from the project.',
            null,
            {}
          )
          expect(pypiRes).not.toBeNull()
          expect(pypiRes.canonicalDomain).toBe('05_Tech_Infrastructure')
          expect(pypiRes.subLabel).toBe('Tech/Alerts')
          expect(pypiRes.category).toBe('Updates')
          expect(pypiRes.action).toBe('archive')
          expect(pypiRes.reasoning).toBe('Package Registry Alert')
        })

        test('classifies hardware and IoT telemetry (QNAP NAS, UniFi, Home Assistant) into Tech/Alerts archive', () => {
          const qnapRes = fn(
            'NotificationCenter@qnap.com',
            '[QNAP NAS] RAID volume scrubbing finished',
            'Storage pool volume check completed with zero errors.',
            null,
            {}
          )
          expect(qnapRes).not.toBeNull()
          expect(qnapRes.canonicalDomain).toBe('05_Tech_Infrastructure')
          expect(qnapRes.subLabel).toBe('Tech/Alerts')
          expect(qnapRes.category).toBe('Updates')
          expect(qnapRes.action).toBe('archive')
          expect(qnapRes.reasoning).toBe('QNAP Telemetry')

          const unifiRes = fn(
            'notifications@ui.com',
            'UniFi Network: Gateway connection restored',
            'Your network gateway device reconnected.',
            null,
            {}
          )
          expect(unifiRes).not.toBeNull()
          expect(unifiRes.canonicalDomain).toBe('05_Tech_Infrastructure')
          expect(unifiRes.subLabel).toBe('Tech/Alerts')
          expect(unifiRes.category).toBe('Updates')
          expect(unifiRes.action).toBe('archive')
          expect(unifiRes.reasoning).toBe('UniFi Telemetry')

          const haRes = fn(
            'no-reply@nabucasa.com',
            'Your Home Assistant Cloud subscription will renew soon',
            'Your cloud connection subscription is set to renew automatically.',
            null,
            {}
          )
          expect(haRes).not.toBeNull()
          expect(haRes.canonicalDomain).toBe('05_Tech_Infrastructure')
          expect(haRes.subLabel).toBe('Tech/Alerts')
          expect(haRes.category).toBe('Updates')
          expect(haRes.action).toBe('archive')
          expect(haRes.reasoning).toBe('Home Assistant Telemetry')
        })

        test('classifies rideshare and travel receipts (Waymo) into Household/Travel archive', () => {
          const waymoRes = fn(
            'noreply@waymo.com',
            'Thanks for riding with Waymo',
            'Here is your receipt for your completed Waymo ride.',
            null,
            {}
          )
          expect(waymoRes).not.toBeNull()
          expect(waymoRes.canonicalDomain).toBe('01_Household')
          expect(waymoRes.subLabel).toBe('Household/Travel')
          expect(waymoRes.category).toBe('Updates')
          expect(waymoRes.action).toBe('archive')
          expect(waymoRes.reasoning).toBe('Travel Confirmation')
        })

        test('classifies vehicle fuel e-receipts (Shell) into Vehicles/Maintenance archive', () => {
          const shellRes = fn(
            'donotreply@mail.ereceiptshell.com',
            'Thanks for your Purchase! Your e-Receipt Inside!',
            'Electronic receipt for your recent fuel purchase transaction.',
            null,
            {}
          )
          expect(shellRes).not.toBeNull()
          expect(shellRes.canonicalDomain).toBe('03_Vehicles')
          expect(shellRes.subLabel).toBe('Vehicles/Maintenance')
          expect(shellRes.category).toBe('Updates')
          expect(shellRes.action).toBe('archive')
          expect(shellRes.reasoning).toBe('Vehicle Fuel/Maintenance Receipt')
        })

        test('classifies healthcare claim notices and EOBs into Finance/Insurance archive', () => {
          const eobRes = fn(
            'ClaimNotifications@bcbsal.org',
            'Blue Cross and Blue Shield Explanation of Benefits',
            'One or more healthcare claims have been processed. View your online statement.',
            null,
            {}
          )
          expect(eobRes).not.toBeNull()
          expect(eobRes.canonicalDomain).toBe('02_Finance_Legal')
          expect(eobRes.subLabel).toBe('Finance/Insurance')
          expect(eobRes.category).toBe('Updates')
          expect(eobRes.action).toBe('archive')
          expect(eobRes.reasoning).toBe('Insurance Claim / EOB Notice')
        })

        test('classifies routine auto insurance billing into Finance/Bills while shielding claims in Primary', () => {
          const autoPayRes = fn(
            'geico@et.geico.com',
            'Your Auto Pay payment will be processed soon',
            'Automatic monthly insurance premium payment scheduled.',
            null,
            {}
          )
          expect(autoPayRes).not.toBeNull()
          expect(autoPayRes.canonicalDomain).toBe('02_Finance_Legal')
          expect(autoPayRes.subLabel).toBe('Finance/Bills')
          expect(autoPayRes.category).toBe('Updates')
          expect(autoPayRes.action).toBe('archive')
          expect(autoPayRes.reasoning).toBe('Auto Insurance Routine Billing')

          // Claims, adjuster, or dispute communications must NOT match routine billing rule
          const claimNotice = fn(
            'adjuster@geico.com',
            'Update on Claim #99887766 - Settlement Offer',
            'The insurance claim adjuster has completed inspection and prepared settlement details.',
            null,
            {}
          )
          expect(claimNotice).toBeNull()
        })

        test('classifies commercial terms of service and privacy policy updates into non-canonical Updates archive', () => {
          const tosRes = fn(
            'no-reply@platform.example.com',
            'Updates to our Terms of Service and Privacy Policy',
            'We are updating our user agreement and arbitration terms.',
            null,
            {}
          )
          expect(tosRes).not.toBeNull()
          expect(tosRes.canonicalDomain).toBeNull()
          expect(tosRes.category).toBe('Updates')
          expect(tosRes.action).toBe('archive')
          expect(tosRes.reasoning).toBe('Policy / Terms Update')
        })

        test('classifies developer platform notifications (Google AI Studio, CodeAnt AI, Calendar) appropriately', () => {
          const aiStudioRes = fn(
            'googleaistudio-noreply@google.com',
            'Gemini Developer API Quota Update',
            'Important changes to rate limits and API model quotas.',
            null,
            {}
          )
          expect(aiStudioRes).not.toBeNull()
          expect(aiStudioRes.canonicalDomain).toBe('05_Tech_Infrastructure')
          expect(aiStudioRes.subLabel).toBe('Tech/Alerts')
          expect(aiStudioRes.category).toBe('Updates')
          expect(aiStudioRes.action).toBe('archive')

          const codeAntRes = fn(
            'features@updates.codeant.ai',
            'New AI Code Review Feature Available',
            'Try out automated code reviews with 30% discount this month.',
            null,
            {}
          )
          expect(codeAntRes).not.toBeNull()
          expect(codeAntRes.canonicalDomain).toBeNull()
          expect(codeAntRes.category).toBe('Promotions')
          expect(codeAntRes.action).toBe('archive')

          const calRes = fn(
            'calendar-notification@google.com',
            'Notification: Project Review @ Tue Oct 27',
            'Upcoming calendar event reminder.',
            null,
            {}
          )
          expect(calRes).not.toBeNull()
          expect(calRes.canonicalDomain).toBe('01_Household')
          expect(calRes.subLabel).toBe('Household/Property')
          expect(calRes.category).toBe('Updates')
          expect(calRes.action).toBe('archive')
        })

        test('classifies non-profit charity impact newsletters (Ignite Hope) into Community_NonProfit Updates archive', () => {
          const charityRes = fn(
            'info@ignite-hope.org',
            '632 hours later, the doors opened!',
            'Ignite Hope shared a project milestone and renovation update sent via their mass mailer.',
            null,
            {}
          )
          expect(charityRes).not.toBeNull()
          expect(charityRes.canonicalDomain).toBe('07_Community_NonProfit')
          expect(charityRes.subLabel).toBe('NonProfit/General')
          expect(charityRes.category).toBe('Updates')
          expect(charityRes.action).toBe('archive')
          expect(charityRes.reasoning).toBe('NonProfit Impact Newsletter')
        })

        test('classifies school-wide sports tryouts (tennis tryouts) as school broadcast into Family/School-Student archive', () => {
          const tryoutRes = fn(
            'staff@bcsk12.org',
            'Junior High Tennis Tryouts Next Week!',
            'Tennis tryouts will be held next week for all interested students.',
            null,
            {}
          )
          expect(tryoutRes).not.toBeNull()
          expect(tryoutRes.canonicalDomain).toBe('04_Family_Health')
          expect(tryoutRes.subLabel).toBe('Family/School-Student')
          expect(tryoutRes.category).toBe('Updates')
          expect(tryoutRes.action).toBe('archive')
          expect(tryoutRes.reasoning).toBe('School Broadcast')
        })

        test('classifies Ironmen weekly Bible study broadcast and notes into Community_NonProfit Updates archive', () => {
          const bibleStudyRes = fn(
            'ministry@example.com',
            'IRONMEN 6:30am THURSDAY Acts 24 Study Notes',
            'Weekly meeting details and study guide covering Acts 24 with schedule notes.',
            null,
            {}
          )
          expect(bibleStudyRes).not.toBeNull()
          expect(bibleStudyRes.canonicalDomain).toBe('07_Community_NonProfit')
          expect(bibleStudyRes.subLabel).toBe('NonProfit/General')
          expect(bibleStudyRes.category).toBe('Updates')
          expect(bibleStudyRes.action).toBe('archive')
          expect(bibleStudyRes.reasoning).toBe('NonProfit Impact Newsletter')
        })

        test('classifies healthcare insurance payments (BCBSAL) into Finance/Bills Updates archive', () => {
          const bcbsRes = fn(
            'bluecrosspayments@bcbsal.org',
            'Blue Cross and Blue Shield of Alabama Payments',
            'Your monthly insurance payment has been successfully processed.',
            null,
            {}
          )
          expect(bcbsRes).not.toBeNull()
          expect(bcbsRes.canonicalDomain).toBe('02_Finance_Legal')
          expect(bcbsRes.subLabel).toBe('Finance/Bills')
          expect(bcbsRes.category).toBe('Updates')
          expect(bcbsRes.action).toBe('archive')
          expect(bcbsRes.reasoning).toBe('Insurance Payment Receipt')
        })

        test('shields thread containing user-sent message with plain object fallback', () => {
          const mockThread = {
            getMessages: () => [{ from: 'testuser@example.com' }],
          }
          const config = { userAccountEmail: 'testuser@example.com' }
          const res = fn(
            'other@example.com',
            'Subject',
            'Snippet',
            mockThread,
            config
          )
          expect(res).not.toBeNull()
          expect(res.category).toBe('Primary')
          expect(res.action).toBe('keep')
          expect(res.reasoning).toBe('User-Sent Shield')
        })

        test('classifies authentication 2FA codes and security sign-in alerts into Tech/Security archive', () => {
          const authRes = fn(
            'no-reply@auth.example.com',
            'Your verification code is 492019',
            'Use this one-time passcode to verify your identity',
            null,
            {}
          )
          expect(authRes).not.toBeNull()
          expect(authRes.canonicalDomain).toBe('05_Tech_Infrastructure')
          expect(authRes.subLabel).toBe('Tech/Security')
          expect(authRes.category).toBe('Updates')
          expect(authRes.action).toBe('archive')
          expect(authRes.reasoning).toBe('Authentication/Sign-in Ping')

          const deviceRes = fn(
            'security@service.example.com',
            'Security alert for your account: New sign-in from new device',
            'We noticed a new device signed in to your account',
            null,
            {}
          )
          expect(deviceRes).not.toBeNull()
          expect(deviceRes.canonicalDomain).toBe('05_Tech_Infrastructure')
          expect(deviceRes.subLabel).toBe('Tech/Security')
          expect(deviceRes.category).toBe('Updates')
          expect(deviceRes.action).toBe('archive')
        })

        test('classifies healthcare appointment reminders and pharmacy alerts into Family/Health-Medical archive', () => {
          const apptRes = fn(
            'donotreply@mychart.example.org',
            'Upcoming Appointment Reminder for Tomorrow',
            'Your upcoming appointment is confirmed for 2:00 PM',
            null,
            {}
          )
          expect(apptRes).not.toBeNull()
          expect(apptRes.canonicalDomain).toBe('04_Family_Health')
          expect(apptRes.subLabel).toBe('Family/Health-Medical')
          expect(apptRes.category).toBe('Updates')
          expect(apptRes.action).toBe('archive')
          expect(apptRes.reasoning).toBe('Healthcare/Pharmacy Alert')

          const rxRes = fn(
            'rx@cvs.com',
            'Your prescription is ready for pickup',
            'Prescription ready at pharmacy location',
            null,
            {}
          )
          expect(rxRes).not.toBeNull()
          expect(rxRes.canonicalDomain).toBe('04_Family_Health')
          expect(rxRes.subLabel).toBe('Family/Health-Medical')
          expect(rxRes.category).toBe('Updates')
          expect(rxRes.action).toBe('archive')
        })

        test('classifies travel reservations, flight status, and rideshare receipts into Household/Travel archive', () => {
          const flightRes = fn(
            'ticket@delta.com',
            'Flight Confirmation: Check in for your flight',
            'Flight status and boarding pass details',
            null,
            {}
          )
          expect(flightRes).not.toBeNull()
          expect(flightRes.canonicalDomain).toBe('01_Household')
          expect(flightRes.subLabel).toBe('Household/Travel')
          expect(flightRes.category).toBe('Updates')
          expect(flightRes.action).toBe('archive')
          expect(flightRes.reasoning).toBe('Travel Confirmation')

          const uberRes = fn(
            'receipts@uber.com',
            'Your trip with Uber receipt',
            'Thanks for riding with Uber',
            null,
            {}
          )
          expect(uberRes).not.toBeNull()
          expect(uberRes.canonicalDomain).toBe('01_Household')
          expect(uberRes.subLabel).toBe('Household/Travel')
          expect(uberRes.category).toBe('Updates')
          expect(uberRes.action).toBe('archive')
        })

        test('classifies customer feedback surveys into Promotions archive', () => {
          const surveyRes = fn(
            'feedback@service.example.com',
            'How was your experience? Take our quick survey',
            'Tell us what you think. Your opinion matters to us.',
            null,
            {}
          )
          expect(surveyRes).not.toBeNull()
          expect(surveyRes.canonicalDomain).toBeNull()
          expect(surveyRes.category).toBe('Promotions')
          expect(surveyRes.action).toBe('archive')
          expect(surveyRes.reasoning).toBe('Customer Survey')
        })

        test('classifies retail store receipts into Finance/Purchases and retail promos into Promotions', () => {
          const targetReceipt = fn(
            'orders@target.com',
            'Your Target order #987654 is ready for pickup',
            'Your items are ready at customer service',
            null,
            {}
          )
          expect(targetReceipt).not.toBeNull()
          expect(targetReceipt.canonicalDomain).toBe('02_Finance_Legal')
          expect(targetReceipt.subLabel).toBe('Finance/Purchases')
          expect(targetReceipt.category).toBe('Updates')
          expect(targetReceipt.action).toBe('archive')
          expect(targetReceipt.reasoning).toBe('Retail Order / Receipt')

          const targetPromo = fn(
            'promotions@target.com',
            'Weekly Ad: Save up to 30% on home essentials',
            'Limited time offer on top brands',
            null,
            {}
          )
          expect(targetPromo).not.toBeNull()
          expect(targetPromo.canonicalDomain).toBeNull()
          expect(targetPromo.category).toBe('Promotions')
          expect(targetPromo.action).toBe('archive')
          expect(targetPromo.reasoning).toBe('Retail Promo')
        })

        test('classifies social media alerts (LinkedIn, Pinterest, YouTube) into Social archive', () => {
          const linkedinRes = fn(
            'messages-noreply@linkedin.com',
            'You have 3 new notifications on LinkedIn',
            'See what your connections are sharing',
            null,
            {}
          )
          expect(linkedinRes).not.toBeNull()
          expect(linkedinRes.canonicalDomain).toBeNull()
          expect(linkedinRes.category).toBe('Social')
          expect(linkedinRes.action).toBe('archive')
          expect(linkedinRes.reasoning).toBe('News/Newsletter/Social')

          const pinterestRes = fn(
            'updates@pinterest.com',
            'Trending ideas for your home board',
            'Discover pins you might like',
            null,
            {}
          )
          expect(pinterestRes).not.toBeNull()
          expect(pinterestRes.canonicalDomain).toBeNull()
          expect(pinterestRes.category).toBe('Social')
          expect(pinterestRes.action).toBe('archive')
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

        test('secondary sweep query targets unread unstarred inbox threads for realignment', () => {
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
          expect(sweepQuery).toBe(
            'in:inbox is:unread -is:starred -from:me -label:AI/Manual-Review'
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
        })

        test('skips inter-thread rate-limit sleep when thread is classified deterministically', () => {
          const mockLock = {
            tryLock: jest.fn(() => true),
            releaseLock: jest.fn(),
          }
          const mockLockService = {
            getScriptLock: jest.fn(() => mockLock),
          }
          const mockThread = {
            getId: () => 'th-det-1',
            getMessages: () => [
              {
                getFrom: () => 'alerts@broodminder.com',
                getSubject: () => 'BroodMinder Apiary Telemetry Alert',
                getPlainBody: () => 'Hive temperature reading normal.',
                getDate: () => new Date(),
              },
            ],
            getLabels: () => [],
            addLabel: jest.fn(),
            moveToArchive: jest.fn(),
            moveToTrash: jest.fn(),
            markRead: jest.fn(),
          }
          const mockGmail = {
            search: jest.fn(() => [mockThread]),
            getUserLabelByName: jest.fn(() => ({ getName: () => 'Processed' })),
          }
          const mockSleep = jest.fn()

          fn(config, {
            LockService: mockLockService,
            GmailApp: mockGmail,
            Utilities: { sleep: mockSleep },
          })

          expect(mockSleep).not.toHaveBeenCalled()
          expect(mockThread.addLabel).toHaveBeenCalled()
        })

        test('invokes inter-thread rate-limit sleep when remote API classification is performed', () => {
          const mockLock = {
            tryLock: jest.fn(() => true),
            releaseLock: jest.fn(),
          }
          const mockLockService = {
            getScriptLock: jest.fn(() => mockLock),
          }
          const mockThread = {
            getId: () => 'th-remote-1',
            getMessages: () => [
              {
                getFrom: () => 'random-contact@example.com',
                getSubject: () => 'Custom Inquiry',
                getPlainBody: () => 'Unrecognized email body text.',
                getDate: () => new Date(),
              },
            ],
            getLabels: () => [],
            addLabel: jest.fn(),
            moveToArchive: jest.fn(),
            moveToTrash: jest.fn(),
            markRead: jest.fn(),
          }
          const mockGmail = {
            search: jest.fn(() => [mockThread]),
            getUserLabelByName: jest.fn(() => ({ getName: () => 'Processed' })),
          }
          const mockSleep = jest.fn()
          const mockClassifyFn = jest.fn(() => ({
            canonicalDomain: '01_Household',
            subLabel: 'Household/Property',
            category: 'Updates',
            action: 'keep',
            confidence: 0.95,
          }))

          fn(config, {
            LockService: mockLockService,
            GmailApp: mockGmail,
            Utilities: { sleep: mockSleep },
            classifyFn: mockClassifyFn,
          })

          expect(mockClassifyFn).toHaveBeenCalled()
          expect(mockSleep).toHaveBeenCalledWith(2000)
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

        test('disables remote API for remainder of batch after consecutive remote failures while allowing deterministic rules to succeed', () => {
          const mockLock = {
            tryLock: jest.fn(() => true),
            releaseLock: jest.fn(),
          }
          const mockLockService = {
            getScriptLock: jest.fn(() => mockLock),
          }

          const threadRemote1 = {
            getId: () => 'th-remote-1',
            getMessages: () => [
              {
                getFrom: () => 'unknown1@custom.com',
                getSubject: () => 'Unrecognized Subject 1',
                getPlainBody: () => 'Custom body 1',
                getDate: () => new Date(),
              },
            ],
            addLabel: jest.fn(),
          }
          const threadRemote2 = {
            getId: () => 'th-remote-2',
            getMessages: () => [
              {
                getFrom: () => 'unknown2@custom.com',
                getSubject: () => 'Unrecognized Subject 2',
                getPlainBody: () => 'Custom body 2',
                getDate: () => new Date(),
              },
            ],
            addLabel: jest.fn(),
          }
          const threadDeterministic = {
            getId: () => 'th-det-3',
            getMessages: () => [
              {
                getFrom: () => 'alerts@broodminder.com',
                getSubject: () => 'BroodMinder Apiary Telemetry Alert',
                getPlainBody: () => 'Hive temperature reading normal.',
                getDate: () => new Date(),
              },
            ],
            addLabel: jest.fn(),
            moveToArchive: jest.fn(),
          }
          const threadRemote3 = {
            getId: () => 'th-remote-3',
            getMessages: () => [
              {
                getFrom: () => 'unknown3@custom.com',
                getSubject: () => 'Unrecognized Subject 3',
                getPlainBody: () => 'Custom body 3',
                getDate: () => new Date(),
              },
            ],
            addLabel: jest.fn(),
          }

          const mockGmail = {
            search: jest.fn(() => [
              threadRemote1,
              threadRemote2,
              threadDeterministic,
              threadRemote3,
            ]),
            getUserLabelByName: jest.fn((name) => ({ getName: () => name })),
          }
          const mockClassifyFn = jest.fn(() => null)

          fn(config, {
            LockService: mockLockService,
            GmailApp: mockGmail,
            classifyFn: mockClassifyFn,
          })

          expect(mockClassifyFn).toHaveBeenCalledTimes(2)
          expect(threadDeterministic.addLabel).toHaveBeenCalled()
          expect(threadRemote3.addLabel).not.toHaveBeenCalled()
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

        describe('listAvailableGeminiModels', () => {
          const {
            listAvailableGeminiModels: listCodeGs,
          } = require('../code.gs')
          const {
            listAvailableGeminiModels: listIndexJs,
          } = require('../src/index.js')

          const implementations = [
            { name: 'code.gs', fn: listCodeGs },
            { name: 'src/index.js', fn: listIndexJs },
          ]

          implementations.forEach(({ name, fn }) => {
            describe(name, () => {
              test('returns empty array when UrlFetchApp or config/API key is missing', () => {
                expect(fn(null, null)).toEqual([])
                expect(fn({}, null)).toEqual([])
                expect(fn({ geminiApiKey: '' }, { UrlFetchApp: {} })).toEqual(
                  []
                )
              })

              test('queries models API and returns list of model names', () => {
                const mockFetch = jest.fn(() => ({
                  getResponseCode: () => 200,
                  getContentText: () =>
                    JSON.stringify({
                      models: [
                        { name: 'models/gemini-2.0-flash' },
                        { name: 'models/gemini-1.5-flash' },
                        { name: 'models/gemini-1.5-pro' },
                      ],
                    }),
                }))

                const models = fn(
                  { geminiApiKey: 'test-api-key' },
                  { UrlFetchApp: { fetch: mockFetch } }
                )

                expect(mockFetch).toHaveBeenCalledWith(
                  'https://generativelanguage.googleapis.com/v1beta/models',
                  {
                    headers: { 'x-goog-api-key': 'test-api-key' },
                    muteHttpExceptions: true,
                  }
                )
                expect(models).toEqual([
                  'models/gemini-2.0-flash',
                  'models/gemini-1.5-flash',
                  'models/gemini-1.5-pro',
                ])
              })

              test('handles non-200 responses and exceptions gracefully', () => {
                const mockFetchError = jest.fn(() => ({
                  getResponseCode: () => 403,
                  getContentText: () => JSON.stringify({ error: 'Forbidden' }),
                }))

                expect(
                  fn(
                    { geminiApiKey: 'test-api-key' },
                    { UrlFetchApp: { fetch: mockFetchError } }
                  )
                ).toEqual([])

                const mockFetchThrow = jest.fn(() => {
                  throw new Error('Network error')
                })

                expect(
                  fn(
                    { geminiApiKey: 'test-api-key' },
                    { UrlFetchApp: { fetch: mockFetchThrow } }
                  )
                ).toEqual([])
              })
            })
          })
        })
      })
    })
  })

  describe('Durable Queuing & Cross-Execution Recovery Architecture', () => {
    const implementations = [
      {
        name: 'src/index.js',
        mod: require('../src/index.js'),
      },
      {
        name: 'code.gs',
        mod: require('../code.gs'),
      },
    ]

    describe('deterministicRuleClassify_ for 06_Work_Career', () => {
      implementations.forEach(({ name, mod }) => {
        describe(name, () => {
          test('classifies employment agreement into 06_Work_Career Primary keep', () => {
            const res = mod.deterministicRuleClassify_(
              'hr@company.com',
              'Employment Agreement - Jane Doe',
              'Please find attached the signed employment agreement and restrictive covenants.'
            )
            expect(res).not.toBeNull()
            expect(res.canonicalDomain).toBe('06_Work_Career')
            expect(res.subLabel).toBe('Work/Career')
            expect(res.category).toBe('Primary')
            expect(res.action).toBe('keep')
            expect(res.confidence).toBe(0.99)
          })

          test('classifies offer letter from snippet into 06_Work_Career Primary keep', () => {
            const res = mod.deterministicRuleClassify_(
              'recruiter@techcorp.com',
              'Next Steps in Process',
              'We are pleased to offer you the position of Principal Architect. Terms of employment are enclosed.'
            )
            expect(res).not.toBeNull()
            expect(res.canonicalDomain).toBe('06_Work_Career')
            expect(res.subLabel).toBe('Work/Career')
            expect(res.category).toBe('Primary')
            expect(res.action).toBe('keep')
          })

          test('classifies interview confirmation or screen into 06_Work_Career', () => {
            const res = mod.deterministicRuleClassify_(
              'talent@startup.io',
              'Interview Confirmation: Technical Phone Screen',
              'Here is the link for your upcoming interview with the engineering team.'
            )
            expect(res).not.toBeNull()
            expect(res.canonicalDomain).toBe('06_Work_Career')
            expect(res.category).toBe('Primary')
          })
        })
      })
    })

    describe('Circuit Breaker Helpers', () => {
      implementations.forEach(({ name, mod }) => {
        describe(name, () => {
          let mockStore
          let mockProps

          beforeEach(() => {
            mockStore = {}
            mockProps = {
              getProperty: jest.fn((k) => mockStore[k] || null),
              setProperty: jest.fn((k, v) => {
                mockStore[k] = String(v)
              }),
              deleteProperty: jest.fn((k) => {
                delete mockStore[k]
              }),
            }
          })

          test('isCircuitBreakerOpen returns false when no property is set', () => {
            expect(mod.isCircuitBreakerOpen(mockProps, 1000000)).toBe(false)
          })

          test('isCircuitBreakerOpen returns false when backoff time has passed', () => {
            mockStore['GEMINI_BACKOFF_UNTIL'] = '1000500'
            expect(mod.isCircuitBreakerOpen(mockProps, 1001000)).toBe(false)
          })

          test('isCircuitBreakerOpen returns true when backoff time is in the future', () => {
            mockStore['GEMINI_BACKOFF_UNTIL'] = '2000000'
            expect(mod.isCircuitBreakerOpen(mockProps, 1000000)).toBe(true)
          })

          test('recordCircuitBreakerFailure computes exponential backoff and sets properties', () => {
            const now = 1000000
            const delay1 = mod.recordCircuitBreakerFailure(mockProps, null, now)
            expect(delay1).toBe(60000)
            expect(mockStore['GEMINI_BACKOFF_FAILURES']).toBe('1')
            expect(mockStore['GEMINI_BACKOFF_UNTIL']).toBe(String(now + 60000))

            const delay2 = mod.recordCircuitBreakerFailure(mockProps, null, now)
            expect(delay2).toBe(120000)
            expect(mockStore['GEMINI_BACKOFF_FAILURES']).toBe('2')
            expect(mockStore['GEMINI_BACKOFF_UNTIL']).toBe(String(now + 120000))
          })

          test('recordCircuitBreakerFailure honors retryDelayMs if greater than exponential backoff', () => {
            const now = 1000000
            const delay = mod.recordCircuitBreakerFailure(
              mockProps,
              180000,
              now
            )
            expect(delay).toBe(180000)
            expect(mockStore['GEMINI_BACKOFF_UNTIL']).toBe(String(now + 180000))
          })

          test('recordCircuitBreakerFailure caps backoff at 1 hour (3600000ms)', () => {
            const now = 1000000
            mockStore['GEMINI_BACKOFF_FAILURES'] = '10'
            const delay = mod.recordCircuitBreakerFailure(
              mockProps,
              99999999,
              now
            )
            expect(delay).toBe(3600000)
          })

          test('recordCircuitBreakerSuccess clears backoff properties', () => {
            mockStore['GEMINI_BACKOFF_UNTIL'] = '2000000'
            mockStore['GEMINI_BACKOFF_FAILURES'] = '3'
            mod.recordCircuitBreakerSuccess(mockProps)
            expect(mockStore['GEMINI_BACKOFF_UNTIL']).toBeUndefined()
            expect(mockStore['GEMINI_BACKOFF_FAILURES']).toBeUndefined()
          })
        })
      })
    })

    describe('Thread Retry Helpers', () => {
      implementations.forEach(({ name, mod }) => {
        describe(name, () => {
          let cacheStore
          let mockCache
          const thread = { getId: () => 'th-retry-123' }

          beforeEach(() => {
            cacheStore = {}
            mockCache = {
              get: jest.fn((k) => cacheStore[k] || null),
              put: jest.fn((k, v) => {
                cacheStore[k] = String(v)
              }),
              remove: jest.fn((k) => {
                delete cacheStore[k]
              }),
            }
          })

          test('getThreadRetryCount_ returns 0 initially and increments correctly', () => {
            expect(mod.getThreadRetryCount_(thread, mockCache)).toBe(0)
            const c1 = mod.incrementThreadRetryCount_(thread, mockCache)
            expect(c1).toBe(1)
            expect(mod.getThreadRetryCount_(thread, mockCache)).toBe(1)
            const c2 = mod.incrementThreadRetryCount_(thread, mockCache)
            expect(c2).toBe(2)
          })

          test('clearThreadRetryCount_ removes thread retry key from cache', () => {
            mod.incrementThreadRetryCount_(thread, mockCache)
            expect(mod.getThreadRetryCount_(thread, mockCache)).toBe(1)
            mod.clearThreadRetryCount_(thread, mockCache)
            expect(mod.getThreadRetryCount_(thread, mockCache)).toBe(0)
          })
        })
      })
    })

    describe('processEmailsWithAiClassifier Durable Queue & Escalation', () => {
      implementations.forEach(({ name, mod }) => {
        describe(name, () => {
          let mockLockService
          let mockLock
          let mockPropsStore
          let mockProps
          let mockCacheStore
          let mockCache

          beforeEach(() => {
            mockLock = {
              tryLock: jest.fn(() => true),
              releaseLock: jest.fn(),
            }
            mockLockService = {
              getScriptLock: jest.fn(() => mockLock),
            }
            mockPropsStore = {}
            mockProps = {
              getProperty: jest.fn((k) => mockPropsStore[k] || null),
              setProperty: jest.fn((k, v) => {
                mockPropsStore[k] = String(v)
              }),
              deleteProperty: jest.fn((k) => {
                delete mockPropsStore[k]
              }),
            }
            mockCacheStore = {}
            mockCache = {
              get: jest.fn((k) => mockCacheStore[k] || null),
              put: jest.fn((k, v) => {
                mockCacheStore[k] = String(v)
              }),
              remove: jest.fn((k) => {
                delete mockCacheStore[k]
              }),
            }
          })

          test('applies retryLabel (AI/Needs-Retry) when remote classification fails', () => {
            const addedLabels = []
            const thread = {
              getId: () => 'th-fail-1',
              getMessages: () => [
                {
                  getFrom: () => 'obscure@sender.com',
                  getSubject: () => 'Obscure Subject Without Rule',
                  getPlainBody: () => 'Random content',
                  getDate: () => new Date(),
                },
              ],
              getLabels: () => [],
              addLabel: jest.fn((lbl) => {
                addedLabels.push(lbl.getName())
              }),
              removeLabel: jest.fn(),
            }

            const mockGmail = {
              search: jest.fn(() => [thread]),
              getUserLabelByName: jest.fn((name) => ({ getName: () => name })),
            }
            const mockClassifyFn = jest.fn(() => null)

            mod.processEmailsWithAiClassifier(
              {
                geminiApiKey: 'test-key',
                processedLabel: 'Processed',
                retryLabel: 'AI/Needs-Retry',
                manualReviewLabel: 'AI/Manual-Review',
                unprocessedQuery: 'in:inbox',
              },
              {
                LockService: mockLockService,
                GmailApp: mockGmail,
                classifyFn: mockClassifyFn,
                PropertiesService: { getScriptProperties: () => mockProps },
                CacheService: { getScriptCache: () => mockCache },
              }
            )

            expect(mockClassifyFn).toHaveBeenCalledTimes(1)
            expect(addedLabels).toContain('AI/Needs-Retry')
            expect(addedLabels).not.toContain('Processed')
            expect(mockPropsStore['GEMINI_BACKOFF_FAILURES']).toBe('1')
          })

          test('escalates to manualReviewLabel (AI/Manual-Review) and removes retryLabel after 5 failures', () => {
            const addedLabels = []
            const removedLabels = []
            mockCacheStore['retry_count_th-poison-5'] = '4'

            const retryLabelObj = { getName: () => 'AI/Needs-Retry' }
            const thread = {
              getId: () => 'th-poison-5',
              getMessages: () => [
                {
                  getFrom: () => 'poison@sender.com',
                  getSubject: () => 'Poison Pill Email',
                  getPlainBody: () => 'Malformatted garbage',
                  getDate: () => new Date(),
                },
              ],
              getLabels: () => [retryLabelObj],
              addLabel: jest.fn((lbl) => {
                addedLabels.push(lbl.getName())
              }),
              removeLabel: jest.fn((lbl) => {
                removedLabels.push(lbl.getName())
              }),
            }

            const mockGmail = {
              search: jest.fn(() => [thread]),
              getUserLabelByName: jest.fn((name) => ({ getName: () => name })),
            }
            const mockClassifyFn = jest.fn(() => null)

            mod.processEmailsWithAiClassifier(
              {
                geminiApiKey: 'test-key',
                processedLabel: 'Processed',
                retryLabel: 'AI/Needs-Retry',
                manualReviewLabel: 'AI/Manual-Review',
                unprocessedQuery: 'label:AI/Needs-Retry',
              },
              {
                LockService: mockLockService,
                GmailApp: mockGmail,
                classifyFn: mockClassifyFn,
                PropertiesService: { getScriptProperties: () => mockProps },
                CacheService: { getScriptCache: () => mockCache },
              }
            )

            expect(addedLabels).toContain('AI/Manual-Review')
            expect(removedLabels).toContain('AI/Needs-Retry')
            expect(addedLabels).not.toContain('Processed')
          })

          test('removes retryLabel and adds processedLabel when thread succeeds on subsequent run', () => {
            const addedLabels = []
            const removedLabels = []
            const retryLabelObj = { getName: () => 'AI/Needs-Retry' }
            mockCacheStore['retry_count_th-success-later'] = '2'

            const thread = {
              getId: () => 'th-success-later',
              getMessages: () => [
                {
                  getFrom: () => 'billing@powercompany.com',
                  getSubject: () => 'Electric Utility Bill Statement',
                  getPlainBody: () => 'Your bill is $145.00',
                  getDate: () => new Date(),
                },
              ],
              getLabels: () => [retryLabelObj],
              addLabel: jest.fn((lbl) => {
                addedLabels.push(lbl.getName())
              }),
              removeLabel: jest.fn((lbl) => {
                removedLabels.push(lbl.getName())
              }),
              moveToArchive: jest.fn(),
            }

            const mockGmail = {
              search: jest.fn(() => [thread]),
              getUserLabelByName: jest.fn((name) => ({ getName: () => name })),
            }
            const mockClassifyFn = jest.fn(() => ({
              canonicalDomain: '01_Household',
              canonical_label: '01_Household',
              subLabel: 'Household/Bills',
              category: 'Updates',
              action: 'archive',
              confidence: 0.99,
              title: 'Electric Bill',
              summary: 'Monthly power statement',
            }))

            mod.processEmailsWithAiClassifier(
              {
                geminiApiKey: 'test-key',
                processedLabel: 'Processed',
                retryLabel: 'AI/Needs-Retry',
                manualReviewLabel: 'AI/Manual-Review',
                unprocessedQuery: 'label:AI/Needs-Retry',
              },
              {
                LockService: mockLockService,
                GmailApp: mockGmail,
                classifyFn: mockClassifyFn,
                PropertiesService: { getScriptProperties: () => mockProps },
                CacheService: { getScriptCache: () => mockCache },
              }
            )

            expect(removedLabels).toContain('AI/Needs-Retry')
            expect(addedLabels).toContain('Processed')
            expect(
              mockCacheStore['retry_count_th-success-later']
            ).toBeUndefined()
          })

          test('skips remote API when circuit breaker is active but deterministic employment rules still succeed in 0ms', () => {
            mockPropsStore['GEMINI_BACKOFF_UNTIL'] = String(Date.now() + 600000)

            const addedLabels = []
            const threadDet = {
              getId: () => 'th-employment-det',
              getMessages: () => [
                {
                  getFrom: () => 'hr@employer.com',
                  getSubject: () => 'Employment Agreement',
                  getPlainBody: () =>
                    'Here is your official employment agreement.',
                  getDate: () => new Date(),
                },
              ],
              getLabels: () => [],
              addLabel: jest.fn((lbl) => {
                addedLabels.push(lbl.getName())
              }),
              removeLabel: jest.fn(),
            }

            const mockGmail = {
              search: jest.fn(() => [threadDet]),
              getUserLabelByName: jest.fn((name) => ({ getName: () => name })),
            }
            const mockClassifyFn = jest.fn()

            mod.processEmailsWithAiClassifier(
              {
                geminiApiKey: 'test-key',
                processedLabel: 'Processed',
                retryLabel: 'AI/Needs-Retry',
                manualReviewLabel: 'AI/Manual-Review',
                unprocessedQuery: 'in:inbox',
              },
              {
                LockService: mockLockService,
                GmailApp: mockGmail,
                classifyFn: mockClassifyFn,
                PropertiesService: { getScriptProperties: () => mockProps },
                CacheService: { getScriptCache: () => mockCache },
              }
            )

            expect(mockClassifyFn).not.toHaveBeenCalled()
            expect(addedLabels).toContain('Work/Career')
            expect(addedLabels).toContain('Processed')
          })

          test('runMissedEmailsSweep searches for recent unprocessed and retry-labeled threads', () => {
            let capturedQuery = null
            const mockGmail = {
              search: jest.fn((q) => {
                capturedQuery = q
                return []
              }),
              getUserLabelByName: jest.fn((name) => ({ getName: () => name })),
            }
            const res = mod.runMissedEmailsSweep({}, { GmailApp: mockGmail })
            expect(mockGmail.search).toHaveBeenCalled()
            expect(capturedQuery).toBe(
              'label:AI/Needs-Retry OR (newer_than:14d -label:Processed -label:AI/Manual-Review)'
            )
            expect(res.scanned).toBe(0)
          })

          test('revertAndQueueMissedCareerEmails reverts Processed and queues AI/Needs-Retry on unclassified career threads', () => {
            const added = []
            const removed = []
            const processedLbl = { getName: () => 'Processed' }
            const unclassifiedCareerThread = {
              getId: () => 'th-career-unclass',
              getLabels: () => [processedLbl],
              removeLabel: jest.fn((l) => removed.push(l.getName())),
              addLabel: jest.fn((l) => added.push(l.getName())),
            }
            const alreadyClassifiedThread = {
              getId: () => 'th-career-done',
              getLabels: () => [processedLbl, { getName: () => 'Work/Career' }],
              removeLabel: jest.fn(),
              addLabel: jest.fn(),
            }

            const mockGmail = {
              search: jest.fn(() => [
                unclassifiedCareerThread,
                alreadyClassifiedThread,
              ]),
              getUserLabelByName: jest.fn((name) => ({ getName: () => name })),
            }

            const modified = mod.revertAndQueueMissedCareerEmails(mockGmail, {
              processedLabel: 'Processed',
              retryLabel: 'AI/Needs-Retry',
            })

            expect(modified).toEqual(['th-career-unclass'])
            expect(removed).toContain('Processed')
            expect(added).toContain('AI/Needs-Retry')
            expect(alreadyClassifiedThread.removeLabel).not.toHaveBeenCalled()
            expect(alreadyClassifiedThread.addLabel).not.toHaveBeenCalled()
          })
        })
      })
    })

    describe('Comprehensive Edge Cases, Triggers, and Safety Shields', () => {
      implementations.forEach(({ name, mod }) => {
        describe(name, () => {
          test('validateOntologicalClassification rejects invalid inputs, confidence, category, and action', () => {
            expect(mod.validateOntologicalClassification(null)).toBe(false)
            expect(mod.validateOntologicalClassification([])).toBe(false)
            expect(
              mod.validateOntologicalClassification({ confidence: 1.5 })
            ).toBe(false)
            expect(
              mod.validateOntologicalClassification({ confidence: -0.1 })
            ).toBe(false)
            expect(
              mod.validateOntologicalClassification({ confidence: 'high' })
            ).toBe(false)
            expect(
              mod.validateOntologicalClassification({ category: 'InvalidTab' })
            ).toBe(false)
            expect(
              mod.validateOntologicalClassification({ action: 'delete_all' })
            ).toBe(false)
            expect(
              mod.validateOntologicalClassification({ canonicalDomain: 123 }, [
                '01_Household',
              ])
            ).toBe(false)
            expect(
              mod.validateOntologicalClassification(
                { canonicalDomain: '99_Unknown' },
                ['01_Household']
              )
            ).toBe(false)
          })

          test('trigger setup functions manage ScriptApp triggers and handle missing ScriptApp', () => {
            const origScriptApp = global.ScriptApp
            try {
              delete global.ScriptApp
              expect(() => mod.setupWeeklyRetentionTrigger({})).not.toThrow()
              expect(() => mod.setupDailyAuditTrigger({})).not.toThrow()
              expect(() => mod.setupFourHourAuditTrigger({})).not.toThrow()
              expect(() => mod.stopAllTriggers({})).not.toThrow()
              expect(() => mod.setupFiveMinuteTrigger({})).not.toThrow()
            } finally {
              global.ScriptApp = origScriptApp
            }

            const deleted = []
            const created = []
            const makeMockScriptApp = (withWeekDay = true) => ({
              WeekDay: withWeekDay ? { SUNDAY: 7 } : undefined,
              getProjectTriggers: () => [
                {
                  getHandlerFunction: () =>
                    'purgeExpiredEmailsByRetentionPolicy',
                },
                { getHandlerFunction: () => 'auditEmailClassifications' },
                { getHandlerFunction: () => 'otherHandler' },
              ],
              deleteTrigger: (t) => deleted.push(t.getHandlerFunction()),
              newTrigger: (fn) => {
                const builder = {
                  timeBased: () => builder,
                  onWeekDay: () => builder,
                  atHour: () => builder,
                  everyDays: () => builder,
                  everyHours: () => builder,
                  everyMinutes: () => builder,
                  create: () => created.push(fn),
                }
                return builder
              },
            })

            mod.setupWeeklyRetentionTrigger({
              ScriptApp: makeMockScriptApp(true),
            })
            mod.setupWeeklyRetentionTrigger({
              ScriptApp: makeMockScriptApp(false),
            })
            mod.setupDailyAuditTrigger({ ScriptApp: makeMockScriptApp(true) })
            mod.setupFourHourAuditTrigger({
              ScriptApp: makeMockScriptApp(true),
            })
            mod.stopAllTriggers({ ScriptApp: makeMockScriptApp(true) })
            mod.setupFiveMinuteTrigger({ ScriptApp: makeMockScriptApp(true) })
            mod.createGmailFilterRule('a@b.com', '01_Household')

            expect(deleted).toContain('purgeExpiredEmailsByRetentionPolicy')
            expect(deleted).toContain('auditEmailClassifications')
            expect(created).toContain('processEmailsWithAiClassifier')
          })

          test('classifyWithGemini handles open circuit breaker, missing UrlFetchApp, HTTP 500, and quota exception', () => {
            const openProps = {
              getProperty: () => String(Date.now() + 60000),
            }
            expect(
              mod.classifyWithGemini(
                'a@b.com',
                'Subj',
                'Snip',
                {},
                { properties: openProps }
              )
            ).toBeNull()

            const origUrlFetch = global.UrlFetchApp
            try {
              delete global.UrlFetchApp
              expect(
                mod.classifyWithGemini('a@b.com', 'Subj', 'Snip', {}, {})
              ).toBeNull()
            } finally {
              global.UrlFetchApp = origUrlFetch
            }

            // HTTP 500 + broken JSON + quota exception
            let callIdx = 0
            const mockFetch = {
              fetch: () => {
                callIdx++
                if (callIdx === 1) {
                  return {
                    getResponseCode: () => 500,
                    getContentText: () => 'Internal Server Error',
                  }
                }
                if (callIdx === 2) {
                  return {
                    getResponseCode: () => 200,
                    getContentText: () =>
                      JSON.stringify({
                        candidates: [
                          { content: { parts: [{ text: '{invalid json}' }] } },
                        ],
                      }),
                  }
                }
                if (callIdx === 3) {
                  return {
                    getResponseCode: () => 429,
                    getHeaders: () => ({}),
                    getContentText: () => '{malformed429',
                  }
                }
                throw new Error('Service invoked too many times for one day')
              },
            }
            const origUtils = global.Utilities
            let res
            try {
              delete global.Utilities
              res = mod.classifyWithGemini(
                'a@b.com',
                'Subj',
                'Snip',
                { modelEndpoint: 'https://custom.endpoint/v1' },
                {
                  UrlFetchApp: mockFetch,
                  CacheService: {
                    get: () => null,
                    put: () => {},
                  },
                }
              )
            } finally {
              global.Utilities = origUtils
            }
            expect(res).toBeNull()

            // recordCircuitBreakerSuccess fallback when deleteProperty is missing
            const setCalls = {}
            mod.recordCircuitBreakerSuccess({
              setProperty: (k, v) => {
                setCalls[k] = v
              },
            })
            expect(setCalls.GEMINI_BACKOFF_FAILURES).toBe('0')
          })

          test('ensureGmailLabel, setGmailCategoryTab, and cleanConflictingLabels handle edge cases', () => {
            expect(mod.ensureGmailLabel(null, null)).toBeNull()

            const existingLbl = { getName: () => 'Household/Property' }
            const gmailCaseMatch = {
              getUserLabelByName: () => null,
              getUserLabels: () => [existingLbl],
            }
            expect(
              mod.ensureGmailLabel('household/property', gmailCaseMatch)
            ).toBe(existingLbl)

            const rootLbl = { getName: () => 'Household' }
            let getLabelsCall = 0
            const gmailRaceRecover = {
              getUserLabelByName: () => null,
              getUserLabels: () => {
                getLabelsCall++
                return getLabelsCall > 1 ? [rootLbl] : []
              },
              createLabel: () => {
                throw new Error('Label name exists')
              },
            }
            expect(mod.ensureGmailLabel('household', gmailRaceRecover)).toBe(
              rootLbl
            )

            // setGmailCategoryTab catches modify error on Primary
            expect(() =>
              mod.setGmailCategoryTab(
                {
                  getId: () => 'th-1',
                  getFirstMessageSubject: () => 'Subj',
                },
                'Primary',
                {
                  Users: {
                    Threads: {
                      modify: () => {
                        throw new Error('API failure')
                      },
                    },
                  },
                }
              )
            ).not.toThrow()

            // cleanConflictingLabels handles removeLabel throws and domain code labels
            const badThread = {
              getLabels: () => [
                { getName: () => 'Retention/Permanent' },
                { getName: () => '01_Household' },
                { getName: () => 'Custom_Domain' },
                { getName: () => 'Finance' },
                { getName: () => 'Finance/Taxes' },
              ],
              removeLabel: () => {
                throw new Error('Cannot remove')
              },
            }
            expect(() =>
              mod.cleanConflictingLabels(
                badThread,
                '01_Household',
                'Household/Property',
                {
                  canonicalDomains: [
                    '01_Household',
                    '02_Finance_Legal',
                    'Custom_Domain',
                  ],
                }
              )
            ).not.toThrow()

            // cleanConflictingLabels outer catch when getLabels throws
            expect(() =>
              mod.cleanConflictingLabels(
                {
                  getLabels: () => {
                    throw new Error('getLabels failed')
                  },
                },
                '01_Household',
                'Household/Property',
                {}
              )
            ).not.toThrow()
          })

          test('deterministicRuleClassify_ matches familyEmails and processThreadBatch archives', () => {
            const det = mod.deterministicRuleClassify_(
              'cousin@family.org',
              'Weekend plans',
              'Are you free on Saturday?',
              null,
              { familyEmails: 'cousin@family.org' }
            )
            expect(det).not.toBeNull()
            expect(det.canonicalDomain).toBe('04_Family_Health')
            expect(det.subLabel).toBe('Family/Correspondence')

            const archived = []
            const batchThread = {
              getId: () => 'th-batch-arch',
              getMessages: () => [
                {
                  getFrom: () => 'alerts@broodminder.com',
                  getSubject: () => 'Events in your apiaries',
                  getPlainBody: () => 'Hive sensor telemetry report',
                },
              ],
              addLabel: jest.fn(),
              moveToArchive: () => archived.push('th-batch-arch'),
            }
            mod.processThreadBatch(
              [batchThread],
              {
                canonicalDomains: ['07_Community_NonProfit'],
                processedLabel: 'Processed',
                autoFilterConfidenceThreshold: 0.99,
              },
              {
                GmailApp: {
                  getUserLabelByName: (n) => ({ getName: () => n }),
                },
              }
            )
            expect(archived).toEqual(['th-batch-arch'])
            expect(mod.extractTopicTitleFromPath('///')).toBe(
              'Ingested Records'
            )
            expect(mod.executeGitHubCommit('', '')).toBe(false)
          })

          test('auditClassifications and auditEmailClassifications handle secondary categories, trash, and sendEmail errors', () => {
            const trashThread = {
              id: 'th-trash',
              isInTrash: true,
              getCategory: () => 'PROMOTIONS',
              getMessages: () => [
                {
                  getFrom: () => 'promo@shop.com',
                  getSubject: () => 'Sale',
                  getPlainBody: () => '50% off',
                },
              ],
              getLabels: () => [{ getName: () => 'Processed' }],
            }
            const metaThread = {
              id: 'th-meta',
              getMessages: () => [
                {
                  getFrom: () => 'promo@shop.com',
                  getSubject: () => 'Sale 2',
                  getPlainBody: () => '50% off',
                },
              ],
              getLabels: () => [{ getName: () => 'Processed' }],
            }
            const report = mod.auditClassifications(
              [trashThread, metaThread],
              { canonicalDomains: ['01_Household'] },
              {
                Gmail: {
                  Users: {
                    Threads: {
                      get: () => ({ labelIds: ['CATEGORY_PROMOTIONS'] }),
                    },
                  },
                },
              }
            )
            expect(report.scannedCount).toBe(2)

            // auditEmailClassifications catches sendEmail error
            const badGmail = {
              search: () => [
                {
                  getId: () => 'th-mismatch',
                  isInInbox: () => true,
                  getMessages: () => [
                    {
                      getFrom: () => 'alerts@google.com',
                      getSubject: () => 'Google Alert - News',
                      getPlainBody: () => 'News digest',
                    },
                  ],
                  getLabels: () => [{ getName: () => 'Family/School-Student' }],
                },
              ],
              sendEmail: () => {
                throw new Error('Mail quota exceeded')
              },
            }
            expect(() =>
              mod.auditEmailClassifications(
                {
                  auditDigestEmail: 'admin@example.com',
                  canonicalDomains: ['04_Family_Health'],
                },
                { GmailApp: badGmail }
              )
            ).not.toThrow()
          })

          test('attachment eligibility, subfolder resolution, zip extraction, and audit backfill edge cases', () => {
            expect(
              mod.resolveTaxonomySubfolderName(
                '04_Family_Health',
                'Family/School-Medical'
              )
            ).toBe('Medical_Records')
            expect(
              mod.resolveTaxonomySubfolderName(
                '04_Family_Health',
                'Family/School'
              )
            ).toBe('Students')

            expect(
              mod.evaluateAttachmentEligibility({
                getName: () => 'disclaimer.txt',
                getSize: () => 2048,
              }).reason
            ).toBe('TEXT_BOILERPLATE_DISCLAIMER')
            expect(
              mod.evaluateAttachmentEligibility({
                getName: () => 'custom.xyz',
                getSize: () => 5000,
              }).reason
            ).toBe('UNKNOWN_OR_UNSUPPORTED_EXTENSION:.xyz')

            // persistCanonicalAttachmentsToDrive with folder.getFiles() returning conflict-renamed candidates
            const folderWithGetFiles = {
              getFilesByName: () => ({ hasNext: () => false }),
              getFiles: () => {
                const list = [
                  { getName: () => '' },
                  {
                    getName: () => 'invoice.pdf',
                    getSize: () => 2048,
                    getBytes: () => [9, 9, 9, 9],
                  },
                  {
                    getName: () => 'invoice_999.pdf',
                    getSize: () => 2048,
                    getBytes: () => new Array(2048).fill(7),
                  },
                ]
                let idx = 0
                return {
                  hasNext: () => idx < list.length,
                  next: () => list[idx++],
                }
              },
              createFile: () => ({
                getId: () => 'id-new',
                setDescription: () => {},
              }),
            }
            const dupSaved = mod.persistCanonicalAttachmentsToDrive(
              {
                getId: () => 'th-dup-getfiles',
                getMessages: () => [
                  {
                    getAttachments: () => [
                      {
                        getName: () => 'invoice.pdf',
                        getSize: () => 2048,
                        getBytes: () => new Array(2048).fill(7),
                        getContentType: () => 'application/pdf',
                      },
                    ],
                  },
                ],
              },
              {
                canonicalDomain: '01_Household',
                subLabel: 'Household/Property',
              },
              { canonicalDomains: ['01_Household'] },
              {
                DriveApp: {
                  getFoldersByName: () => ({
                    hasNext: () => true,
                    next: () => ({
                      getFoldersByName: () => ({
                        hasNext: () => true,
                        next: () => folderWithGetFiles,
                      }),
                    }),
                  }),
                },
              }
            )
            expect(dupSaved).toEqual([])

            // extractZipArchiveToSubfolder with metadata.sourceFileName, ineligible entry, and unzip error
            const zipSubfolder = {
              getFilesByName: () => ({ hasNext: () => false }),
              createFile: () => ({ getId: () => 'id-1', getName: () => 'f' }),
            }
            const zipTargetFolder = {
              getFoldersByName: () => ({ hasNext: () => false }),
              createFolder: () => zipSubfolder,
            }
            mod.extractZipArchiveToSubfolder(
              zipTargetFolder,
              {},
              {
                Utilities: {
                  unzip: () => [
                    {
                      getName: () => 'logo.png',
                      getSize: () => 500,
                      getContentType: () => 'image/png',
                    },
                  ],
                },
              },
              { sourceFileName: 'packet.zip' }
            )
            mod.extractZipArchiveToSubfolder(
              zipTargetFolder,
              { getName: () => 'broken.zip' },
              {
                Utilities: {
                  unzip: () => {
                    throw new Error('Corrupt zip')
                  },
                },
              },
              {}
            )

            const origDrive = global.DriveApp
            try {
              delete global.DriveApp
              expect(mod.unzipExistingDriveArchive('id-1', null, {})).toEqual(
                []
              )
              expect(() =>
                mod.auditAndBackfillCanonicalAttachments({}, {}, {})
              ).toThrow(/GmailApp and DriveApp services are required/)
            } finally {
              global.DriveApp = origDrive
            }

            // runDryRunAttachmentAudit with garbage + eligible items + getLabels()
            const dryRunGmail = {
              search: () => [
                {
                  getId: () => 'th-dry-1',
                  getFirstMessageSubject: () => 'Tax Packet',
                  getLabels: () => [
                    { getName: () => '02_Finance_Legal' },
                    { getName: () => '02_Finance_Legal/Taxes' },
                  ],
                  getMessages: () => [
                    {
                      getAttachments: (opts) => {
                        if (opts) throw new Error('opts not supported')
                        return [
                          {
                            getName: () => 'smime.p7s',
                            getSize: () => 1024,
                          },
                          {
                            getName: () => 'w2.pdf',
                            getBytes: () => new Array(1024).fill(1),
                            getContentType: () => 'application/pdf',
                          },
                        ]
                      },
                    },
                  ],
                },
                {
                  getId: () => 'th-dry-only-garbage',
                  getLabels: () => [{ getName: () => '01_Household' }],
                  getMessages: () => [
                    {
                      getAttachments: () => [
                        { getName: () => 'smime.p7s', getSize: () => 500 },
                      ],
                    },
                  ],
                },
              ],
            }
            const dryRunDrive = {
              getFoldersByName: () => ({ hasNext: () => false }),
            }
            const dryReport = mod.runDryRunAttachmentAudit(
              {},
              { canonicalDomains: ['01_Household', '02_Finance_Legal'] },
              { GmailApp: dryRunGmail, DriveApp: dryRunDrive }
            )
            expect(dryReport.totalEligibleAttachments).toBe(1)
            expect(dryReport.filteredGarbageCount).toBe(2)

            // timeBudgetMs expiry in auditAndBackfillCanonicalAttachments
            const expiredReport = mod.auditAndBackfillCanonicalAttachments(
              { timeBudgetMs: -1 },
              { canonicalDomains: ['02_Finance_Legal'] },
              { GmailApp: dryRunGmail, DriveApp: dryRunDrive }
            )
            expect(expiredReport.timeBudgetReached).toBe(true)

            // Live backfill with createFile throwing BACKFILL_ERROR and folder access error
            let folderThrow = false
            const errDrive = {
              getFoldersByName: () => {
                if (folderThrow) throw new Error('Drive error')
                return {
                  hasNext: () => true,
                  next: () => ({
                    getFoldersByName: () => ({
                      hasNext: () => true,
                      next: () => ({
                        getFilesByName: () => ({ hasNext: () => false }),
                        createFile: () => {
                          throw new Error('Quota exceeded')
                        },
                      }),
                    }),
                  }),
                }
              },
            }
            const liveErrReport = mod.auditAndBackfillCanonicalAttachments(
              { dryRun: false },
              { canonicalDomains: ['02_Finance_Legal'] },
              { GmailApp: dryRunGmail, DriveApp: errDrive }
            )
            expect(liveErrReport.items[0].status).toBe('BACKFILL_ERROR')

            folderThrow = true
            const folderErrReport = mod.auditAndBackfillCanonicalAttachments(
              { dryRun: false },
              { canonicalDomains: ['02_Finance_Legal'] },
              { GmailApp: dryRunGmail, DriveApp: errDrive }
            )
            expect(folderErrReport.threadsWithEligibleAttachments).toBe(0)
          })

          test('reclassifyThreadsByQuery and runRealignmentAudit handle attachment verification, trash, and errors', () => {
            const origGmail = global.GmailApp
            try {
              delete global.GmailApp
              expect(() =>
                mod.reclassifyThreadsByQuery('in:inbox', {}, {}, {})
              ).toThrow(/GmailApp service is required/)
            } finally {
              global.GmailApp = origGmail
            }

            // Reclassify with Thread-ID mismatch, size mismatch, hash match, and trash action
            const movedFiles = []
            const oldFolder = {
              getFilesByName: () => {
                const files = [
                  {
                    getName: () => 'doc.pdf',
                    getDescription: () => 'Thread-ID: other-thread',
                    moveTo: jest.fn(),
                  },
                  {
                    getName: () => 'doc.pdf',
                    getDescription: () => '',
                    getSize: () => 9999,
                    moveTo: jest.fn(),
                  },
                  {
                    getName: () => 'doc.pdf',
                    getDescription: () => '',
                    getSize: () => 2048,
                    getBytes: () => [1, 2, 3, 4],
                    moveTo: () => movedFiles.push('doc.pdf'),
                  },
                ]
                let idx = 0
                return {
                  hasNext: () => idx < files.length,
                  next: () => files[idx++],
                }
              },
            }
            const newFolder = {
              getFilesByName: () => ({ hasNext: () => false }),
              createFile: () => ({
                getId: () => 'saved-1',
                setDescription: () => {},
              }),
            }
            const rootDrive = {
              getFoldersByName: (name) => ({
                hasNext: () => true,
                next: () => ({
                  getFoldersByName: () => ({
                    hasNext: () => true,
                    next: () =>
                      name === '01_Household' ? oldFolder : newFolder,
                  }),
                }),
              }),
            }
            const trashedThreads = []
            const reclGmail = {
              getUserLabels: () => {
                throw new Error('Label list error')
              },
              getUserLabelByName: (n) => ({ getName: () => n }),
              search: () => [
                {
                  getId: () => 'th-recl-1',
                  getLastMessageDate: () => '2026-03-01T00:00:00Z',
                  getLabels: () => [{ getName: () => '01_Household' }],
                  getMessages: () => [
                    {
                      getFrom: () => 'hr@corp.com',
                      getSubject: () => 'Career Opportunity',
                      getPlainBody: () => 'Details enclosed',
                      getAttachments: () => [
                        {
                          getName: () => 'doc.pdf',
                          getSize: () => 2048,
                          getBytes: () => [1, 2, 3, 4],
                          getContentType: () => 'application/pdf',
                        },
                      ],
                    },
                  ],
                  addLabel: jest.fn(),
                },
                {
                  getId: () => 'th-recl-trash',
                  getLastMessageDate: () => '2026-02-01T00:00:00Z',
                  getLabels: () => [],
                  getMessages: () => [
                    {
                      getFrom: () => 'spam@scam.com',
                      getSubject: () => 'Random Message',
                      getPlainBody: () => 'Click here',
                    },
                  ],
                  addLabel: jest.fn(),
                  moveToTrash: () => trashedThreads.push('th-recl-trash'),
                },
              ],
            }
            mod.reclassifyThreadsByQuery(
              'in:inbox',
              { dryRun: false },
              {
                canonicalDomains: ['01_Household', '06_Work_Career'],
                processedLabel: 'Processed',
              },
              {
                GmailApp: reclGmail,
                DriveApp: rootDrive,
                classifyFn: (_s, subj) =>
                  subj.startsWith('Career Opportunity')
                    ? {
                        canonicalDomain: '06_Work_Career',
                        subLabel: 'Work/Career',
                        category: 'Primary',
                        action: 'keep',
                        confidence: 0.95,
                      }
                    : {
                        canonicalDomain: null,
                        category: 'Promotions',
                        action: 'trash',
                        confidence: 0.95,
                      },
              }
            )
            expect(movedFiles).toEqual(['doc.pdf'])
            expect(trashedThreads).toEqual(['th-recl-trash'])

            // timeBudgetMs expiry in reclassifyThreadsByQuery
            const timedOutRecl = mod.reclassifyThreadsByQuery(
              'in:inbox',
              { timeBudgetMs: -1 },
              {},
              { GmailApp: reclGmail }
            )
            expect(timedOutRecl.reclassified).toBe(0)

            // runRealignmentAudit with getUserLabels error falls back to default query
            const auditRes = mod.runRealignmentAudit(
              '',
              {},
              {},
              {
                GmailApp: reclGmail,
                classifyFn: () => {
                  throw new Error('Classifier failure')
                },
              }
            )
            expect(auditRes.query).toContain('Family/Sisters')
          })

          test('purgeExpiredEmailsByRetentionPolicy and processEmailsWithAiClassifier handle shields, pagination, and actions', () => {
            const origGmail = global.GmailApp
            try {
              delete global.GmailApp
              expect(mod.purgeExpiredEmailsByRetentionPolicy({}, {})).toEqual({
                trashedCount: 0,
                exemptedCount: 0,
              })
            } finally {
              global.GmailApp = origGmail
            }

            // 0 threads on page 0
            expect(
              mod.purgeExpiredEmailsByRetentionPolicy(
                { triggerUid: 'trig-1' },
                { GmailApp: { search: () => [] } }
              )
            ).toEqual({ trashedCount: 0, exemptedCount: 0 })

            // 50 threads on page 0 (1 with core domain label, 49 trashed) + 0 on page 1
            const page0Threads = Array.from({ length: 50 }, (_, idx) => ({
              getId: () => `th-p-${idx}`,
              getLabels: () =>
                idx === 0 ? [{ getName: () => '01_Household' }] : [],
              getMessages: () => [],
              moveToTrash: jest.fn(),
            }))
            const pagedRes = mod.purgeExpiredEmailsByRetentionPolicy(
              {},
              {
                GmailApp: {
                  search: (_q, offset) => (offset === 0 ? page0Threads : []),
                },
              }
            )
            expect(pagedRes).toEqual({ trashedCount: 49, exemptedCount: 1 })

            expect(mod.isDestructiveActionAllowed_(null)).toBe(false)
            expect(
              mod.isDestructiveActionAllowed_({
                action: 'trash',
                confidence: NaN,
              })
            ).toBe(false)

            // processEmailsWithAiClassifier missing geminiApiKey and missing GmailApp
            mod.processEmailsWithAiClassifier({ geminiApiKey: '' }, {})
            const origGmail2 = global.GmailApp
            try {
              delete global.GmailApp
              mod.processEmailsWithAiClassifier({ geminiApiKey: 'key' }, {})
            } finally {
              global.GmailApp = origGmail2
            }

            // processEmailsWithAiClassifier with low-confidence shield, trash, mark_read, and removeLabel error
            const trashed = []
            const markedRead = []
            const threads = [
              {
                getId: () => 'th-low-conf',
                getLabels: () => [],
                getMessages: () => [
                  {
                    getFrom: () => 'sender1@unknown.org',
                    getSubject: () => 'Unmapped Topic Alpha',
                    getPlainBody: () => 'Body',
                  },
                ],
                addLabel: jest.fn(),
                moveToTrash: jest.fn(),
                moveToArchive: jest.fn(),
              },
              {
                getId: () => 'th-high-trash',
                getLabels: () => [{ getName: () => 'AI/Needs-Retry' }],
                getMessages: () => [
                  {
                    getFrom: () => 'sender2@unknown.org',
                    getSubject: () => 'Unmapped Topic Beta',
                    getPlainBody: () => 'Body',
                  },
                ],
                addLabel: jest.fn(),
                removeLabel: () => {
                  throw new Error('Remove label error')
                },
                moveToTrash: () => trashed.push('th-high-trash'),
                markRead: () => markedRead.push('th-high-trash'),
              },
            ]
            mod.processEmailsWithAiClassifier(
              {
                geminiApiKey: 'test-key',
                userAccountEmail: 'me@example.com',
                processedLabel: 'Processed',
                retryLabel: 'AI/Needs-Retry',
              },
              {
                GmailApp: {
                  search: () => threads,
                  getUserLabelByName: (n) => ({ getName: () => n }),
                },
                classifyFn: (_s, subj) =>
                  subj.startsWith('Unmapped Topic Alpha')
                    ? {
                        canonicalDomain: null,
                        category: 'Promotions',
                        action: 'trash',
                        confidence: 0.5,
                      }
                    : {
                        canonicalDomain: null,
                        category: 'Promotions',
                        action: 'trash',
                        markRead: true,
                        confidence: 0.95,
                      },
              }
            )
            expect(threads[0].moveToTrash).not.toHaveBeenCalled()
            expect(trashed).toEqual(['th-high-trash'])
            expect(markedRead).toEqual(['th-high-trash'])

            // NonProfit/General resolution and attachment persistence failure retry queuing
            expect(
              mod.resolveCanonicalDomainFromLabels(['NonProfit/General'])
            ).toBe('07_Community_NonProfit')
            expect(
              mod.resolveTaxonomySubfolderName(
                '07_Community_NonProfit',
                'NonProfit/General'
              )
            ).toBe('Community_BOD')

            const attFailLabels1 = []
            const attFailLabels2 = []
            const failingDriveApp = {
              getRootFolder: () => ({
                getFoldersByName: () => ({
                  hasNext: () => true,
                  next: () => ({
                    getFoldersByName: () => ({
                      hasNext: () => true,
                      next: () => ({
                        getFilesByName: () => ({ hasNext: () => false }),
                        createFile: () => {
                          throw new Error('Drive quota exceeded')
                        },
                      }),
                    }),
                  }),
                }),
              }),
            }
            const makeAttThread = (id, sink) => ({
              getId: () => id,
              getLabels: () => [],
              getMessages: () => [
                {
                  getFrom: () => 'billing@charitywater.org',
                  getSubject: () => 'Annual Receipt',
                  getPlainBody: () => 'Body',
                  getAttachments: () => [
                    {
                      getName: () => 'receipt.pdf',
                      getContentType: () => 'application/pdf',
                      getSize: () => 2048,
                      getBytes: () => [1, 2, 3, 4],
                    },
                  ],
                },
              ],
              addLabel: (l) => sink.push(l.getName()),
              moveToArchive: jest.fn(),
            })
            const retryCounts = { 'retry_count_th-att-fail-5': '4' }
            mod.processEmailsWithAiClassifier(
              {
                geminiApiKey: 'test-key',
                userAccountEmail: 'me@example.com',
                processedLabel: 'Processed',
                retryLabel: 'AI/Needs-Retry',
                manualReviewLabel: 'AI/Manual-Review',
              },
              {
                GmailApp: {
                  search: () => [
                    makeAttThread('th-att-fail-1', attFailLabels1),
                    makeAttThread('th-att-fail-5', attFailLabels2),
                  ],
                  getUserLabelByName: (n) => ({ getName: () => n }),
                },
                DriveApp: failingDriveApp,
                cache: {
                  get: (k) => retryCounts[k] || null,
                  put: (k, v) => {
                    retryCounts[k] = v
                  },
                },
              }
            )
            expect(attFailLabels1).toContain('AI/Needs-Retry')
            expect(attFailLabels1).not.toContain('Processed')
            expect(attFailLabels2).toContain('AI/Manual-Review')
            expect(attFailLabels2).not.toContain('Processed')

            expect(
              mod.deterministicRuleClassify_(
                'alerts@chase.com',
                'AutoPay failed — action required',
                'Please submit manual payment.'
              )
            ).toBeNull()
            expect(
              mod.deterministicRuleClassify_(
                'support@bestbuy.com',
                'Action required: verify your account',
                'Please verify your Best Buy account.'
              )
            ).toBeNull()
            expect(
              mod.deterministicRuleClassify_(
                'promotions@bestbuy.com',
                'Weekend update from Best Buy',
                'Check out what is new this week.'
              )
            ).toEqual(
              expect.objectContaining({
                category: 'Promotions',
                action: 'archive',
                reasoning: 'Retail Promo',
              })
            )
          })
        })
      })
    })
  })
})
