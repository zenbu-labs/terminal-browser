#!/usr/bin/env bash
# fixme: placeholder copy
# Posts <body file> on the open PR of <branch>, replacing the earlier comment posted with the same <key>.
# Without an open PR the body goes to the job summary only.
# Usage: pr-comment.sh <branch> <key> <body file>
set -euo pipefail

# fixme: placeholder copy
usage="usage: pr-comment.sh <branch> <key> <body file>"
branch="${1:?$usage}"
key="${2:?$usage}"
body_file="${3:?$usage}"
marker="<!-- $key -->"

cat "$body_file" >> "$GITHUB_STEP_SUMMARY"

pr=$(gh pr list -R "$GITHUB_REPOSITORY" --head "$branch" --state open --json number --jq '.[0].number // empty')
if [ -z "$pr" ]; then
  echo "no open PR for $branch"
  exit 0
fi

body="$marker
$(cat "$body_file")"
existing=$(gh api "repos/$GITHUB_REPOSITORY/issues/$pr/comments" --paginate \
  --jq ".[] | select(.body | startswith(\"$marker\")) | .id" | tail -1)
if [ -n "$existing" ]; then
  gh api -X PATCH "repos/$GITHUB_REPOSITORY/issues/comments/$existing" -f body="$body" >/dev/null
else
  gh api "repos/$GITHUB_REPOSITORY/issues/$pr/comments" -f body="$body" >/dev/null
fi
echo "commented on #$pr"
