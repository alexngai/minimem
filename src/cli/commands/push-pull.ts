/**
 * minimem push/pull - Sync commands
 */

import {
  resolveMemoryDir,
  isInitialized,
  formatPath,
} from "../config.js";
import { push, pull, bidirectionalSync } from "../sync/operations.js";
import { detectConflicts } from "../sync/conflicts.js";

export type PushPullOptions = {
  dir?: string;
  global?: boolean;
  force?: boolean;
  dryRun?: boolean;
};

/**
 * Push local changes to central repository
 */
export async function pushCommand(options: PushPullOptions): Promise<void> {
  const memoryDir = resolveMemoryDir({
    dir: options.dir,
    global: options.global,
  });

  if (!(await isInitialized(memoryDir))) {
    console.error(`Error: ${formatPath(memoryDir)} is not initialized.`);
    process.exit(1);
  }

  console.log(`Pushing from ${formatPath(memoryDir)}...`);

  if (options.dryRun) {
    console.log("(dry run - no changes will be made)");
  }

  try {
    const result = await push(memoryDir, {
      force: options.force,
      dryRun: options.dryRun,
    });

    if (result.pushed.length > 0) {
      console.log(`\nPushed ${result.pushed.length} file(s):`);
      for (const file of result.pushed) {
        console.log(`  + ${file}`);
      }
    }

    if (result.skipped.length > 0) {
      console.log(`\nSkipped ${result.skipped.length} file(s) (no local changes)`);
    }

    if (result.conflicts.length > 0) {
      console.log(`\nConflicts (${result.conflicts.length}):`);
      for (const file of result.conflicts) {
        console.log(`  ! ${file}`);
      }
      console.log("\nResolve conflicts or use --force to overwrite");
    }

    if (result.errors.length > 0) {
      console.error(`\nErrors:`);
      for (const error of result.errors) {
        console.error(`  ${error}`);
      }
    }

    if (!result.success) {
      process.exit(1);
    }

    if (result.pushed.length === 0 && result.conflicts.length === 0) {
      console.log("Nothing to push - already in sync");
    }
  } catch (error) {
    console.error(`Error: ${error}`);
    process.exit(1);
  }
}

/**
 * Pull changes from central repository
 */
export async function pullCommand(options: PushPullOptions): Promise<void> {
  const memoryDir = resolveMemoryDir({
    dir: options.dir,
    global: options.global,
  });

  if (!(await isInitialized(memoryDir))) {
    console.error(`Error: ${formatPath(memoryDir)} is not initialized.`);
    process.exit(1);
  }

  console.log(`Pulling to ${formatPath(memoryDir)}...`);

  if (options.dryRun) {
    console.log("(dry run - no changes will be made)");
  }

  try {
    const result = await pull(memoryDir, {
      force: options.force,
      dryRun: options.dryRun,
    });

    if (result.pulled.length > 0) {
      console.log(`\nPulled ${result.pulled.length} file(s):`);
      for (const file of result.pulled) {
        console.log(`  + ${file}`);
      }
    }

    if (result.skipped.length > 0) {
      console.log(`\nSkipped ${result.skipped.length} file(s) (no remote changes)`);
    }

    if (result.conflicts.length > 0) {
      console.log(`\nConflicts (${result.conflicts.length}):`);
      for (const file of result.conflicts) {
        console.log(`  ! ${file}`);
      }
      console.log("\nResolve conflicts or use --force to overwrite");
    }

    if (result.errors.length > 0) {
      console.error(`\nErrors:`);
      for (const error of result.errors) {
        console.error(`  ${error}`);
      }
    }

    if (!result.success) {
      process.exit(1);
    }

    if (result.pulled.length === 0 && result.conflicts.length === 0) {
      console.log("Nothing to pull - already in sync");
    }
  } catch (error) {
    console.error(`Error: ${error}`);
    process.exit(1);
  }
}

/**
 * Show sync status
 */
export async function syncStatusCommand(options: { dir?: string; global?: boolean }): Promise<void> {
  const memoryDir = resolveMemoryDir({
    dir: options.dir,
    global: options.global,
  });

  if (!(await isInitialized(memoryDir))) {
    console.error(`Error: ${formatPath(memoryDir)} is not initialized.`);
    process.exit(1);
  }

  try {
    const detection = await detectConflicts(memoryDir);
    const { summary } = detection;

    console.log(`Sync status for ${formatPath(memoryDir)}`);
    console.log("-".repeat(50));

    if (summary.unchanged > 0) {
      console.log(`  Unchanged:      ${summary.unchanged}`);
    }
    if (summary.localOnly > 0) {
      console.log(`  Local changes:  ${summary.localOnly} (push to sync)`);
    }
    if (summary.remoteOnly > 0) {
      console.log(`  Remote changes: ${summary.remoteOnly} (pull to sync)`);
    }
    if (summary.newLocal > 0) {
      console.log(`  New local:      ${summary.newLocal}`);
    }
    if (summary.newRemote > 0) {
      console.log(`  New remote:     ${summary.newRemote}`);
    }
    if (summary.deletedLocal > 0) {
      console.log(`  Deleted local:  ${summary.deletedLocal}`);
    }
    if (summary.deletedRemote > 0) {
      console.log(`  Deleted remote: ${summary.deletedRemote}`);
    }
    if (summary.conflicts > 0) {
      console.log(`  CONFLICTS:      ${summary.conflicts}`);
    }

    const totalChanges =
      summary.localOnly +
      summary.remoteOnly +
      summary.newLocal +
      summary.newRemote +
      summary.conflicts;

    if (totalChanges === 0) {
      console.log("\n  All files in sync!");
    } else {
      console.log(`\n  Total changes: ${totalChanges}`);
      if (summary.conflicts > 0) {
        console.log("  Run 'minimem push --force' or 'minimem pull --force' to resolve");
      }
    }
  } catch (error) {
    console.error(`Error: ${error}`);
    process.exit(1);
  }
}
