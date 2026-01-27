# /minimem:extract

Extract a skill from the current session using the Claudeception skill extraction system.

## Usage

```
/minimem:extract [name]
```

## Arguments

- `name` (optional): The kebab-case name for the skill (e.g., "typescript-import-fix")

## Behavior

When invoked, analyze the current session for extractable knowledge:

1. **Review recent work** for non-obvious solutions, debugging discoveries, or workarounds
2. **Identify candidates** that meet the quality criteria (reusable, non-trivial, verified)
3. **Create skill(s)** using the minimem CLI for the most valuable discoveries
4. **Report** what was extracted and why

If no `name` is provided, suggest appropriate names based on the extracted knowledge.

## Quality Criteria

Only extract knowledge that:
- Will help with future tasks (not just this one instance)
- Required actual discovery (not just documentation lookup)
- Has clear trigger conditions (specific errors, symptoms, contexts)
- Has been verified to work

## Example

After debugging a complex TypeScript configuration issue:

```
/minimem:extract
```

Output:
```
Analyzing session for extractable knowledge...

Identified 1 skill candidate:
- typescript-path-mapping-resolution: Fix for module resolution failures
  when using path mapping with ts-node

Extracting skill...

Skill 'typescript-path-mapping-resolution' created successfully.
Path: skills/typescript-path-mapping-resolution/SKILL.md

The skill captures the discovery that ts-node requires tsconfig-paths
registration for path aliases to work, which wasn't obvious from the
error message "Cannot find module '@/utils'".
```
