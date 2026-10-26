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
 * Usage:
 *   node scripts/check-no-pii.js           # Scans repository files from repo root
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

// Extensions and directories to scan
const SCANNABLE_EXTENSIONS = new Set([
  '.js',
  '.ts',
  '.gs',
  '.json',
  '.md',
  '.yml',
  '.yaml',
  '.html',
])

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

function getAllRepoFiles(dir = REPO_ROOT, base = '') {
  let results = []
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const relPath = toPosixPath(path.join(base, entry.name))
    if (isIgnoredPath(relPath)) continue

    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      results = results.concat(getAllRepoFiles(fullPath, relPath))
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase()
      if (SCANNABLE_EXTENSIONS.has(ext)) {
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
      })
    } catch {
      return null
    }
  }

  const fullPath = path.resolve(REPO_ROOT, relPath)
  if (!fs.existsSync(fullPath)) return null
  return fs.readFileSync(fullPath, 'utf8')
}

function scanFile(relPath, { isStagedOnly = false } = {}) {
  if (isIgnoredPath(relPath)) return []
  const content = readTargetFileContent(relPath, isStagedOnly)
  if (!content) return []

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
    ? getStagedFiles().filter((f) => {
        const ext = path.extname(f).toLowerCase()
        return SCANNABLE_EXTENSIONS.has(ext) && !isIgnoredPath(f)
      })
    : getAllRepoFiles()

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
