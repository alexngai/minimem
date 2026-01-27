---
description: Store information in memory for later recall
---

# Remember Command

Store the following information in memory: "$ARGUMENTS"

## Instructions

1. Parse what the user wants to remember from the arguments
2. Determine the appropriate file:
   - General notes → `memory/YYYY-MM-DD.md` (today's date)
   - Important decisions → `MEMORY.md`
   - Topic-specific → `memory/<topic>.md`
3. Format the entry with a timestamp:
   ```markdown
   ### YYYY-MM-DD HH:MM
   <content>
   ```
4. Use the Write or Edit tool to update the content as a regular Markdown file
5. Confirm what was stored and where

## Response Format

After storing, confirm:
- What was remembered
- Which file it was stored in
- How to find it later (suggest search terms)

Example: "I've stored your note about the API rate limit in today's log (memory/2024-01-15.md). Search for 'rate limit' or 'API' to find it later."
