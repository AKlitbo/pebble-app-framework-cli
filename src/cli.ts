#!/usr/bin/env node
/**
 * The paf command.
 *
 * Gives each family or face in a repo its own pebble-app-framework version in its own lib/, and runs
 * the framework's build, generators, and checks in place against it.
 */
import { build, check, gen, runScript } from './commands/run.ts';
import { doctor, status } from './commands/info.ts';
import { pin } from './commands/pin.ts';
import { sync, use } from './commands/sync.ts';
import type { Context } from './shared/context.ts';
import { cacheHome, findRepoRoot, frameworkRepo } from './shared/home.ts';
import { spawnRunner } from './shared/runner.ts';
import { messageOf } from './shared/errors.ts';

const HELP = `paf: gives each family or face its own pebble-app-framework, and builds and checks it in place

usage: paf <command> [args]

  sync [unit] [--locked] [--force]
                               fill each unit's lib/ from its pinned tag and install its node_modules
  status                       each unit's faces, tag, the newest tag, and whether it is ready
  pin <unit> <tag|latest>
                               move a unit to another tag, showing the changelog between them first
  use <unit> local [path]      point a unit's lib/ at a local framework clone, builds included
  use <unit> pinned            put it back on its tag
  build <face|all> [--clean]   build a face in its unit (WSL only), clean when message keys or dependencies changed
  gen <face> <kind|all>        run one of the framework's generators for a face, or all it has inputs for
  run <unit|face> <script> [args]
                               run any npm script in a unit
  test | lint | typecheck [unit]
                               run the check in every unit, or one, against its own framework
  doctor                       check git, node, the pins, the SDK, and the workflows

A unit is a folder with a paf.json: a family or a face of its own under watchfaces/ or watchapps/,
or the repo root for a repo that is one face or one family. PAF_HOME moves the cache. PAF_REPO fetches the framework from
another URL or path.`;

/** Takes a --flag out of the argument list, and says whether it was there. */
function takeFlag(args: string[], flag: string): boolean {
  const index = args.indexOf(flag);

  if (index === -1) {
    return false;
  }

  args.splice(index, 1);
  return true;
}

/** The flags each command paf owns takes. build, gen, and run pass the rest on to the framework's tools. */
const FLAGS: Record<string, string[]> = {
  sync: ['--locked', '--force'],
  status: [],
  pin: [],
  use: [],
  test: [],
  lint: [],
  typecheck: [],
  doctor: [],
};

/**
 * Stops on a flag the command does not take. A mistyped --locked in CI would otherwise run a sync that
 * writes to the repo and rewrites its lock.
 */
function refuseUnknownFlags(command: string, args: string[]): void {
  const allowed = FLAGS[command];
  const unknown = allowed ? args.find((arg) => arg.startsWith('-') && !allowed.includes(arg)) : undefined;

  if (unknown) {
    throw new Error(`paf ${command} has no flag ${unknown}${allowed.length ? `. It takes ${allowed.join(' and ')}` : ''}`);
  }
}

function main(argv: string[]): number {
  const [command, ...args] = argv;

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(HELP);
    return 0;
  }

  refuseUnknownFlags(command, args);

  const root = findRepoRoot(process.cwd());

  if (!root) {
    throw new Error('this is not inside a git repo. Run paf from a face repo');
  }

  const ctx: Context = {
    root,
    cache: cacheHome(),
    repo: frameworkRepo(),
    platform: process.platform,
    run: spawnRunner,
    print: (line) => console.log(line),
  };

  switch (command) {
    case 'sync':
      return sync(ctx, args.find((arg) => !arg.startsWith('--')), { locked: takeFlag(args, '--locked'), force: takeFlag(args, '--force') });
    case 'status':
      return status(ctx);
    case 'pin':
      return pin(ctx, args[0], args[1]);
    case 'use':
      return use(ctx, args[0], args[1], args[2]);
    case 'build':
      return build(ctx, args[0], args.slice(1));
    case 'gen':
      return gen(ctx, args[0], args[1], args.slice(2));
    case 'run':
      return runScript(ctx, args[0], args[1], args.slice(2));
    case 'test':
    case 'lint':
    case 'typecheck':
      return check(ctx, command, args[0]);
    case 'doctor':
      return doctor(ctx);
    default:
      throw new Error(`no command called ${command}. Run paf help for the list`);
  }
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  console.error(`paf: ${messageOf(error)}`);
  process.exitCode = 1;
}
