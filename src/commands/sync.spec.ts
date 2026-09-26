/**
 * Specs for the checks paf sync makes before it touches a unit.
 *
 * Pins exist so a finished face never builds against a framework nobody chose for it. The refusals
 * worth pinning are a tag that moved under a recorded commit, and the ways a CI run could otherwise
 * build something other than what is committed. A current unit is the other half: a sync that finds
 * nothing to do must run nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { makeContext, makeTree, fakeRunner } from '../testing/tree.ts';
import { installUnit, sync, syncUnit, use } from './sync.ts';
import type { Unit } from '../repo/units.ts';
import { frameworkPackageHash } from '../unit/lib.ts';

const COMMIT = 'a'.repeat(40);
const MOVED = 'b'.repeat(40);

/** A unit pinned to v3.0.0, with the files given on top. */
function unitWith(files: Record<string, string>): Unit {
  const root = makeTree({
    'watchfaces/ide-vscode/config/pebble.appinfo.json': '{ "name": "ide-vscode" }',
    'watchfaces/ide-vscode/package.json': '{ "workspaces": ["lib"] }',
    ...files,
  });

  return { dir: path.join(root, 'watchfaces', 'ide-vscode'), rel: 'watchfaces/ide-vscode', name: 'ide-vscode', where: 'watchfaces/ide-vscode' };
}

/** A runner whose mirror resolves v3.0.0 to the given commit. */
function mirrorAt(commit: string) {
  return fakeRunner((command, args) => (args.includes('rev-parse') ? { stdout: `${commit}\n` } : undefined));
}

describe('syncUnit', () => {
  /** A tag moved upstream would change a finished face's framework without anyone moving its pin. */
  test('refuses a tag that moved from the commit paf.json recorded', () => {
    const unit = unitWith({ 'watchfaces/ide-vscode/paf.json': JSON.stringify({ framework: 'v3.0.0', commit: COMMIT }) });
    const { ctx } = makeContext(path.dirname(path.dirname(unit.dir)), mirrorAt(MOVED).run);

    const result = () => syncUnit(ctx, unit, { locked: false, force: false });

    expect(result).toThrow(/now points at bbbbbbb, but .*recorded aaaaaaa/);
  });

  /** CI writes nothing, so a pin with no recorded commit has nothing to hold the tag to there. */
  test('refuses a pin with no recorded commit under --locked', () => {
    const unit = unitWith({ 'watchfaces/ide-vscode/paf.json': JSON.stringify({ framework: 'v3.0.0' }), 'watchfaces/ide-vscode/package-lock.json': '{}' });
    const { ctx } = makeContext(path.dirname(path.dirname(unit.dir)), mirrorAt(COMMIT).run);

    const result = () => syncUnit(ctx, unit, { locked: true, force: false });

    expect(result).toThrow(/records no commit/);
  });

  /** A unit left on a local framework would build and release against code that is not in any tag. */
  test('refuses a unit on a local framework under --locked', () => {
    const unit = unitWith({
      'watchfaces/ide-vscode/paf.json': JSON.stringify({ framework: 'v3.0.0', commit: COMMIT }),
      'watchfaces/ide-vscode/lib/.paf-lib.json': JSON.stringify({ commit: COMMIT, local: '/work/pebble-app-framework' }),
      'watchfaces/ide-vscode/package-lock.json': '{}',
    });
    const { ctx } = makeContext(path.dirname(path.dirname(unit.dir)), mirrorAt(COMMIT).run);

    const result = () => syncUnit(ctx, unit, { locked: true, force: false });

    expect(result).toThrow(/local framework/);
  });

  /** Every build syncs first, so a current unit has to cost nothing but a look. */
  test('runs neither git restore nor npm for a unit that is current', () => {
    const lock = '{}';
    const unit = unitWith({
      'watchfaces/ide-vscode/paf.json': JSON.stringify({ framework: 'v3.0.0', commit: COMMIT }),
      'watchfaces/ide-vscode/lib/.paf-lib.json': JSON.stringify({ commit: COMMIT, tag: 'v3.0.0' }),
      'watchfaces/ide-vscode/package-lock.json': lock,
      'watchfaces/ide-vscode/node_modules/.paf-install.json': JSON.stringify({
        platform: 'linux',
        lock: '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
        framework: '',
      }),
    });
    const { run, calls } = mirrorAt(COMMIT);
    const { ctx } = makeContext(path.dirname(path.dirname(unit.dir)), run);

    syncUnit(ctx, unit, { locked: false, force: false });

    const result = calls.filter((call) => call.command === 'npm' || call.args.includes('restore'));

    expect(result).toEqual([]);
  });

  /**
   * node_modules made from Windows holds Windows builds of sharp and esbuild. A pin moved from WSL must
   * stop before it touches lib/, or the unit is left on the new framework with an install that breaks
   * on one side or the other.
   */
  test('stops before refilling lib/ when node_modules came from the other system', () => {
    const unit = unitWith({
      'watchfaces/ide-vscode/paf.json': JSON.stringify({ framework: 'v3.0.0', commit: COMMIT }),
      'watchfaces/ide-vscode/lib/.paf-lib.json': JSON.stringify({ commit: MOVED, tag: 'v2.2.0' }),
      'watchfaces/ide-vscode/package-lock.json': '{}',
      'watchfaces/ide-vscode/node_modules/.paf-install.json': JSON.stringify({ platform: 'win32', lock: 'x' }),
    });
    const { run, calls } = mirrorAt(COMMIT);
    const { ctx } = makeContext(path.dirname(path.dirname(unit.dir)), run);

    const result = () => syncUnit(ctx, unit, { locked: false, force: false });

    expect(result).toThrow(/installed from win32/);
    expect(calls.filter((call) => call.command === 'npm' || call.args.includes('restore'))).toEqual([]);
  });
});

