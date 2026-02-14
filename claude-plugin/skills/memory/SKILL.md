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

## Available MCP Tools

### memory_search (two-phase search)

```
memory_search(query, maxResults?, minScore?, directories?, detail?, type?)
```

- `query`: Natural language search query
- `maxResults`: Maximum results (default: 10)
- `minScore`: Minimum relevance 0-1 (default: 0.3)
- `directories`: Filter to specific memory directories
- `detail`: `"compact"` (default) for lightweight index, `"full"` for complete snippets
- `type`: Filter by observation type (decision, bugfix, feature, discovery, context, note)

### memory_get_details

```
memory_get_details(results, directories?)
```

- `results`: Array of `{ path, startLine, endLine }` from compact search results
- `directories`: Filter to specific memory directories

## Searching Memories (Two-Phase Workflow)

When the user wants to recall information:

1. Use `memory_search` with a descriptive query (defaults to compact results)
2. Review the compact index — each result shows path, score, and short preview
3. Use `memory_get_details` to fetch full text for the most relevant results
4. Synthesize and present the information, citing source files

This two-phase approach saves tokens by only fetching details for results that matter.

For quick lookups where you need all details immediately, use `detail: "full"`.

### Filtering by Type

Use the `type` parameter to narrow results:
- `memory_search(query: "API design", type: "decision")` — only decisions
- `memory_search(query: "login bug", type: "bugfix")` — only bug fixes

## Storing Memories

To store new information, use filesystem tools to write to memory files:

1. **Quick notes** → Append to `memory/YYYY-MM-DD.md` (today's date)
2. **Decisions** → Add to `MEMORY.md` under appropriate heading
3. **Topic-specific** → Create/update `memory/<topic>.md`

### Storage Format

```markdown
### YYYY-MM-DD HH:MM
<!-- type: decision -->
<content to remember>
```

### Observation Types

Add a type comment to categorize entries for filtered search:

- `<!-- type: decision -->` — architectural or design decisions
- `<!-- type: bugfix -->` — bug fixes and root causes
- `<!-- type: feature -->` — new feature implementations
- `<!-- type: discovery -->` — learned facts, insights
- `<!-- type: context -->` — project context, setup notes
- `<!-- type: note -->` — general notes (default)

### Privacy

Wrap sensitive content in `<private>` tags to exclude it from search indexing:

```markdown
API endpoint: api.example.com/v2

<private>
API_KEY=sk-abc123
DB_PASSWORD=hunter2
</private>
```

## Best Practices

1. Use specific, searchable terms when storing
2. Include context: dates, people, project names
3. Add type comments for important entries (decisions, bugfixes)
4. Use `<private>` tags for credentials and secrets
5. Start with compact search, then fetch details as needed
6. When searching, try multiple query variations if needed
