---
name: memory
description: Search and manage memories using minimem. Use when the user wants to recall previous context, decisions, notes, or stored information. Also use when storing new information for later retrieval.
---

# Memory Skill

Use the minimem memory system to store and retrieve persistent context.

## When to Use This Skill

- User asks to "remember" or "store" something
- User asks to "recall", "find", or "search for" previous context
- User references past decisions, notes, or information
- You need to persist information across sessions
- User mentions "memory" or "memories"

## Available MCP Tool

The `memory_search` tool is available via MCP:

```
memory_search(query, maxResults?, minScore?, directories?)
```

- `query`: Natural language search query
- `maxResults`: Maximum results (default: 10)
- `minScore`: Minimum relevance 0-1 (default: 0.3)
- `directories`: Filter to specific memory directories

## Searching Memories

When the user wants to recall information:

1. Use `memory_search` with a descriptive natural language query
2. Review the results and their relevance scores
3. Synthesize and present the most relevant information
4. Cite the source files when helpful

Example queries:
- "database architecture decisions"
- "meeting notes API design"
- "project requirements authentication"

## Storing Memories

To store new information, use filesystem tools to write to memory files:

1. **Quick notes** → Append to `memory/YYYY-MM-DD.md` (today's date)
2. **Decisions** → Add to `MEMORY.md` under appropriate heading
3. **Topic-specific** → Create/update `memory/<topic>.md`

### Storage Format

```markdown
### [YYYY-MM-DD HH:MM]
<content to remember>
```

## Best Practices

1. Use specific, searchable terms when storing
2. Include context: dates, people, project names
3. Organize with markdown headings
4. Keep individual entries concise
5. When searching, try multiple query variations if needed
