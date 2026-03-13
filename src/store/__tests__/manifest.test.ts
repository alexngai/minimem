import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  loadManifest,
  saveManifest,
  loadStoreLinks,
  saveStoreLinks,
  resolveStore,
  resolveStoreName,
  getLinkedStoreNames,
  type StoreManifest,
} from "../manifest.js";

describe("manifest", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "minimem-manifest-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe("loadManifest / saveManifest", () => {
    it("returns empty manifest when file does not exist", async () => {
      const manifest = await loadManifest(path.join(tmpDir, "nonexistent.json"));
      expect(manifest.stores).toEqual({});
    });

    it("round-trips a manifest", async () => {
      const manifestPath = path.join(tmpDir, "stores.json");
      const manifest: StoreManifest = {
        stores: {
          "project-a": { path: "/home/user/project-a" },
          "project-b": {
            path: "/home/user/project-b",
            remote: "git@github.com:org/project-b.git",
            description: "Project B memories",
          },
        },
      };

      await saveManifest(manifest, manifestPath);
      const loaded = await loadManifest(manifestPath);

      expect(loaded.stores["project-a"].path).toBe("/home/user/project-a");
      expect(loaded.stores["project-b"].remote).toBe("git@github.com:org/project-b.git");
      expect(loaded.stores["project-b"].description).toBe("Project B memories");
    });

    it("expands ~ in paths", async () => {
      const manifestPath = path.join(tmpDir, "stores.json");
      await fs.writeFile(
        manifestPath,
        JSON.stringify({ stores: { test: { path: "~/my-project" } } }),
      );

      const loaded = await loadManifest(manifestPath);
      expect(loaded.stores["test"].path).toBe(
        path.join(os.homedir(), "my-project"),
      );
    });
  });

  describe("loadStoreLinks / saveStoreLinks", () => {
    it("returns empty links when no file exists", async () => {
      const links = await loadStoreLinks(tmpDir);
      expect(links.links).toEqual([]);
    });

    it("loads links from .minimem/links.json", async () => {
      const linksDir = path.join(tmpDir, ".minimem");
      await fs.mkdir(linksDir, { recursive: true });
      await fs.writeFile(
        path.join(linksDir, "links.json"),
        JSON.stringify({ links: ["project-a", "project-b"] }),
      );

      const links = await loadStoreLinks(tmpDir);
      expect(links.links).toEqual(["project-a", "project-b"]);
    });

    it("saves links to existing config dir", async () => {
      const linksDir = path.join(tmpDir, ".minimem");
      await fs.mkdir(linksDir, { recursive: true });

      await saveStoreLinks(tmpDir, { links: ["store-x"] });

      const content = await fs.readFile(
        path.join(linksDir, "links.json"),
        "utf-8",
      );
      expect(JSON.parse(content).links).toEqual(["store-x"]);
    });
  });

  describe("resolveStore", () => {
    it("returns store definition by name", () => {
      const manifest: StoreManifest = {
        stores: { mystore: { path: "/tmp/mystore" } },
      };
      const def = resolveStore(manifest, "mystore");
      expect(def).not.toBeNull();
      expect(def!.path).toBe("/tmp/mystore");
    });

    it("returns null for unknown store", () => {
      const manifest: StoreManifest = { stores: {} };
      expect(resolveStore(manifest, "missing")).toBeNull();
    });
  });

  describe("resolveStoreName", () => {
    it("finds store name by path", () => {
      const manifest: StoreManifest = {
        stores: { mystore: { path: "/tmp/mystore" } },
      };
      expect(resolveStoreName(manifest, "/tmp/mystore")).toBe("mystore");
    });

    it("returns null for unregistered path", () => {
      const manifest: StoreManifest = { stores: {} };
      expect(resolveStoreName(manifest, "/tmp/unknown")).toBeNull();
    });
  });

  describe("getLinkedStoreNames", () => {
    it("returns linked store names from per-store links", async () => {
      // Create a store dir with links
      const storeDir = path.join(tmpDir, "my-store");
      const linksDir = path.join(storeDir, ".minimem");
      await fs.mkdir(linksDir, { recursive: true });
      await fs.writeFile(
        path.join(linksDir, "links.json"),
        JSON.stringify({ links: ["dep-a", "dep-b"] }),
      );

      const manifest: StoreManifest = {
        stores: {
          "my-store": { path: storeDir },
          "dep-a": { path: "/tmp/dep-a" },
          "dep-b": { path: "/tmp/dep-b" },
        },
      };

      const linked = await getLinkedStoreNames(manifest, "my-store");
      expect(linked).toEqual(["dep-a", "dep-b"]);
    });

    it("returns empty for store not in manifest", async () => {
      const manifest: StoreManifest = { stores: {} };
      const linked = await getLinkedStoreNames(manifest, "missing");
      expect(linked).toEqual([]);
    });

    it("deduplicates linked stores", async () => {
      const storeDir = path.join(tmpDir, "my-store");
      const linksDir = path.join(storeDir, ".minimem");
      await fs.mkdir(linksDir, { recursive: true });
      await fs.writeFile(
        path.join(linksDir, "links.json"),
        JSON.stringify({ links: ["dep-a", "dep-a", "dep-b"] }),
      );

      const manifest: StoreManifest = {
        stores: { "my-store": { path: storeDir } },
      };

      const linked = await getLinkedStoreNames(manifest, "my-store");
      expect(linked).toEqual(["dep-a", "dep-b"]);
    });
  });
});
