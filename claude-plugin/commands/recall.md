---
description: Search memories for relevant information
---

# Recall Command

Search for memories matching: "$ARGUMENTS"

## Instructions

1. Use the `memory_search` MCP tool with the user's query
2. If results are found:
   - Present the top results with scores and sources
   - Summarize the key information
   - Offer to show more details if needed
3. If no results:
   - Suggest alternative search terms
   - Offer to help store relevant information

## Response Format

**When results found:**

Show results clearly with:
- Relevance score (percentage)
- Source file and line numbers
- The relevant snippet
- A brief summary synthesizing the findings

**When no results:**

"I couldn't find memories matching '[query]'. Try:
- [alternative search term 1]
- [alternative search term 2]

Use `/minimem:remember` to store information for later."

## Tips

- If the query is vague, ask for clarification
- Try broader terms if initial search returns few results
- Mention the source files so the user can read more context
