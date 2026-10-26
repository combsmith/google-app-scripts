const fs = require('fs')
const path = require('path')

// Extracts the JSON payload from the heredoc in setup-pr-quality-ruleset.sh.
// The script codifies the org-standard "pr-quality" ruleset; this test guards
// against configuration drift of the ruleset parameters. Compliance findings
// this guard protects against: #520 (initial drift guard), #539
// (require_last_push_approval), #555 (dismiss_stale_reviews_on_push).
function loadRulesetPayload() {
  const scriptPath = path.join(__dirname, '..', 'setup-pr-quality-ruleset.sh')
  const script = fs.readFileSync(scriptPath, 'utf8')
  const match = script.match(/<<'JSON'\r?\n([\s\S]*?)\r?\nJSON/)
  if (!match) {
    throw new Error('Could not locate the JSON heredoc payload in the script')
  }
  return JSON.parse(match[1])
}

describe('setup-pr-quality-ruleset.sh codified ruleset', () => {
  const payload = loadRulesetPayload()

  it('defines the pr-quality ruleset', () => {
    expect(payload.name).toBe('pr-quality')
  })

  it('requires last-push approval on the pull_request rule', () => {
    const pullRequestRule = payload.rules.find((r) => r.type === 'pull_request')
    expect(pullRequestRule).toBeDefined()
    expect(pullRequestRule?.parameters?.require_last_push_approval).toBe(true)
  })

  it('dismisses stale reviews on push (dismiss_stale_reviews_on_push)', () => {
    const pullRequestRule = payload.rules.find((r) => r.type === 'pull_request')
    expect(pullRequestRule).toBeDefined()
    expect(pullRequestRule?.parameters?.dismiss_stale_reviews_on_push).toBe(
      true
    )
  })

  it('has exactly one pull_request rule with all required parameters', () => {
    const pullRequestRules = payload.rules.filter(
      (r) => r.type === 'pull_request'
    )
    expect(pullRequestRules).toHaveLength(1)
    expect(pullRequestRules[0]?.parameters).toEqual({
      required_approving_review_count: 1,
      dismiss_stale_reviews_on_push: true,
      require_code_owner_review: false,
      require_last_push_approval: true,
      required_review_thread_resolution: true,
    })
  })

  it('targets the default branch with correct conditions', () => {
    expect(payload.conditions.ref_name.include).toEqual(['~DEFAULT_BRANCH'])
    expect(payload.conditions.ref_name.exclude).toEqual([])
  })

  it('script updates existing rulesets via PUT to enforce compliance', () => {
    const scriptPath = path.join(__dirname, '..', 'setup-pr-quality-ruleset.sh')
    const script = fs.readFileSync(scriptPath, 'utf8')
    expect(script).toMatch(/--method PUT/)
  })

  it('script preserves existing bypass_actors when updating an existing ruleset', () => {
    const scriptPath = path.join(__dirname, '..', 'setup-pr-quality-ruleset.sh')
    const script = fs.readFileSync(scriptPath, 'utf8')
    // The update path must fetch the existing ruleset and merge fields so a PUT
    // preserves bypass_actors and other fields set by administrators.
    expect(script).toMatch(/bypass_actors/)
    expect(script).toMatch(/EXISTING_RULESET/)
  })

  it('script merges new configuration into existing ruleset preserving all fields', () => {
    const scriptPath = path.join(__dirname, '..', 'setup-pr-quality-ruleset.sh')
    const script = fs.readFileSync(scriptPath, 'utf8')
    // The update flow must fetch the existing ruleset and selectively update
    // fields (name, target, enforcement, conditions, rules) while preserving
    // bypass_actors and other fields not in the new payload.
    expect(script).toMatch(/EXISTING_RULESET=.*gh api.*rulesets.*EXISTING_ID/)
    expect(script).toMatch(/slurpfile.*existing/)
    // Verify field-by-field update pattern in jq to preserve all existing fields
    expect(script).toMatch(/\.name = \$new\.name/)
    expect(script).toMatch(/\.rules = \$new\.rules/)
    expect(script).toMatch(/\$existing\[0\]/)
  })

  it('script validates merged payload before submitting', () => {
    const scriptPath = path.join(__dirname, '..', 'setup-pr-quality-ruleset.sh')
    const script = fs.readFileSync(scriptPath, 'utf8')
    // Validation ensures the merged payload is well-formed and contains required fields
    expect(script).toMatch(/jq -e.*\.name.*\.target.*\.rules/)
  })
})
