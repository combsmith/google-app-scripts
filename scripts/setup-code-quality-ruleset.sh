#!/usr/bin/env bash
# setup-code-quality-ruleset.sh
#
# Creates the "code-quality" repository ruleset that enforces required status
# checks before merging to protected branches (main).
#
# Standard: https://github.com/combsmith/.github/blob/main/standards/github-settings.md#code-quality--required-checks-ruleset-all-repositories
#
# What this script does:
#   1. Creates (or updates) the "code-quality" ruleset on the target repository
#   2. Requires the CI, test, and coverage status checks to pass before merge
#
# Prerequisites: gh (authenticated with admin access to the repository)
# Usage:
#   bash scripts/setup-code-quality-ruleset.sh                          # current repo
#   bash scripts/setup-code-quality-ruleset.sh owner/other-repo         # specific repo

set -euo pipefail

RULESET_NAME="code-quality"

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

echo "=== Code Quality Ruleset Setup ==="
echo "  Ruleset: $RULESET_NAME"
echo "  Repo:    $REPO"
echo ""

# ── Preflight ─────────────────────────────────────────────────────────────────
command -v gh >/dev/null || { echo "Error: gh is required" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "Error: gh not authenticated" >&2; exit 1; }

# ── Check if ruleset already exists ───────────────────────────────────────────
EXISTING_ID=$(gh api "repos/$REPO/rulesets" -q ".[] | select(.name == \"$RULESET_NAME\") | .id" 2>/dev/null || echo "")

RULESET_PAYLOAD='{
  "name": "code-quality",
  "target": "branch",
  "enforcement": "active",
  "conditions": {
    "ref_name": {
      "include": ["refs/heads/main"],
      "exclude": []
    }
  },
  "rules": [
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": false,
        "required_status_checks": [
          { "context": "CI Pipeline / build-and-test" },
          { "context": "Node.js Tests / Node.js Tests" },
          { "context": "Coverage / coverage" }
        ]
      }
    }
  ]
}'

if [[ -z "$EXISTING_ID" ]]; then
  echo "Creating '$RULESET_NAME' ruleset..."
  echo "$RULESET_PAYLOAD" | gh api "repos/$REPO/rulesets" --method POST --input - >/dev/null
  echo "  ✓ Ruleset '$RULESET_NAME' created"
else
  echo "Updating existing '$RULESET_NAME' ruleset (ID: $EXISTING_ID)..."
  echo "$RULESET_PAYLOAD" | gh api "repos/$REPO/rulesets/$EXISTING_ID" --method PUT --input - >/dev/null
  echo "  ✓ Ruleset '$RULESET_NAME' updated"
fi

echo ""
echo "=== Setup complete for $REPO ==="
echo ""
echo "Required status checks:"
echo "  • CI Pipeline / build-and-test"
echo "  • Node.js Tests / Node.js Tests"
echo "  • Coverage / coverage"
