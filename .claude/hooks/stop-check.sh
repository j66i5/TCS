#!/usr/bin/env bash
# Stop hook (SPEC 5.9): a session may not end with a failing typecheck or failing tests.
# Exit code 2 blocks the stop and feeds stderr back to Claude.
#
# Escape hatch for checks that cannot pass for reasons outside the code (e.g. no network for npm ci):
# create .claude/allow-red-stop containing the reason. The hook allows ONE stop, deletes the file, and
# the reason must be reported to the owner.
cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}" || exit 0

if [ -f .claude/allow-red-stop ]; then
  echo "Stop allowed despite checks (reason: $(cat .claude/allow-red-stop)). Report this to the owner." >&2
  rm -f .claude/allow-red-stop
  exit 0
fi

if [ ! -d node_modules ]; then
  npm ci --silent >/dev/null 2>&1 || { echo "npm ci failed; cannot run checks. Fix the install or use the escape hatch in .claude/hooks/stop-check.sh." >&2; exit 2; }
fi

out=$(npm run typecheck --silent 2>&1) || { echo "TYPECHECK FAILS - fix before ending the session:" >&2; echo "$out" | grep -v '^ok ' | tail -40 >&2; exit 2; }
# Timing tests run on their own, after the others (as in CI): sharing the cores makes them fail at random.
out=$(npm test --silent 2>&1 && npm run test:perf --silent 2>&1) || { echo "TESTS FAIL - fix before ending the session:" >&2; echo "$out" | tail -60 >&2; exit 2; }
exit 0
