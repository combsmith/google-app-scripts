#!/usr/bin/env node
// pii-scanner-definition

/**
 * Strict No-PII Scanner for petry-projects/google-app-scripts
 * Ensures that open-source code, docs, and tests remain completely generic
 * and free of personal household identities, addresses, and private businesses.
 *
 * Additional household-specific rules can be supplied out-of-band via:
 *   - `PII_CUSTOM_RULES_JSON` environment variable (JSON array of { name, pattern, flags?, description, whitelist? })
 *   - `.pii-rules.json` in the repository root (gitignored)
 *
 * Coverage:
 *   - Scans ALL text files (any extension, including extensionless, `.txt`, `.sh`,
 *     `.py`, `.csv`, `.env*`) using a binary-extension denylist plus NUL-byte
 *     detection, so fixtures and scripts are not blind spots.
 *   - Full mode scans git-tracked files (`git ls-files`), mirroring what CI sees.
 *
 * CI limitation:
 *   CI only enforces the generic BASE_PROHIBITED_RULES below. Household-specific
 *   rules (first names, addresses, local businesses) live in the gitignored
 *   `.pii-rules.json` or the `PII_CUSTOM_RULES_JSON` env var, so they are enforced
 *   locally (pre-commit) and in CI only when that secret/env var is configured.
 *
 * Usage:
 *   node scripts/check-no-pii.js           # Scans git-tracked repository files
 *   node scripts/check-no-pii.js --staged  # Scans only git-staged index blobs
 */

const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const REPO_ROOT = path.resolve(__dirname, '..')

// Base PII patterns with human-readable descriptions
const BASE_PROHIBITED_RULES = [
  {
    name: 'Household Surnames',
    pattern: /\b(Petry)\b/gi,
    description:
      'Household surname found outside of allowed open-source organizational context.',
    whitelist: [
      /petry-projects/i,
      /dependabot-automerge-petry/i, // org-level GitHub App name (infrastructure, not personal data)
      /github\.com\/don-petry/i,
      /github\.com\/petry-projects/i,
      /Copyright \(c\) \d{4} Don Petry/i,
      /Don Petry \u2013/i,
      /Petry-Projects \u2013/i,
    ],
  },
  {
    name: 'Personal Gmail Addresses',
    pattern: /\b[a-zA-Z0-9._%+-]+@gmail\.com\b/gi,
    description:
      'Personal Gmail addresses must not be in open-source files; use generic placeholders (e.g. user@example.com).',
    whitelist: [
      /^household-member@gmail\.com$/i,
      /^your-email@gmail\.com$/i,
      /^primary@gmail\.com$/i,
      /^testuser@gmail\.com$/i,
    ],
  },
  {
    name: 'US Social Security Numbers',
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
    description: 'Social Security Numbers must never be committed.',
    whitelist: [/^000-00-0000$/, /^123-45-6789$/],
  },
]

function loadCustomRules() {
  const customRules = []
  let rawJson = process.env.PII_CUSTOM_RULES_JSON || ''
  if (!rawJson) {
    const localRulesPath = path.join(REPO_ROOT, '.pii-rules.json')
    if (fs.existsSync(localRulesPath)) {
      rawJson = fs.readFileSync(localRulesPath, 'utf8')
    }
  }
  if (!rawJson) return customRules

  try {
    const parsed = JSON.parse(rawJson)
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        if (entry && entry.name && entry.pattern) {
          const flags = entry.flags
            ? entry.flags.includes('g')
              ? entry.flags
              : `${entry.flags}g`
            : 'gi'
          customRules.push({
            name: entry.name,
            pattern: new RegExp(entry.pattern, flags),
            description:
              entry.description ||
              'Prohibited custom PII pattern matched in repository.',
            whitelist: Array.isArray(entry.whitelist)
              ? entry.whitelist.map((w) => new RegExp(w, 'i'))
              : undefined,
          })
        }
      }
    }
  } catch (err) {
    console.error('Error parsing custom PII rules:', err.message)
    process.exit(1)
  }
  return customRules
}

