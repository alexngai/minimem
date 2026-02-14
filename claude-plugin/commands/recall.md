---
description: Search memories for relevant information
---

# Recall Command

Search for memories matching: "$ARGUMENTS"

## Instructions

1. Use `memory_search` MCP tool with the user's query (compact mode by default)
2. If results are found:
   - Show the compact index (path, score, preview)
   - Use `memory_get_details` to fetch full text for the top 2-3 most relevant results
   - Summarize the key information
   - Offer to fetch more details if needed
3. If no results:
   - Suggest alternative search terms
   - Try filtering by type if the query implies a category (e.g., "decisions" → type: "decision")
   - Offer to help store relevant information

## Response Format

**When results found:**

Show results clearly with:
- Relevance score (percentage)
- Source file and line numbers
- Full text of the top results (fetched via memory_get_details)
- A brief summary synthesizing the findings

**When no results:**

"I couldn't find memories matching '[query]'. Try:
- [alternative search term 1]
- [alternative search term 2]
- Filtering by type: `decision`, `bugfix`, `feature`, `discovery`

Use `/minimem:remember` to store information for later."

## Tips

- Use the two-phase workflow: compact search first, then fetch details
- If the query mentions decisions, bugs, or features, add the `type` filter
- If the query is vague, ask for clarification
- Try broader terms if initial search returns few results
- Mention the source files so the user can read more context