describe('installUnit', () => {
  /** npm install keeps packages already at the lock's versions, so the Windows builds of sharp and esbuild stayed and WSL builds broke. */
  test('clears node_modules from the other system before installing under --force', () => {
    const unit = unitWith({
      'watchfaces/ide-vscode/package-lock.json': '{}',
      'watchfaces/ide-vscode/node_modules/sharp/win32.node': 'windows build',
      'watchfaces/ide-vscode/node_modules/.paf-install.json': JSON.stringify({ platform: 'win32', lock: 'x' }),
    });
    const leftBehind: boolean[] = [];
    const { run } = fakeRunner((command) => {
      if (command === 'npm') {
        leftBehind.push(fs.existsSync(path.join(unit.dir, 'node_modules', 'sharp')));
        fs.mkdirSync(path.join(unit.dir, 'node_modules'), { recursive: true });
      }

      return undefined;
    });
    const { ctx } = makeContext(path.dirname(path.dirname(unit.dir)), run);

    installUnit(ctx, unit, { locked: false, force: true });

    expect(leftBehind).toEqual([false]);
  });

  /** A swap carries lib/node_modules across, so the other system's native builds nested there survived --force too. */
  test('clears lib/node_modules from the other system under --force', () => {
    const unit = unitWith({
      'watchfaces/ide-vscode/package-lock.json': '{}',
      'watchfaces/ide-vscode/lib/node_modules/esbuild/linux.node': 'linux build',
      'watchfaces/ide-vscode/node_modules/.paf-install.json': JSON.stringify({ platform: 'win32', lock: 'x' }),
    });
    const leftBehind: boolean[] = [];
    const { run } = fakeRunner((command) => {
      if (command === 'npm') {
        leftBehind.push(fs.existsSync(path.join(unit.dir, 'lib', 'node_modules', 'esbuild')));
        fs.mkdirSync(path.join(unit.dir, 'node_modules'), { recursive: true });
      }

      return undefined;
    });
    const { ctx } = makeContext(path.dirname(path.dirname(unit.dir)), run);

    installUnit(ctx, unit, { locked: false, force: true });

    expect(leftBehind).toEqual([false]);
  });
});

