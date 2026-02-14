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
3. Infer the observation type from context:
   - Architectural/design choices → `decision`
   - Bug fixes, root causes → `bugfix`
   - New feature details → `feature`
   - Learned facts, TILs → `discovery`
   - Setup notes, environment → `context`
   - Everything else → `note`
4. Format the entry with a timestamp and type:
   ```markdown
   ### YYYY-MM-DD HH:MM
   <!-- type: decision -->
   <content>
   ```
5. If content contains sensitive data (keys, passwords), wrap those parts in `<private>` tags
6. Use the Write or Edit tool to update the content as a regular Markdown file
7. Confirm what was stored and where

## Response Format

After storing, confirm:
- What was remembered
- Which file it was stored in
- The observation type assigned
- How to find it later (suggest search terms and type filter)

Example: "I've stored your architecture decision in today's log (memory/2026-02-14.md) with type 'decision'. Search with `memory_search(query: 'rate limit', type: 'decision')` to find it later."
