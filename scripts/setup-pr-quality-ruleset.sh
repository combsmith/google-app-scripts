#!/usr/bin/env bash
# setup-pr-quality-ruleset.sh
#
# Creates the org-standard "pr-quality" repository ruleset, which enforces
# pull-request reviews and blocks force-pushes on the default branch.
#
# Standard reference:
#   https://github.com/combsmith/.github/blob/main/standards/github-settings.md#pr-quality--standard-ruleset-all-repositories
#
# What this script does:
#   1. Checks whether the "pr-quality" ruleset already exists
#   2. Creates it if missing, or updates it if present so drifted parameters
#      (e.g. dismiss_stale_reviews_on_push, require_last_push_approval)
#      reconverge to the codified standard (idempotent — safe to re-run)
#
# Prerequisites: gh (authenticated with repo admin rights)
# Usage:
#   bash scripts/setup-pr-quality-ruleset.sh                  # current repo
#   bash scripts/setup-pr-quality-ruleset.sh owner/other-repo # specific repo

set -euo pipefail

RULESET_NAME="pr-quality"

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

echo "=== pr-quality Ruleset Setup ==="
echo "  Ruleset: $RULESET_NAME"
echo "  Repo:    $REPO"
echo ""

# ── Preflight ─────────────────────────────────────────────────────────────────
command -v gh >/dev/null || { echo "Error: gh CLI is required" >&2; exit 1; }
command -v jq >/dev/null || { echo "Error: jq is required" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "Error: gh not authenticated" >&2; exit 1; }

# ── Check if ruleset already exists ───────────────────────────────────────────
EXISTING_ID=$(gh api "repos/$REPO/rulesets?includes_parents=false" -q ".[] | select(.name == \"$RULESET_NAME\") | .id" 2>/dev/null || echo "")

# ── Ruleset payload (used for both create and update) ─────────────────────────
# Compliance-pinned parameters (do not relax — enforced by scripts/tests/
# setup-pr-quality-ruleset.test.js and the weekly compliance audit):
#   dismiss_stale_reviews_on_push: true   (issue #555)
#   require_last_push_approval:    true   (issue #539)
RULESET_PAYLOAD=$(cat <<'JSON'
{
  "name": "pr-quality",
  "target": "branch",
  "enforcement": "active",
  "conditions": {
    "ref_name": {
      "include": ["~DEFAULT_BRANCH"],
      "exclude": []
    }
  },
  "rules": [
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 1,
        "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": false,
        "require_last_push_approval": true,
        "required_review_thread_resolution": true
      }
    },
    {
      "type": "non_fast_forward"
    }
  ]
}
JSON
)

if [[ -n "$EXISTING_ID" ]]; then
  echo "  ↻ '$RULESET_NAME' ruleset already exists (id: $EXISTING_ID) — updating to ensure compliance..."
  # Fetch existing ruleset and preserve all fields not being updated
  EXISTING_RULESET=$(gh api "repos/$REPO/rulesets/$EXISTING_ID")
  # Merge new configuration into existing ruleset: preserve bypass_actors and other fields
  UPDATE_PAYLOAD=$(printf '%s' "$RULESET_PAYLOAD" | jq --slurpfile existing <(echo "$EXISTING_RULESET") '
    . as $new
    | $existing[0]
    | .name = $new.name
    | .target = $new.target
    | .enforcement = $new.enforcement
    | .conditions = $new.conditions
    | .rules = $new.rules
  ')
  # Validate required fields are present
  if ! printf '%s' "$UPDATE_PAYLOAD" | jq -e '.name and .target and .rules and (.rules | length > 0)' >/dev/null 2>&1; then
    echo "Error: Invalid ruleset payload after merge (missing required fields)" >&2
    exit 1
  fi
  printf '%s\n' "$UPDATE_PAYLOAD" | gh api "repos/$REPO/rulesets/$EXISTING_ID" --method PUT --input -
  echo "  ✓ '$RULESET_NAME' ruleset updated successfully."
  echo ""
  echo "=== Done ==="
  exit 0
fi

# ── Create the pr-quality ruleset ─────────────────────────────────────────────
echo "Creating '$RULESET_NAME' ruleset..."

printf '%s\n' "$RULESET_PAYLOAD" | gh api "repos/$REPO/rulesets" --method POST --input -

echo ""
echo "=== Done ==="