describe('syncUnit on a lib/ paf did not fill', () => {
  /** The face repos mount the framework as a submodule at lib/, and replacing it would lose any framework work not yet committed there. */
  test('stops rather than replace a lib/ with no stamp', () => {
    const unit = unitWith({
      'watchfaces/ide-vscode/paf.json': JSON.stringify({ framework: 'v3.0.0', commit: COMMIT }),
      'watchfaces/ide-vscode/lib/.git': 'gitdir: ../.git/modules/lib\n',
      'watchfaces/ide-vscode/lib/build.sh': 'uncommitted work',
    });
    const { ctx } = makeContext(path.dirname(path.dirname(unit.dir)), mirrorAt(COMMIT).run);

    const result = () => syncUnit(ctx, unit, { locked: false, force: false });

    expect(result).toThrow(/paf did not put there/);
    expect(fs.readFileSync(path.join(unit.dir, 'lib', 'build.sh'), 'utf8')).toBe('uncommitted work');
  });
});

describe('use pinned', () => {
  /** The local lib/ was deleted before the checks ran, so a refused move back left the unit with no framework at all. */
  test('keeps the local lib/ when the move back is refused', () => {
    const unit = unitWith({
      'watchfaces/ide-vscode/paf.json': JSON.stringify({ framework: 'v3.0.0', commit: COMMIT }),
      'watchfaces/ide-vscode/lib/.paf-lib.json': JSON.stringify({ commit: COMMIT, local: '/work/pebble-app-framework' }),
      'watchfaces/ide-vscode/node_modules/.paf-install.json': JSON.stringify({ platform: 'win32', lock: 'x' }),
    });
    const { ctx } = makeContext(path.dirname(path.dirname(unit.dir)), mirrorAt(COMMIT).run);

    const result = () => use(ctx, 'ide-vscode', 'pinned', undefined);

    expect(result).toThrow(/installed from win32/);
    expect(fs.existsSync(path.join(unit.dir, 'lib', '.paf-lib.json'))).toBe(true);
  });
});

describe('installUnit after a framework move', () => {
  /**
   * lib/ is swapped before the install runs. An install stopped partway left the old lock matching the old
   * stamp, so every sync after called it current and the new framework's dependencies never arrived.
   */
  test('installs again when the framework moved since the last install', () => {
    const unit = unitWith({
      'watchfaces/ide-vscode/lib/.paf-lib.json': JSON.stringify({ commit: COMMIT, tag: 'v3.1.0' }),
      'watchfaces/ide-vscode/lib/package.json': JSON.stringify({ name: 'pebble-app-framework', version: '3.1.0' }),
      'watchfaces/ide-vscode/package-lock.json': JSON.stringify({ packages: { lib: { name: 'pebble-app-framework', version: '3.0.0' } } }),
      'watchfaces/ide-vscode/node_modules/.paf-install.json': JSON.stringify({ platform: 'linux', lock: 'the old lock', framework: MOVED }),
    });
    const { run, calls } = fakeRunner();
    const { ctx } = makeContext(path.dirname(path.dirname(unit.dir)), run);

    installUnit(ctx, unit, { locked: false, force: false });

    expect(calls.map((call) => `${call.command} ${call.args[0]}`)).toEqual(['npm install']);
  });
});

