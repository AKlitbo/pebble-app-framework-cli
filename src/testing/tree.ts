/**
 * Helpers the specs share: a folder of files in the temp folder, a runner that answers from a
 * script instead of starting a process, and the files of a unit that is already current.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { onTestFinished } from 'vitest';
import { mirrorOf } from '../framework/mirror.ts';
import type { Context } from '../shared/context.ts';
import type { RunOptions, RunResult, Runner } from '../shared/runner.ts';

/**
 * Writes files into a fresh temp folder, which is removed once the spec that made it has run.
 *
 * @param files Each file's path, with forward slashes, and its contents.
 * @return The folder.
 */
export function makeTree(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paf-spec-'));

  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));

  for (const [file, text] of Object.entries(files)) {
    const full = path.join(root, ...file.split('/'));

    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  }

  return root;
}

/** One call a fake runner saw. */
export type Call = {
  command: string;
  args: string[];
  options: RunOptions;
};

/**
 * A runner that records every call and answers from a function, so nothing real runs.
 *
 * @param answer Picks the result for a call. Anything it leaves undefined passes with no output.
 * @return The runner and the calls it saw.
 */
export function fakeRunner(answer: (command: string, args: string[]) => Partial<RunResult> | undefined = () => undefined): { run: Runner; calls: Call[] } {
  const calls: Call[] = [];
  const run: Runner = (command, args, options) => {
    calls.push({ command, args, options });

    return { code: 0, stdout: '', stderr: '', ...answer(command, args) };
  };

  return { run, calls };
}

/**
 * A command context over a folder, with a fake runner and printed lines kept.
 *
 * @param root The repo root.
 * @param run The runner.
 * @return The context and the lines it printed.
 */
export function makeContext(root: string, run: Runner): { ctx: Context; printed: string[] } {
  const printed: string[] = [];
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'paf-cache-'));

  onTestFinished(() => fs.rmSync(cache, { recursive: true, force: true }));

  const ctx: Context = { root, cache, repo: 'framework', platform: 'linux', run, print: (line) => printed.push(line) };

  // a mirror only has to look present for resolveRef to ask the runner
  fs.mkdirSync(mirrorOf(ctx), { recursive: true });
  fs.writeFileSync(path.join(mirrorOf(ctx), 'HEAD'), 'ref: refs/heads/main\n');

  return { ctx, printed };
}

/** The commit the specs' framework tags point at. */
export const COMMIT = 'a'.repeat(40);

/**
 * A unit pinned to v4.1.0 whose framework copy and node_modules are both current, so readying it runs
 * nothing. The command specs share it, so a change to what a current unit holds is made once.
 *
 * @param name The unit's folder under watchfaces/.
 * @param tag The tag it is pinned to and filled from.
 * @return Its files, for makeTree.
 */
export function currentUnit(name: string, tag = 'v4.1.0'): Record<string, string> {
  return {
    [`watchfaces/${name}/paf.config.json`]: JSON.stringify({ framework: tag, commit: COMMIT }),
    [`watchfaces/${name}/package.json`]: '{ "workspaces": ["paf", "paf/plugins/*"] }',
    [`watchfaces/${name}/paf/.paf.json`]: JSON.stringify({ commit: COMMIT, tag }),
    [`watchfaces/${name}/package-lock.json`]: '{}',
    [`watchfaces/${name}/node_modules/.paf-install.json`]: JSON.stringify({
      platform: 'linux',
      lock: '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
      framework: '',
    }),
  };
}
