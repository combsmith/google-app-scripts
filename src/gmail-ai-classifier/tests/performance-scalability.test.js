/**
 * Performance and Scalability Benchmark Test Suite for Gmail AI Classifier & GitHub Sync
 */

const {
  insertEntryIntoLogSection,
  appendMarkdownEntryToGitHubRepo,
  processThreadBatch,
  classifyWithGemini,
} = require('../src/index.js')

describe('Performance and Scalability Benchmarks', () => {
  test('Section-Aware Insertion Benchmark: Large 10,000 Line Document', () => {
    const lines = [
      '# Master Index Note',
      '## 1. Executive Summary',
      '- Active status ok',
      '## 2. Key References',
      '| Topic | Asset |',
      '## 3. Ingested Activity Logs',
      '<details open><summary>Logs</summary>',
    ]

    for (let i = 1; i <= 10000; i++) {
      lines.push(
        `### 2026-07-28 — Log Entry #${i}\n- **Source**: Automated Ingestion\n- **Subject**: Test Log #${i}`
      )
    }
    lines.push('</details>')

    const largeDocContent = lines.join('\n')
    const newEntry =
      '### 2026-07-28 — Benchmark Test Entry\n- **Source**: Benchmark Test'

    const startTime = Date.now()
    const updatedContent = insertEntryIntoLogSection(largeDocContent, newEntry)
    const elapsedTimeMs = Date.now() - startTime

    expect(updatedContent).toContain('Benchmark Test Entry')
    expect(updatedContent.length).toBeGreaterThan(largeDocContent.length)
    expect(elapsedTimeMs).toBeLessThan(200)
  })

  test('SHA Collision & Retry Logic Stress Test via appendMarkdownEntryToGitHubRepo', () => {
    let attemptCount = 0
    const mockProps = {
      getProperty: (k) => {
        if (k === 'GITHUB_PAT') return 'ghp_bench'
        if (k === 'GITHUB_REPO_OWNER') return 'bench-owner'
        if (k === 'GITHUB_REPO_NAME') return 'bench-repo'
        return ''
      },
    }
    const existingBase64 = Utilities.base64Encode(
      Utilities.newBlob(
        '# Doc\n<details open><summary>Logs</summary>\n</details>'
      ).getBytes()
    )
    const mockUrlFetch = {
      fetch: (_url, options) => {
        if (options.method === 'get') {
          return {
            getResponseCode: () => 200,
            getContentText: () =>
              JSON.stringify({
                sha: 'sha_' + attemptCount,
                content: existingBase64,
              }),
          }
        }
        attemptCount++
        if (attemptCount < 3) {
          return {
            getResponseCode: () => 409,
            getContentText: () => JSON.stringify({ message: 'Conflict' }),
          }
        }
        return {
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify({ commit: { sha: 'ok' } }),
        }
      },
    }

    const success = appendMarkdownEntryToGitHubRepo(
      '01_Household/index.md',
      '### 2026-07-28 — Retry Entry',
      'feat(ingestion): Retry Test',
      {
        PropertiesService: { getScriptProperties: () => mockProps },
        UrlFetchApp: mockUrlFetch,
        Utilities: {
          ...Utilities,
          sleep: () => {},
        },
      }
    )

    expect(success).toBe(true)
    expect(attemptCount).toBe(3)
  })

  test('Batch Processing Throughput Benchmark via processThreadBatch', () => {
    const threads = Array.from({ length: 100 }, (_, i) => ({
      getId: () => `msg_${i}`,
      getMessages: () => [
        {
          getFrom: () => `user_${i}@example.com`,
          getSubject: () => `Subject ${i}`,
          getPlainBody: () => `Plain body text snippet for email #${i}`,
        },
      ],
      addLabel: () => {},
    }))

    const config = {
      modelEndpoint: 'https://example.com/gemini',
      geminiApiKey: 'bench-key',
      processedLabel: 'Processed',
      autoFilterConfidenceThreshold: 0.99,
      canonicalDomains: ['04_Family_Health'],
    }
    const services = {
      GmailApp: {
        getUserLabelByName: (name) => ({
          getName: () => name,
          getId: () => name,
        }),
        createLabel: (name) => ({ getName: () => name, getId: () => name }),
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
                          canonical_label: '04_Family_Health',
                          confidence: 0.98,
                          reasoning: 'benchmark',
                        }),
                      },
                    ],
                  },
                },
              ],
            }),
        }),
      },
      Gmail: null,
    }

    const startTime = Date.now()
    const processed = processThreadBatch(threads, config, services)
    const duration = Date.now() - startTime

    expect(processed.length).toBe(100)
    expect(duration).toBeLessThan(500)
  })

  test('Classification Caching Throughput & Latency Benchmark via classifyWithGemini', () => {
    const memoryStore = new Map()
    const mockCache = {
      get: (k) => memoryStore.get(k) || null,
      put: (k, v) => memoryStore.set(k, v),
    }

    const classification = {
      canonicalDomain: '02_Finance_Legal',
      subLabel: 'Finance/Purchases',
      category: 'Updates',
      action: 'archive',
      confidence: 0.98,
    }

    const mockUrlFetch = {
      fetch: jest.fn(() => ({
        getResponseCode: () => 200,
        getContentText: () =>
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ text: JSON.stringify(classification) }],
                },
              },
            ],
          }),
      })),
    }

    const config = {
      geminiApiKey: 'bench-key',
      canonicalDomains: ['02_Finance_Legal'],
    }
    const services = {
      CacheService: mockCache,
      UrlFetchApp: mockUrlFetch,
    }

    // First call seeds cache via classifyWithGemini
    const firstRes = classifyWithGemini(
      'service@paypal.com',
      'Receipt #100',
      'Payment of $10.00',
      config,
      services
    )
    expect(firstRes).toEqual(classification)
    expect(mockUrlFetch.fetch).toHaveBeenCalledTimes(1)

    // 250 cached retrieval iterations through real classifyWithGemini
    const startTime = Date.now()
    let lastRes = null
    for (let i = 0; i < 250; i++) {
      lastRes = classifyWithGemini(
        'service@paypal.com',
        'Receipt #100',
        'Payment of $10.00',
        config,
        services
      )
    }
    const elapsed = Date.now() - startTime

    expect(lastRes.canonicalDomain).toBe('02_Finance_Legal')
    expect(mockUrlFetch.fetch).toHaveBeenCalledTimes(1)
    expect(elapsed).toBeLessThan(500)
  })
})
