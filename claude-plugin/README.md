# minimem Claude Code Plugin

A Claude Code plugin that provides memory capabilities via the minimem semantic search system.

## Features

- **MCP Server**: `memory_search` and `memory_get_details` for two-phase semantic
  search, plus `knowledge_search`, `knowledge_graph`, and `knowledge_path` for
  knowledge-formatted notes
- **Memory Skill**: Automatically invoked when storing or recalling information
- **Commands**:
  - `/minimem:remember <text>` - Store information for later
  - `/minimem:recall <query>` - Search for stored memories
- **Session Hooks** (opt-in): inject recent memories at session start and log a
  session marker at session end — see [Session Hooks](#session-hooks)

## Installation

### Prerequisites

1. Install minimem globally:
   ```bash
   npm install -g minimem
   ```

2. Initialize your global memory directory:
   ```bash
   minimem init --global
   ```

3. Set your embedding API key:
   ```bash
   export OPENAI_API_KEY=your-key
   # or
   export GOOGLE_API_KEY=your-key
   ```

### Install the Plugin

#### Option 1: Test locally during development

```bash
claude --plugin-dir /path/to/minimem/claude-plugin
```

#### Option 2: Install from a marketplace

If this plugin is published to a marketplace:

```
/plugin install minimem
```

## Usage

### Automatic Memory Skill

The memory skill is automatically invoked when you:
- Ask Claude to "remember" something
- Ask Claude to "recall" or "find" previous context
- Reference past decisions or notes

### Manual Commands

```
# Store a memory
/minimem:remember We decided to use PostgreSQL for the database

# Search memories
/minimem:recall database decisions
```

### Direct MCP Tools

The `memory_search` tool is available for direct use:

```
memory_search("api design decisions", maxResults=5)
```

For token-efficient recall, use the two-phase flow: `memory_search` with the
default compact detail level, then `memory_get_details` for the results that
matter.

### Session Hooks

Two hooks ship with the plugin, **disabled by default**:

- **SessionStart**: searches your memories for recent context and injects the
  top matches into the session
- **Stop**: appends a brief session-end marker to today's daily log

Enable them per-directory or globally via minimem config:

```bash
minimem config --global --set hooks.sessionStart=true
minimem config --global --set hooks.sessionEnd=true
```

(Or set `"hooks": { "sessionStart": true, "sessionEnd": true }` in the memory
directory's `config.json`.)

## Configuration

### Default Behavior

By default, the plugin searches both:
- **Current directory** (`.`) - Project-specific memories
- **Global** (`~/.minimem`) - Shared memories across all projects

This means project context is available when working in a project, and global memories are always accessible.

### Custom Memory Locations

To use only specific directories, modify `.mcp.json`:

```json
{
  "minimem": {
    "command": "npx",
    "args": ["minimem", "mcp", "--dir", "/path/to/work", "--dir", "/path/to/personal"]
  }
}
```

### Global Only

To use only the global memory directory:

```json
{
  "minimem": {
    "command": "npx",
    "args": ["minimem", "mcp", "--global"]
  }
}
```

## Plugin Structure

```
claude-plugin/
├── .claude-plugin/
│   └── plugin.json      # Plugin manifest
├── .mcp.json            # MCP server definition
├── skills/
│   └── memory/
│       └── SKILL.md     # Memory skill (auto-invoked)
├── commands/
│   ├── remember.md      # /minimem:remember command
│   └── recall.md        # /minimem:recall command
├── hooks/
│   ├── hooks.json       # Hook registration (SessionStart, Stop)
│   ├── session-start.sh # Inject recent memories (opt-in)
│   └── session-end.sh   # Append session marker (opt-in)
└── README.md            # This file
```

## Troubleshooting

### "minimem command not found"

Ensure minimem is installed globally:
```bash
npm install -g minimem
```

### "No API key found"

Set your embedding provider API key:
```bash
export OPENAI_API_KEY=sk-...
# or
export GOOGLE_API_KEY=...
```

### "Memory directory not initialized"

Initialize the memory directory:
```bash
minimem init --global
# or
minimem init /path/to/directory
```

## License

MIT
