#!/bin/bash
# minimem SessionStart hook
# Injects recent relevant memories into the session context.
# Runs on session startup and resume.

set -euo pipefail

# Read hook input from stdin
INPUT=$(cat)

# Only proceed if minimem is initialized (local or global)
HAS_LOCAL=""
HAS_GLOBAL=""
if [ -d ".minimem" ]; then
  HAS_LOCAL="1"
fi
if [ -d "$HOME/.minimem" ]; then
  HAS_GLOBAL="1"
fi

if [ -z "$HAS_LOCAL" ] && [ -z "$HAS_GLOBAL" ]; then
  exit 0
fi

# Check config to see if this hook is enabled (defaults to true)
HOOK_ENABLED=$(node -e "
  const fs = require('fs');
  const path = require('path');
  const configs = [];
  try { configs.push(JSON.parse(fs.readFileSync(path.join(process.env.HOME, '.minimem', '.minimem', 'config.json'), 'utf-8'))); } catch {}
  try { configs.push(JSON.parse(fs.readFileSync('.minimem/config.json', 'utf-8'))); } catch {}
  // Last config wins (local overrides global)
  for (const c of configs.reverse()) {
    if (c.hooks && typeof c.hooks.sessionStart === 'boolean') {
      console.log(c.hooks.sessionStart ? 'true' : 'false');
      process.exit(0);
    }
  }
  console.log('false');
" 2>/dev/null) || echo "false"

if [ "$HOOK_ENABLED" = "false" ]; then
  exit 0
fi

# Build search args
SEARCH_ARGS=("search" "recent context session" "--max-results" "5" "--json")
if [ -n "$HAS_LOCAL" ]; then
  SEARCH_ARGS+=("--dir" ".")
fi
if [ -n "$HAS_GLOBAL" ]; then
  SEARCH_ARGS+=("--global")
fi

# Run search (suppress errors — don't block session start)
RESULTS=$(npx --yes minimem "${SEARCH_ARGS[@]}" 2>/dev/null) || true

if [ -z "$RESULTS" ] || [ "$RESULTS" = "[]" ] || [ "$RESULTS" = "null" ]; then
  exit 0
fi

# Format as context for Claude
CONTEXT="## Recent Memory Context (from minimem)\n\n"
CONTEXT+=$(echo "$RESULTS" | node -e "
  const data = JSON.parse(require('fs').readFileSync('/dev/stdin', 'utf-8'));
  if (!Array.isArray(data) || data.length === 0) process.exit(0);
  data.slice(0, 5).forEach((r, i) => {
    const loc = r.path + ':' + r.startLine + '-' + r.endLine;
    const score = (r.score * 100).toFixed(0);
    const preview = r.snippet.split('\n')[0].slice(0, 80);
    console.log('[' + i + '] ' + loc + ' (' + score + '%) — ' + preview);
  });
" 2>/dev/null) || true

if [ -z "$CONTEXT" ]; then
  exit 0
fi

# Output as JSON with additionalContext for Claude to see
echo "{\"additionalContext\": $(echo -e "$CONTEXT" | node -e "
  const text = require('fs').readFileSync('/dev/stdin', 'utf-8');
  process.stdout.write(JSON.stringify(text));
" 2>/dev/null)}"

exit 0
