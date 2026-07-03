/**
 * Minimal interactive prompt helpers for the CLI.
 *
 * All helpers degrade safely in non-interactive contexts (no TTY, piped
 * stdin, or CI): callers should check {@link isInteractive} first and fall
 * back to sensible defaults rather than blocking on input.
 */

import * as readline from "node:readline";

/**
 * True when we can safely prompt the user: stdin and stdout are both TTYs
 * and we're not running under a CI environment.
 */
export function isInteractive(): boolean {
  if (process.env.CI) return false;
  if (process.env.MINIMEM_NONINTERACTIVE) return false;
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/**
 * Ask a free-form question and return the trimmed answer.
 */
export function promptText(query: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise<string>((resolve) => {
    rl.question(query, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Ask for a secret (e.g. an API key), muting terminal echo while typing.
 */
export function promptSecret(query: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const iface = rl as unknown as {
    _writeToOutput: (str: string) => void;
    output: NodeJS.WritableStream;
  };

  let muted = false;
  const originalWrite = iface._writeToOutput.bind(iface);
  iface._writeToOutput = (str: string) => {
    if (muted) return; // suppress echo of the typed secret
    originalWrite(str);
  };

  return new Promise<string>((resolve) => {
    rl.question(query, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer.trim());
    });
    muted = true;
  });
}

export type SelectOption = {
  /** Short label shown in the numbered list */
  label: string;
  /** Optional dimmed hint shown after the label */
  hint?: string;
};

/**
 * Present a numbered menu and return the chosen zero-based index.
 * Re-prompts on invalid input. `defaultIndex` is used when the user presses
 * Enter with no input.
 */
export async function promptSelect(
  title: string,
  options: SelectOption[],
  defaultIndex = 0,
): Promise<number> {
  console.log(title);
  options.forEach((opt, i) => {
    const marker = i === defaultIndex ? ">" : " ";
    const hint = opt.hint ? `  (${opt.hint})` : "";
    console.log(`  ${marker} ${i + 1}. ${opt.label}${hint}`);
  });

  for (;;) {
    const answer = await promptText(
      `Choose [1-${options.length}] (default ${defaultIndex + 1}): `,
    );
    if (answer === "") return defaultIndex;
    const n = Number.parseInt(answer, 10);
    if (Number.isInteger(n) && n >= 1 && n <= options.length) {
      return n - 1;
    }
    console.log(`Please enter a number between 1 and ${options.length}.`);
  }
}

/**
 * Yes/no confirmation. Returns `defaultValue` on empty input.
 */
export async function promptConfirm(
  query: string,
  defaultValue = true,
): Promise<boolean> {
  const suffix = defaultValue ? "[Y/n]" : "[y/N]";
  const answer = (await promptText(`${query} ${suffix} `)).toLowerCase();
  if (answer === "") return defaultValue;
  return answer === "y" || answer === "yes";
}