describe('syncUnit on a local framework', () => {
  /** lib/ was copied from the clone once, so framework edits made after paf use local were never built, and nothing said so. */
  test('copies the clone again so its latest edits reach lib/', () => {
    const clone = makeTree({ 'package.json': '{ "name": "pebble-app-framework" }', 'c/core/clock.c': 'fixed' });
    const unit = unitWith({
      'watchfaces/ide-vscode/paf.json': JSON.stringify({ framework: 'v3.0.0', commit: COMMIT }),
      'watchfaces/ide-vscode/lib/.paf-lib.json': JSON.stringify({ commit: COMMIT, local: clone, hash: 'before the fix' }),
      'watchfaces/ide-vscode/lib/c/core/clock.c': 'broken',
      'watchfaces/ide-vscode/package-lock.json': '{}',
    });
    const { run } = fakeRunner((command, args) => {
      if (args.includes('rev-parse')) {
        return { stdout: `${COMMIT}\n` };
      }

      if (args.includes('ls-files')) {
        return { stdout: 'package.json\0c/core/clock.c\0' };
      }

      if (command === 'npm') {
        fs.mkdirSync(path.join(unit.dir, 'node_modules'), { recursive: true });
      }

      return undefined;
    });
    const { ctx } = makeContext(path.dirname(path.dirname(unit.dir)), run);

    syncUnit(ctx, unit, { locked: false, force: false });

    expect(fs.readFileSync(path.join(unit.dir, 'lib', 'c', 'core', 'clock.c'), 'utf8')).toBe('fixed');
  });

  /** A local lib/ needs neither the mirror nor the tag, and builds on one stopped offline or after the tag moved upstream. */
  test('syncs a local lib/ without asking the mirror for its tag', () => {
    const clone = makeTree({ 'package.json': '{ "name": "pebble-app-framework" }' });
    const unit = unitWith({
      'watchfaces/ide-vscode/paf.json': JSON.stringify({ framework: 'v3.0.0', commit: COMMIT }),
      'watchfaces/ide-vscode/lib/.paf-lib.json': JSON.stringify({ commit: COMMIT, local: clone, hash: 'x' }),
      'watchfaces/ide-vscode/package-lock.json': '{}',
    });
    const { run, calls } = fakeRunner((command, args) => {
      if (args.includes('ls-files')) {
        return { stdout: 'package.json\0' };
      }

      if (command === 'npm') {
        fs.mkdirSync(path.join(unit.dir, 'node_modules'), { recursive: true });
      }

      return args.includes('rev-parse') && args.includes('HEAD') ? { stdout: `${COMMIT}\n` } : undefined;
    });
    const { ctx } = makeContext(path.dirname(path.dirname(unit.dir)), run);

    syncUnit(ctx, unit, { locked: false, force: false });

    expect(calls.filter((call) => call.args.some((arg) => arg.startsWith('refs/tags/')))).toEqual([]);
  });
});

describe('lib/ swaps', () => {
  /** npm nests the framework's own dependencies in lib/node_modules, and a swap threw them away where no install check could see. */
  test('carries lib/node_modules across', () => {
    const clone = makeTree({ 'package.json': '{ "name": "pebble-app-framework" }' });
    const unit = unitWith({
      'watchfaces/ide-vscode/paf.json': JSON.stringify({ framework: 'v3.0.0', commit: COMMIT }),
      'watchfaces/ide-vscode/lib/.paf-lib.json': JSON.stringify({ commit: COMMIT, local: clone, hash: 'before' }),
      'watchfaces/ide-vscode/lib/node_modules/esbuild/index.js': 'nested for the framework',
      'watchfaces/ide-vscode/package-lock.json': '{}',
    });
    const { run } = fakeRunner((command, args) => {
      if (args.includes('ls-files')) {
        return { stdout: 'package.json\0' };
      }

      if (command === 'npm') {
        fs.mkdirSync(path.join(unit.dir, 'node_modules'), { recursive: true });
      }

      return args.includes('rev-parse') ? { stdout: `${COMMIT}\n` } : undefined;
    });
    const { ctx } = makeContext(path.dirname(path.dirname(unit.dir)), run);

    syncUnit(ctx, unit, { locked: false, force: false });

    expect(fs.readFileSync(path.join(unit.dir, 'lib', 'node_modules', 'esbuild', 'index.js'), 'utf8')).toBe('nested for the framework');
  });

  /** A clone path recorded from PowerShell reached git in WSL, which failed with nothing to say the path came from the other system. */
  test('explains a local clone that is not there', () => {
    const unit = unitWith({
      'watchfaces/ide-vscode/paf.json': JSON.stringify({ framework: 'v3.0.0', commit: COMMIT }),
      'watchfaces/ide-vscode/lib/.paf-lib.json': JSON.stringify({ commit: COMMIT, local: 'E:\\_DEV_\\pebble-app-framework', hash: 'x' }),
    });
    const { ctx } = makeContext(path.dirname(path.dirname(unit.dir)), fakeRunner().run);

    const result = () => syncUnit(ctx, unit, { locked: false, force: false });

    expect(result).toThrow(/may have been recorded from the other system/);
  });
});