const PROHIBITED_RULES = [...BASE_PROHIBITED_RULES, ...loadCustomRules()]

// Binary extensions that are never scanned; every other file is treated as text
// (and additionally skipped at read time if it contains NUL bytes).
const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.bmp',
  '.ico',
  '.webp',
  '.heic',
  '.tif',
  '.tiff',
  '.pdf',
  '.zip',
  '.gz',
  '.tgz',
  '.7z',
  '.jar',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  '.mp3',
  '.mp4',
  '.mov',
  '.wasm',
])

function isScannablePath(relPath) {
  return !BINARY_EXTENSIONS.has(path.extname(relPath).toLowerCase())
}

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'coverage',
  'dist',
  'build',
  '.wt-',
])

function toPosixPath(p) {
  return p.split(path.sep).join('/')
}

function isIgnoredPath(relPath) {
  const posixPath = toPosixPath(relPath)
  const parts = posixPath.split('/')
  for (const part of parts) {
    if (IGNORED_DIRS.has(part) || part.startsWith('.wt-')) {
      return true
    }
  }
  if (
    posixPath === 'scripts/check-no-pii.js' ||
    posixPath === '.pii-rules.json'
  ) {
    return true
  }
  return false
}

function getStagedFiles() {
  try {
    const output = execFileSync(
      'git',
      ['diff', '--cached', '-z', '--name-only', '--diff-filter=ACMR'],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      }
    )
    return output
      .split('\0')
      .map((f) => f.trim())
      .filter(Boolean)
  } catch (err) {
    console.error('Error fetching staged files from git:', err.message)
    process.exit(1)
  }
}

function getTrackedRepoFiles() {
  try {
    const output = execFileSync('git', ['ls-files', '-z'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
    return output
      .split('\0')
      .filter(Boolean)
      .filter((f) => !isIgnoredPath(f) && isScannablePath(f))
      .filter((f) => {
        const fullPath = path.resolve(REPO_ROOT, f)
        try {
          const stat = fs.lstatSync(fullPath)
          return !stat.isSymbolicLink()
        } catch {
          return false
        }
      })
  } catch {
    return null
  }
}

function getAllRepoFiles(dir = REPO_ROOT, base = '') {
  let results = []
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const relPath = toPosixPath(path.join(base, entry.name))
    if (isIgnoredPath(relPath)) continue

    const fullPath = path.join(dir, entry.name)
    if (entry.isSymbolicLink()) {
      continue
    } else if (entry.isDirectory()) {
      results = results.concat(getAllRepoFiles(fullPath, relPath))
    } else if (entry.isFile()) {
      if (isScannablePath(relPath)) {
        results.push(relPath)
      }
    }
  }
  return results
}

function isMatchWhitelisted(line, match, whitelist) {
  if (!whitelist || whitelist.length === 0) return false
  const matchedText = match[0]
  const matchStart = match.index
  const matchEnd = matchStart + matchedText.length

  for (const wl of whitelist) {
    if (wl.test(matchedText)) {
      return true
    }
    const globalFlags = wl.flags.includes('g') ? wl.flags : `${wl.flags}g`
    const globalWl = new RegExp(wl.source, globalFlags)
    for (const wlMatch of line.matchAll(globalWl)) {
      const wlStart = wlMatch.index
      const wlEnd = wlStart + wlMatch[0].length
      if (matchStart >= wlStart && matchEnd <= wlEnd) {
        return true
      }
    }
  }
  return false
}

function readTargetFileContent(relPath, isStagedOnly) {
  const posixRelPath = toPosixPath(relPath)
  if (isStagedOnly) {
    try {
      return execFileSync('git', ['show', `:${posixRelPath}`], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024,
      })
    } catch (err) {
      console.error(
        `Error reading staged blob for ${relPath}: ${err.message}\n` +
          'Blob may exceed buffer limit or access may be denied. Failing PII check.'
      )
      process.exit(1)
    }
  }

  const fullPath = path.resolve(REPO_ROOT, relPath)
  if (!fs.existsSync(fullPath)) return null
  return fs.readFileSync(fullPath, 'utf8')
}

