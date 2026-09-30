/**
 * Running git, npm, node, and pebble.
 *
 * Every command goes through a Runner, so the specs can hand in a fake that records the calls and
 * answers from a script, and nothing in a default test run starts a real process.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** How a command runs. `capture` returns its output instead of passing it through to the terminal. */
export type RunOptions = {
  cwd: string;
  capture?: boolean;
  env?: NodeJS.ProcessEnv;
};

/** What came back. `stdout` and `stderr` are empty unless the command was captured. */
export type RunResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export type Runner = (command: string, args: string[], options: RunOptions) => RunResult;

/**
 * How a program is started. On Windows npm and npx are .cmd scripts, which spawn can only start
 * through the shell, and the shell splits and reads the arguments again. So they run as node with
 * npm's own script, which every Windows install of Node ships beside node itself. paf needs Node with
 * its own npm, so a Node without that script stops with that said, rather than going through a shell.
 */
function startOf(command: string, args: string[]): { file: string; args: string[] } {
  if (process.platform !== 'win32' || (command !== 'npm' && command !== 'npx')) {
    return { file: command, args };
  }

  const cli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', `${command}-cli.js`);

  if (!fs.existsSync(cli)) {
    throw new Error(`${command} is not beside node at ${cli}. paf needs Node with the npm it ships with`);
  }

  return { file: process.execPath, args: [cli, ...args] };
}

/**
 * The real runner.
 *
 * @param command The program to run.
 * @param args Its arguments.
 * @param options Where to run it and whether to capture the output.
 * @return The exit code, plus the output when captured.
 */
export const spawnRunner: Runner = (command, args, options) => {
  const start = startOf(command, args);
  const result = spawnSync(start.file, start.args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
    maxBuffer: 64 * 1024 * 1024,
  });

  if (result.error) {
    return { code: 127, stdout: '', stderr: result.error.message };
  }

  return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
};

/**
 * Runs a command and throws when it fails, with its error output in the message.
 *
 * @param run The runner to use.
 * @param command The program to run.
 * @param args Its arguments.
 * @param options Where to run it and whether to capture the output.
 * @return The captured output, trimmed. Empty when not captured.
 */
export function must(run: Runner, command: string, args: string[], options: RunOptions): string {
  const result = run(command, args, options);

  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();

    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.code}${detail ? `\n${detail}` : ''}`);
  }

  return result.stdout.trim();
}
