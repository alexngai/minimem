#!/bin/bash
# minimem SessionEnd (Stop) hook
# Auto-summarizes the session by appending a note to today's daily log.
# Uses the transcript path to determine what was worked on.

set -euo pipefail

# Read hook input from stdin
INPUT=$(cat)

# Prevent infinite loops: if stop hook is already active, exit
STOP_ACTIVE=$(echo "$INPUT" | node -e "
  const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8'));
  console.log(d.stop_hook_active ? 'true' : 'false');
" 2>/dev/null) || echo "false"

if [ "$STOP_ACTIVE" = "true" ]; then
  exit 0
fi

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
    if (c.hooks && typeof c.hooks.sessionEnd === 'boolean') {
      console.log(c.hooks.sessionEnd ? 'true' : 'false');
      process.exit(0);
    }
  }
  console.log('false');
" 2>/dev/null) || echo "false"

if [ "$HOOK_ENABLED" = "false" ]; then
  exit 0
fi

# Extract session info from hook input
SESSION_ID=$(echo "$INPUT" | node -e "
  const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8'));
  console.log(d.session_id || 'unknown');
" 2>/dev/null) || echo "unknown"

CWD=$(echo "$INPUT" | node -e "
  const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8'));
  console.log(d.cwd || process.cwd());
" 2>/dev/null) || pwd

PROJECT_NAME=$(basename "$CWD")
TIMESTAMP=$(date +"%Y-%m-%d %H:%M")

# Build append args
APPEND_ARGS=("append")
if [ -n "$HAS_LOCAL" ]; then
  APPEND_ARGS+=("--dir" ".")
elif [ -n "$HAS_GLOBAL" ]; then
  APPEND_ARGS+=("--global")
fi

# Create a session end marker in memory
# The content is intentionally brief — Claude Code's transcript has the full details.
ENTRY="### ${TIMESTAMP} (session: ${SESSION_ID})
<!-- type: context -->
Session ended in project: ${PROJECT_NAME} (${CWD})"

npx --yes minimem "${APPEND_ARGS[@]}" "$ENTRY" 2>/dev/null || true

exit 0
