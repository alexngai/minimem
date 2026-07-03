#!/bin/bash
# minimem SessionStart hook
# Injects recent relevant memories into the session context.
# Runs on session startup and resume.
#
# Opt-in: disabled unless hooks.sessionStart is true in a minimem config.
# Enable with: minimem config --set hooks.sessionStart=true [--global]

set -euo pipefail

# Read hook input from stdin
INPUT=$(cat)

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
    if (c.hooks && typeof c.hooks.sessionStart === 'boolean') {
      console.log(c.hooks.sessionStart ? 'true' : 'false');
      process.exit(0);
    }
  }
  console.log('false');
" 2>/dev/null) || echo "false"

if [ "$HOOK_ENABLED" != "true" ]; then
  exit 0
fi

# Build search args
SEARCH_ARGS=("search" "recent context session" "--max" "5" "--json")
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
