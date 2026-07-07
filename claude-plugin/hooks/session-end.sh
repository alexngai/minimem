#!/bin/bash
# minimem SessionEnd (Stop) hook
# Auto-summarizes the session by appending a note to today's daily log.
# Uses the transcript path to determine what was worked on.
#
# Opt-in: disabled unless hooks.sessionEnd is true in a minimem config.
# Enable with: minimem config --set hooks.sessionEnd=true [--global]

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

# Detect initialized memory directories.
# Contained layout: config.json + MEMORY.md at the memory root.
# Legacy layouts: .minimem/ or .swarm/minimem/ subdirectory.
HAS_LOCAL=""
HAS_GLOBAL=""
if { [ -f "config.json" ] && [ -f "MEMORY.md" ]; } || [ -d ".minimem" ] || [ -f ".swarm/minimem/config.json" ]; then
  HAS_LOCAL="1"
fi
if [ -d "$HOME/.minimem" ]; then
  HAS_GLOBAL="1"
fi

if [ -z "$HAS_LOCAL" ] && [ -z "$HAS_GLOBAL" ]; then
  exit 0
fi

# Check config to see if this hook is enabled (opt-in; defaults to false).
# Reads the same config locations as the CLI: contained (config.json at the
# memory root), then .swarm/minimem/, then legacy .minimem/. Local overrides global.
HOOK_ENABLED=$(node -e "
  const fs = require('fs');
  const path = require('path');
  const load = (dir) => {
    const candidates = [
      path.join(dir, 'config.json'),
      path.join(dir, '.swarm', 'minimem', 'config.json'),
      path.join(dir, '.minimem', 'config.json'),
    ];
    for (const p of candidates) {
      try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch {}
    }
    return null;
  };
  const configs = [load(path.join(process.env.HOME, '.minimem')), load('.')].filter(Boolean);
  // Last config wins (local overrides global)
  for (const c of configs.reverse()) {
    if (c.hooks && typeof c.hooks.sessionEnd === 'boolean') {
      console.log(c.hooks.sessionEnd ? 'true' : 'false');
      process.exit(0);
    }
  }
  console.log('false');
" 2>/dev/null) || echo "false"

if [ "$HOOK_ENABLED" != "true" ]; then
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
