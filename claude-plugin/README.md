# minimem Claude Code Plugin

A Claude Code plugin that provides memory capabilities via the minimem semantic search system.

## Features

- **MCP Server**: Provides `memory_search` tool for semantic search across memories
- **Memory Skill**: Automatically invoked when storing or recalling information
- **Commands**:
  - `/minimem:remember <text>` - Store information for later
  - `/minimem:recall <query>` - Search for stored memories

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

### Direct MCP Tool

The `memory_search` tool is available for direct use:

```
memory_search("api design decisions", maxResults=5)
```

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
