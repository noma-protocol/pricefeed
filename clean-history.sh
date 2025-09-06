#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
Usage:
  clean-history.sh <start-commit> [weeks|w=<W>]
  clean-history.sh - n=<N> [weeks|w=<W>]
  clean-history.sh n=<N> [weeks|w=<W>]     # shorthand; implies "-"
  clean-history.sh <N> [<W>]               # shorthand; numeric first arg => N mode

Notes:
  N = number of commits back from HEAD (N=0 => root commit)
  W = weeks to shift timestamps (default: 3)
Examples:
  clean-history.sh 1 0        # last 1 commit, 0 weeks shift
  clean-history.sh 10 0       # last 10 commits, 0 weeks shift
  clean-history.sh 0 0        # from root, 0 weeks shift
  clean-history.sh <hash> w=0 # explicit start hash, 0 weeks shift
USAGE
}

[ $# -ge 1 ] || { usage; exit 1; }

ARG1="${1-}"
ARG2="${2-}"
ARG3="${3-}"

# Defaults
N=""
WEEKS=3

# Detect mode: explicit hash vs derive-from-N
MODE="hash"
START_COMMIT_RAW="$ARG1"
if [[ "$ARG1" == "-" ]]; then
  MODE="from_n"
elif [[ "$ARG1" =~ ^n=([0-9]+)$ ]]; then
  MODE="from_n"
  N="${BASH_REMATCH[1]}"
  START_COMMIT_RAW="-"
elif [[ "$ARG1" =~ ^[0-9]+$ ]]; then
  # NEW: numeric first arg => N mode
  MODE="from_n"
  N="$ARG1"
  START_COMMIT_RAW="-"
fi

parse_token() {
  local t="$1"
  [[ -z "$t" ]] && return 0
  case "$t" in
    n=*) N="${t#n=}" ;;
    w=*) WEEKS="${t#w=}" ;;
    *)
      if [[ "$t" =~ ^[0-9]+$ ]]; then
        if [[ "$MODE" == "from_n" ]]; then
          if [[ -z "$N" ]]; then N="$t"; else WEEKS="$t"; fi
        else
          WEEKS="$t"   # hash mode: bare number = weeks (back-compat)
        fi
      fi
      ;;
  esac
}

parse_token "$ARG2"
parse_token "$ARG3"

SHIFT_SEC=$((WEEKS * 7 * 24 * 60 * 60))

# Identity
#NEW_NAME="0xAlbert"; NEW_EMAIL="0xalbertdefi@gmail.com"
NEW_NAME="0xSufi";  NEW_EMAIL="0xsufi@noma.money"

# Current branch
CUR_REF="$(git symbolic-ref -q --short HEAD || true)"
[[ -n "$CUR_REF" ]] || { echo "Detached HEAD; checkout a branch." >&2; exit 1; }
CUR_FULL_REF="refs/heads/${CUR_REF}"

resolve_start_from_n() {
  local n="$1"
  [[ "$n" =~ ^[0-9]+$ ]] || { echo "Invalid n: $n" >&2; exit 1; }
  if (( n == 0 )); then
    git rev-list --max-parents=0 HEAD | head -n1
  else
    local c
    c="$(git rev-list --first-parent --max-count=$((n+1)) HEAD | tail -n1 || true)"
    [[ -n "$c" ]] || c="$(git rev-list --max-parents=0 HEAD | head -n1)"
    echo "$c"
  fi
}

if [[ "$MODE" == "from_n" ]]; then
  [[ -n "$N" ]] || { echo "Provide n or n=<N> when using '-' / numeric mode." >&2; exit 1; }
  START_COMMIT="$(resolve_start_from_n "$N")"
else
  START_COMMIT="$START_COMMIT_RAW"
fi

git merge-base --is-ancestor "$START_COMMIT" HEAD \
  || { echo "Error: $START_COMMIT is not an ancestor of HEAD on $CUR_REF" >&2; exit 1; }

RANGE_SPEC="${START_COMMIT}..refs/heads/${CUR_REF}"

RANGE_FILE="$(mktemp -t range-commits.XXXXXX)"
trap 'rm -f "$RANGE_FILE"' EXIT
git rev-list "$RANGE_SPEC" > "$RANGE_FILE"
COUNT=$(wc -l < "$RANGE_FILE" | tr -d ' ')

echo
echo "ℹ️  Rewriting $CUR_REF commits in ${START_COMMIT}..HEAD ($COUNT commits)"
echo "   • Shift dates by ${WEEKS} week(s) (${SHIFT_SEC}s)"
echo "   • Set identity to ${NEW_NAME} <${NEW_EMAIL}>"
echo "   • Remove Claude/Co-Author footers"
echo

git tag -f "backup/pre-filter-branch-$(date +%s)" >/dev/null

export SHIFT_SEC NEW_NAME NEW_EMAIL RANGE_FILE

git filter-branch -f \
  --tag-name-filter cat \
  --env-filter '
    if grep -qxF "$GIT_COMMIT" "$RANGE_FILE"; then
      set -- $GIT_AUTHOR_DATE
      ts=""; tz="${2:-+0000}"
      case "$1" in @*) ts="${1#@}" ;; *) ts="$(date -d "$GIT_AUTHOR_DATE" +%s 2>/dev/null || true)" ;; esac
      if [ -n "$ts" ]; then new_ts=$((ts - SHIFT_SEC)); export GIT_AUTHOR_DATE="@${new_ts} ${tz}"; fi

      set -- $GIT_COMMITTER_DATE
      ts=""; tz="${2:-+0000}"
      case "$1" in @*) ts="${1#@}" ;; *) ts="$(date -d "$GIT_COMMITTER_DATE" +%s 2>/dev/null || true)" ;; esac
      if [ -n "$ts" ]; then new_ts=$((ts - SHIFT_SEC)); export GIT_COMMITTER_DATE="@${new_ts} ${tz}"; fi

      export GIT_AUTHOR_NAME="$NEW_NAME" GIT_AUTHOR_EMAIL="$NEW_EMAIL"
      export GIT_COMMITTER_NAME="$NEW_NAME" GIT_COMMITTER_EMAIL="$NEW_EMAIL"
    fi
  ' \
  --msg-filter '
    if grep -qxF "$GIT_COMMIT" "$RANGE_FILE"; then
      sed -E -e "/^🤖 Generated with \[Claude Code\]\(https:\/\/claude\.ai\/code\)/d" -e "/^Co-Authored-By: .* <.*>/d"
    else
      cat
    fi
  ' \
  -- "$RANGE_SPEC"

echo
echo "✅ Done. Preview:"
echo "    git log --format=fuller ${START_COMMIT}..HEAD"
echo
echo "👉 Push:"
echo "    git push --force-with-lease origin ${CUR_REF}"
