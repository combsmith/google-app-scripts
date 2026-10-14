#!/usr/bin/env bash
# apply-repo-settings.sh
#
# Applies required security_and_analysis settings to the repository via the
# GitHub API, per the push-protection standard:
# https://github.com/combsmith/.github/blob/main/standards/push-protection.md#required-repo-level-settings
#
# What this script does:
#   1. Enables secret scanning
#   2. Enables secret scanning push protection
#   3. Enables secret scanning AI detection
#   4. Enables secret scanning non-provider patterns
#   5. Enables Dependabot security updates
#   6. Disables check-suite auto-trigger for CodeRabbit (347564)
#   7. Disables check-suite auto-trigger for Claude (1236702)
#
# Prerequisites: gh (authenticated with admin access to the repository)
# Usage:
#   bash scripts/apply-repo-settings.sh                          # current repo
#   bash scripts/apply-repo-settings.sh owner/other-repo         # specific repo

set -euo pipefail

# Target repo: first arg, or detect from current directory
if [[ -n "${1:-}" ]]; then
  REPO="$1"
else
  REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || true)"
  if [[ -z "$REPO" ]]; then
    echo "Usage: $0 [owner/repo]" >&2
    exit 1
  fi
fi

echo "=== Apply Repo Security Settings ==="
echo "  Repo: $REPO"
echo ""

# ── Preflight ─────────────────────────────────────────────────────────────────
command -v gh >/dev/null || { echo "Error: gh is required" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "Error: gh not authenticated" >&2; exit 1; }

# ── Apply security_and_analysis settings ──────────────────────────────────────
echo "Applying security_and_analysis settings..."

gh api -X PATCH "repos/$REPO" --input - <<'JSON'
{
  "security_and_analysis": {
    "secret_scanning":                      {"status": "enabled"},
    "secret_scanning_push_protection":      {"status": "enabled"},
    "secret_scanning_ai_detection":         {"status": "enabled"},
    "secret_scanning_non_provider_patterns":{"status": "enabled"},
    "dependabot_security_updates":          {"status": "enabled"}
  }
}
JSON

echo "  ✓ secret_scanning"
echo "  ✓ secret_scanning_push_protection"
echo "  ✓ secret_scanning_ai_detection"
echo "  ✓ secret_scanning_non_provider_patterns"
echo "  ✓ dependabot_security_updates"

# ── Disable check-suite auto-trigger for CodeRabbit and Claude ────────────────
# These apps create queued check suites on every push that are never completed,
# permanently blocking auto-merge. Disabling auto-trigger prevents this.
# Reference: https://github.com/combsmith/.github/blob/main/standards/github-settings.md#check-suite-auto-trigger-configuration
echo ""
echo "Disabling check-suite auto-trigger for CodeRabbit and Claude..."

gh api -X PATCH "repos/$REPO/check-suites/preferences" --input - <<'JSON'
{
  "auto_trigger_checks": [
    {"app_id": 347564, "setting": false},
    {"app_id": 1236702, "setting": false}
  ]
}
JSON

echo "  ✓ CodeRabbit (347564) auto_trigger_checks: false"
echo "  ✓ Claude (1236702) auto_trigger_checks: false"

# ── Verify ────────────────────────────────────────────────────────────────────
echo ""
echo "Verifying settings..."
gh api "repos/$REPO" --jq '.security_and_analysis'

echo ""
echo "=== Done for $REPO ==="