describe('installUnit on a local framework', () => {
  /** Every edit in the framework clone ran a full npm install on the next build, though npm reads only lib/package.json. */
  test('installs nothing when only the framework code changed', () => {
    const unit = unitWith({
      'watchfaces/ide-vscode/lib/package.json': '{ "name": "pebble-app-framework" }',
      'watchfaces/ide-vscode/lib/c/core/clock.c': 'edited since the last install',
      'watchfaces/ide-vscode/package-lock.json': '{}',
    });

    fs.mkdirSync(path.join(unit.dir, 'node_modules'));
    fs.writeFileSync(path.join(unit.dir, 'node_modules', '.paf-install.json'), JSON.stringify({
      platform: 'linux',
      lock: '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
      framework: frameworkPackageHash(unit.dir),
    }));
    const { run, calls } = fakeRunner();
    const { ctx } = makeContext(path.dirname(path.dirname(unit.dir)), run);

    installUnit(ctx, unit, { locked: false, force: false });

    expect(calls).toEqual([]);
  });
});

describe('installUnit and the lock', () => {

  /** A lock that is right gets installed as it is, and one behind the framework is brought up, both by npm install outside CI. */
  test('uses npm install outside CI', () => {
    const unit = unitWith({ 'watchfaces/ide-vscode/package-lock.json': '{}' });
    const { run, calls } = fakeRunner((command) => {
      if (command === 'npm') {
        fs.mkdirSync(path.join(unit.dir, 'node_modules'), { recursive: true });
      }

      return undefined;
    });
    const { ctx } = makeContext(path.dirname(path.dirname(unit.dir)), run);

    installUnit(ctx, unit, { locked: false, force: false });

    expect(calls.map((call) => `${call.command} ${call.args[0]}`)).toEqual(['npm install']);
  });

  /** CI must never rewrite the lock, so it runs npm ci, which stops with npm's own message on a lock out of step. */
  test('uses npm ci under --locked', () => {
    const unit = unitWith({ 'watchfaces/ide-vscode/package-lock.json': '{}' });
    const { run, calls } = fakeRunner((command) => {
      if (command === 'npm') {
        fs.mkdirSync(path.join(unit.dir, 'node_modules'), { recursive: true });
      }

      return undefined;
    });
    const { ctx } = makeContext(path.dirname(path.dirname(unit.dir)), run);

    installUnit(ctx, unit, { locked: true, force: false });

    expect(calls.map((call) => `${call.command} ${call.args[0]}`)).toEqual(['npm ci']);
  });

  /** An install with no stamp could be from either system, and npm install kept its native builds when it was Windows'. */
  test('clears node_modules with no stamp before installing', () => {
    const unit = unitWith({
      'watchfaces/ide-vscode/package-lock.json': '{}',
      'watchfaces/ide-vscode/node_modules/esbuild/win32.node': 'from a hand-run npm ci on Windows',
    });
    const leftBehind: boolean[] = [];
    const { run } = fakeRunner((command) => {
      if (command === 'npm') {
        leftBehind.push(fs.existsSync(path.join(unit.dir, 'node_modules', 'esbuild')));
        fs.mkdirSync(path.join(unit.dir, 'node_modules'), { recursive: true });
      }

      return undefined;
    });
    const { ctx } = makeContext(path.dirname(path.dirname(unit.dir)), run);

    installUnit(ctx, unit, { locked: false, force: false });

    expect(leftBehind).toEqual([false]);
  });
});

describe('use local', () => {
  /** An untracked git repo inside the clone is listed as its folder, and copying that folder as a file failed every build. */
  test('copies only files from a local clone', () => {
    const clone = makeTree({ 'package.json': '{ "name": "pebble-app-framework" }', 'tools/scratch/.git/HEAD': 'ref: refs/heads/main\n' });
    const unit = unitWith({
      'watchfaces/ide-vscode/paf.json': JSON.stringify({ framework: 'v3.0.0', commit: COMMIT }),
      'watchfaces/ide-vscode/package-lock.json': '{}',
    });
    const { run } = fakeRunner((command, args) => {
      if (args.includes('ls-files')) {
        return { stdout: 'package.json\0tools/scratch/\0' };
      }

      if (command === 'npm') {
        fs.mkdirSync(path.join(unit.dir, 'node_modules'), { recursive: true });
      }

      return args.includes('rev-parse') ? { stdout: `${COMMIT}\n` } : undefined;
    });
    const { ctx } = makeContext(path.dirname(path.dirname(unit.dir)), run);

    use(ctx, 'ide-vscode', 'local', clone);

    expect(fs.existsSync(path.join(unit.dir, 'lib', 'package.json'))).toBe(true);
  });

  /** Any folder with a package.json was taken as the clone, and paf use x local . copied the face repo into lib/. */
  test('refuses a folder that is not a framework clone', () => {
    const notFramework = makeTree({ 'package.json': '{ "name": "pebble-watchfaces" }' });
    const unit = unitWith({ 'watchfaces/ide-vscode/paf.json': JSON.stringify({ framework: 'v3.0.0', commit: COMMIT }) });
    const { ctx } = makeContext(path.dirname(path.dirname(unit.dir)), fakeRunner().run);

    const result = () => use(ctx, 'ide-vscode', 'local', notFramework);

    expect(result).toThrow(/does not name pebble-app-framework/);
  });
});