function scanFile(relPath, { isStagedOnly = false } = {}) {
  if (isIgnoredPath(relPath)) return []
  let content = readTargetFileContent(relPath, isStagedOnly)
  if (!content) return []

  if (content.includes('\0')) {
    if (!isStagedOnly) {
      const fullPath = path.resolve(REPO_ROOT, relPath)
      try {
        const buffer = fs.readFileSync(fullPath)
        if (buffer.length >= 2) {
          if (
            (buffer[0] === 0xff && buffer[1] === 0xfe) ||
            (buffer[0] === 0xfe && buffer[1] === 0xff)
          ) {
            content = buffer.toString('utf16le')
            if (content.includes('\0')) {
              console.error(
                `Error: ${relPath} contains binary/NUL bytes even after UTF-16 decode; cannot scan for PII`
              )
              process.exit(1)
            }
          } else {
            console.error(
              `Error: ${relPath} contains binary/NUL bytes; cannot scan for PII`
            )
            process.exit(1)
          }
        } else {
          console.error(
            `Error: ${relPath} contains binary/NUL bytes; cannot scan for PII`
          )
          process.exit(1)
        }
      } catch (err) {
        console.error(
          `Error: ${relPath} cannot be decoded as text; cannot scan for PII`
        )
        process.exit(1)
      }
    } else {
      console.error(
        `Error: ${relPath} contains binary/NUL bytes in staged blob; cannot scan for PII`
      )
      process.exit(1)
    }
  }

  const lines = content.split('\n')
  const violations = []

  lines.forEach((line, index) => {
    // Support inline ignore: // pii-ignore or <!-- pii-ignore -->
    if (line.includes('pii-ignore')) return

    for (const rule of PROHIBITED_RULES) {
      const flags = rule.pattern.flags.includes('g')
        ? rule.pattern.flags
        : `${rule.pattern.flags}g`
      const globalPattern = new RegExp(rule.pattern.source, flags)

      for (const match of line.matchAll(globalPattern)) {
        if (isMatchWhitelisted(line, match, rule.whitelist)) {
          continue
        }

        violations.push({
          file: toPosixPath(relPath),
          line: index + 1,
          rule: rule.name,
          match: match[0],
          description: rule.description,
        })
      }
    }
  })

  return violations
}

function main() {
  const isStagedOnly = process.argv.includes('--staged')
  const filesToScan = isStagedOnly
    ? getStagedFiles().filter((f) => isScannablePath(f) && !isIgnoredPath(f))
    : getTrackedRepoFiles() || getAllRepoFiles()

  if (filesToScan.length === 0) {
    console.log('✅ No scannable files found. PII check passed.')
    process.exit(0)
  }

  let totalViolations = []
  for (const file of filesToScan) {
    const violations = scanFile(file, { isStagedOnly })
    if (violations.length > 0) {
      totalViolations = totalViolations.concat(violations)
    }
  }

  if (totalViolations.length > 0) {
    console.error(
      '\n❌ PII CHECK FAILED — Prohibited Personal Information Detected:'
    )
    console.error(
      '─────────────────────────────────────────────────────────────────'
    )
    for (const v of totalViolations) {
      console.error(
        `• [${v.rule}] ${v.file}:${v.line}\n  Matched: "${v.match}"\n  Remedy: ${v.description}\n`
      )
    }
    console.error(
      '─────────────────────────────────────────────────────────────────'
    )
    console.error(
      'The petry-projects/google-app-scripts repository is a generic open-source'
    )
    console.error(
      'harness. Personal student names, private businesses, and household addresses'
    )
    console.error(
      'must be injected via ScriptProperties (CUSTOM_PROMPT_RULES), never committed.'
    )
    console.error(
      '─────────────────────────────────────────────────────────────────\n'
    )
    process.exit(1)
  }

  console.log(
    `✅ Strict No-PII check passed (${filesToScan.length} file(s) scanned).`
  )
  process.exit(0)
}

main()
