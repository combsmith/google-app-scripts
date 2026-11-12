const fs = require('fs')
const path = require('path')

// Regression guard for #679: the `Secret scan (gitleaks)` job in ci.yml failed
// on Dependabot-triggered runs because gitleaks/gitleaks-action requires a
// GITLEAKS_LICENSE secret for organization repos, and Dependabot runs receive
// no Actions secrets. The org-canonical job (combsmith/.github
// standards/workflows/ci.yml, push-protection.md#required-ci-job) uses the
// pinned, checksum-verified gitleaks CLI instead, which needs no license.

const workflowPath = path.join(
  __dirname,
  '..',
  '..',
  '.github',
  'workflows',
  'ci.yml'
)

// Returns the text of a top-level job block (2-space-indented key under
// `jobs:`) up to the next top-level job or end of file.
function extractJob(workflow, jobId) {
  const lines = workflow.split(/\r?\n/)
  const keyRe = /^ {2}(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+)):\s*(?:#.*)?$/
  const start = lines.findIndex((l) => {
    const m = keyRe.exec(l)
    return m !== null && (m[1] || m[2] || m[3]) === jobId
  })
  if (start === -1) {
    throw new Error(`Job "${jobId}" not found in ci.yml`)
  }
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    // Next job key, or a new top-level YAML key; column-0 comments are ignored.
    if (keyRe.test(lines[i]) || /^[A-Za-z0-9_-]+:/.test(lines[i])) {
      end = i
      break
    }
  }
  return lines.slice(start, end).join('\n')
}

describe('ci.yml secret-scan job (#679)', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8')
  const job = extractJob(workflow, 'secret-scan')

  it('keeps the required-check job name stable', () => {
    expect(job).toMatch(/^\s+name: Secret scan \(gitleaks\)$/m)
  })

  it('does not use the license-gated gitleaks-action', () => {
    expect(job).not.toMatch(/uses:\s*gitleaks\/gitleaks-action/)
  })

  it('does not depend on the GITLEAKS_LICENSE secret (unavailable to Dependabot)', () => {
    expect(job).not.toMatch(/GITLEAKS_LICENSE/)
    expect(job).not.toMatch(/secrets\./)
  })

  it('installs a pinned gitleaks CLI release and verifies its checksum', () => {
    expect(job).toMatch(/GITLEAKS_VERSION:\s*["']?\d+\.\d+\.\d+["']?/)
    expect(job).toMatch(/GITLEAKS_CHECKSUM:\s*["']?[0-9a-f]{64}["']?/)
    expect(job).toMatch(/sha256sum -c/)
  })

  it('runs gitleaks detect over full history and fails on findings', () => {
    expect(job).toMatch(/fetch-depth:\s*0/)
    expect(job).toMatch(/run:\s*gitleaks detect .*--exit-code 1/)
    expect(job).toMatch(/gitleaks detect.*--redact(?:=100)?/)
    expect(job).not.toMatch(/gitleaks detect.*--redact=0/)
  })

  it('runs gitleaks with full redaction that cannot be weakened', () => {
    const cmd = /run:\s*(gitleaks detect .*)$/m.exec(job)
    expect(cmd).not.toBeNull()
    const command = cmd[1]
    const redactArgs = command
      .split(/\s+/)
      .filter((arg) => arg.startsWith('--redact'))
    // Exactly one redact flag, bare (defaults to 100%) or explicitly 100.
    expect(redactArgs).toHaveLength(1)
    expect(['--redact', '--redact=100']).toContain(redactArgs[0])
    // Ensure no weakening flags exist that could override full redaction
    expect(command).not.toMatch(/--redact=0/)
  })

  it('requests only contents: read', () => {
    expect(job).toMatch(/permissions:\s*\n\s+contents:\s*read\b/)
    expect(job).not.toMatch(/security-events:/)
  })
})