describe('checkUnit', () => {
  /** npm climbed out of a unit with no package.json and wrote the repo root's lock and node_modules. */
  test('stops on a unit with no package.json before anything is written', () => {
    const root = makeTree({ 'watchfaces/newfam/paf.json': JSON.stringify({ framework: 'v3.0.0', commit: COMMIT }) });
    const unit = { dir: path.join(root, 'watchfaces', 'newfam'), rel: 'watchfaces/newfam', name: 'newfam', where: 'watchfaces/newfam' };
    const { run, calls } = mirrorAt(COMMIT);
    const { ctx } = makeContext(root, run);

    const result = () => syncUnit(ctx, unit, { locked: false, force: false });

    expect(result).toThrow(/has no package.json, so npm would install into the folder above it/);
    expect(calls.filter((call) => call.command === 'npm' || call.args.includes('restore'))).toEqual([]);
  });
});

describe('a leftover old lib/', () => {
  /**
   * The old copy's delete can fail after a finished swap. Brought back later as if the swap had stopped,
   * it put a unit on whatever that copy held, a local framework included.
   */
  test('is not brought back when no new lib/ sits beside it', () => {
    const unit = unitWith({
      'watchfaces/ide-vscode/paf.json': JSON.stringify({ framework: 'v3.0.0', commit: COMMIT }),
      'watchfaces/ide-vscode/lib.paf-old/.paf-lib.json': JSON.stringify({ commit: COMMIT, local: '/work/pebble-app-framework', hash: 'x' }),
      'watchfaces/ide-vscode/package-lock.json': '{}',
    });
    const { run } = fakeRunner((command, args) => {
      if (command === 'npm') {
        fs.mkdirSync(path.join(unit.dir, 'node_modules'), { recursive: true });
      }

      return args.includes('rev-parse') ? { stdout: `${COMMIT}\n` } : undefined;
    });
    const { ctx } = makeContext(path.dirname(path.dirname(unit.dir)), run);

    syncUnit(ctx, unit, { locked: false, force: false });

    expect(JSON.parse(fs.readFileSync(path.join(unit.dir, 'lib', '.paf-lib.json'), 'utf8'))).toEqual({ commit: COMMIT, tag: 'v3.0.0' });
  });
});

describe('sync', () => {
  /** sync stopped at the first unit it could not sync, so the units after it kept stale frameworks and CI only saw one problem. */
  test('syncs every unit when one fails', () => {
    const root = makeTree({
      'watchfaces/alpha/paf.json': '{}',
      'watchfaces/beta/paf.json': JSON.stringify({ framework: 'v3.0.0', commit: COMMIT }),
      'watchfaces/beta/package.json': '{ "workspaces": ["lib"] }',
      'watchfaces/beta/lib/.paf-lib.json': JSON.stringify({ commit: COMMIT, tag: 'v3.0.0' }),
      'watchfaces/beta/package-lock.json': '{}',
      'watchfaces/beta/node_modules/.paf-install.json': JSON.stringify({ platform: 'linux', lock: '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a', framework: '' }),
    });
    const { ctx, printed } = makeContext(root, mirrorAt(COMMIT).run);

    const result = sync(ctx, undefined, { locked: false, force: false });

    expect(result).toBe(1);
    expect(printed).toContain('sync failed in watchfaces/alpha');
  });
});
