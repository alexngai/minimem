/**
 * Tests for session tracking module
 */

import { describe, it, expect } from "vitest";
import {
  parseFrontmatter,
  serializeFrontmatter,
  addFrontmatter,
  addSessionToContent,
  extractSession,
} from "../session.js";

describe("Session Module", () => {
  describe("parseFrontmatter", () => {
    it("parses simple frontmatter", () => {
      const content = `---
created: 2024-01-27T14:30:00Z
tags: [test, memory]
---
# Content

This is the body.`;

      const { frontmatter, body } = parseFrontmatter(content);

      expect(frontmatter?.created).toBe("2024-01-27T14:30:00Z");
      expect(body.startsWith("# Content")).toBe(true);
    });

    it("parses nested session frontmatter", () => {
      const content = `---
session:
  id: abc123
  source: claude-code
  project: /path/to/project
created: 2024-01-27T14:30:00Z
---
# Content`;

      const { frontmatter, body } = parseFrontmatter(content);

      expect(frontmatter?.session?.id).toBe("abc123");
      expect(frontmatter?.session?.source).toBe("claude-code");
      expect(frontmatter?.session?.project).toBe("/path/to/project");
      expect(body.startsWith("# Content")).toBe(true);
    });

    it("returns undefined frontmatter for content without frontmatter", () => {
      const content = `# No Frontmatter

This content has no frontmatter.`;

      const { frontmatter, body } = parseFrontmatter(content);

      expect(frontmatter).toBeUndefined();
      expect(body).toBe(content);
    });

    it("handles content that starts with --- but is not frontmatter", () => {
      const content = `---
This is just a horizontal rule, not frontmatter
because it doesn't have a closing ---
# Content`;

      const { frontmatter, body } = parseFrontmatter(content);

      // Should fail to parse as frontmatter
      expect(frontmatter).toBeUndefined();
      expect(body).toBe(content);
    });
  });

  describe("serializeFrontmatter", () => {
    it("serializes simple frontmatter", () => {
      const result = serializeFrontmatter({
        created: "2024-01-27T14:30:00Z",
        tags: ["test", "memory"],
      });

      expect(result.includes("---\n")).toBe(true);
      expect(result.includes("created: 2024-01-27T14:30:00Z")).toBe(true);
      expect(result.includes("tags: [test, memory]")).toBe(true);
      expect(result.endsWith("---\n")).toBe(true);
    });

    it("serializes session context", () => {
      const result = serializeFrontmatter({
        session: {
          id: "test-123",
          source: "claude-code",
          project: "/path/to/project",
        },
      });

      expect(result.includes("session:")).toBe(true);
      expect(result.includes("  id: test-123")).toBe(true);
      expect(result.includes("  source: claude-code")).toBe(true);
    });
  });

  describe("addFrontmatter", () => {
    it("adds frontmatter to content without existing frontmatter", () => {
      const content = "# My Note\n\nSome content.";
      const result = addFrontmatter(content, {
        session: { id: "test-123", source: "claude-code" },
      });

      expect(result.startsWith("---\n")).toBe(true);
      expect(result.includes("session:")).toBe(true);
      expect(result.includes("  id: test-123")).toBe(true);
      expect(result.includes("created:")).toBe(true);
      expect(result.includes("updated:")).toBe(true);
      expect(result.includes("# My Note")).toBe(true);
    });

    it("merges with existing frontmatter", () => {
      const content = `---
created: 2024-01-01T00:00:00Z
tags: [old]
---
# Content`;

      const result = addFrontmatter(content, {
        session: { id: "new-session" },
        tags: ["new"],
      });

      expect(result.includes("session:")).toBe(true);
      expect(result.includes("  id: new-session")).toBe(true);
      // Created should be preserved
      expect(result.includes("created: 2024-01-01T00:00:00Z")).toBe(true);
      // Updated should be new
      expect(result.includes("updated:")).toBe(true);
      // Tags should be merged (new overrides old)
      expect(result.includes("tags: [new]")).toBe(true);
    });
  });

  describe("addSessionToContent", () => {
    it("adds session to content", () => {
      const content = "# Note";
      const session = {
        id: "session-456",
        source: "vscode",
      };

      const result = addSessionToContent(content, session);

      expect(result.includes("---\n")).toBe(true);
      expect(result.includes("  id: session-456")).toBe(true);
      expect(result.includes("  source: vscode")).toBe(true);
      expect(result.includes("# Note")).toBe(true);
    });
  });

  describe("extractSession", () => {
    it("extracts session from content with frontmatter", () => {
      const content = `---
session:
  id: extracted-123
  source: test-source
created: 2024-01-27
---
# Content`;

      const session = extractSession(content);

      expect(session?.id).toBe("extracted-123");
      expect(session?.source).toBe("test-source");
    });

    it("returns undefined for content without session", () => {
      const content = "# No frontmatter";
      const session = extractSession(content);
      expect(session).toBeUndefined();
    });

    it("returns undefined for frontmatter without session", () => {
      const content = `---
created: 2024-01-27
tags: [test]
---
# Content`;

      const session = extractSession(content);
      expect(session).toBeUndefined();
    });
  });
});
