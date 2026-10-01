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
import { COMMIT, currentUnit, makeContext, makeTree, fakeRunner } from '../testing/tree.ts';
import { installUnit, sync, syncUnit, use } from './sync.ts';
import type { Unit } from '../repo/units.ts';
import { frameworkPackageHash } from '../unit/framework.ts';

const MOVED = 'b'.repeat(40);

/** A unit pinned to v4.1.0, with the files given on top. */
function unitWith(files: Record<string, string>): Unit {
  const root = makeTree({
    'watchfaces/ide-vscode/pebble.appinfo.json': '{ "name": "ide-vscode" }',
    'watchfaces/ide-vscode/package.json': '{ "workspaces": ["paf", "paf/plugins/*"] }',
    ...files,
  });

  return { dir: path.join(root, 'watchfaces', 'ide-vscode'), rel: 'watchfaces/ide-vscode', name: 'ide-vscode', where: 'watchfaces/ide-vscode' };
}

/** A runner whose mirror resolves v4.1.0 to the given commit. */
function mirrorAt(commit: string) {
  return fakeRunner((command, args) => (args.includes('rev-parse') ? { stdout: `${commit}\n` } : undefined));
}

describe('syncUnit', () => {
  /** A tag moved upstream would change a finished face's framework without anyone moving its pin. */
  test('refuses a tag that moved from the commit paf.config.json recorded', () => {
    const unit = unitWith({ 'watchfaces/ide-vscode/paf.config.json': JSON.stringify({ framework: 'v4.1.0', commit: COMMIT }) });
    const { ctx } = makeContext(path.dirname(path.dirname(unit.dir)), mirrorAt(MOVED).run);

    const result = () => syncUnit(ctx, unit, { locked: false, force: false });

    expect(result).toThrow(/now points at bbbbbbb, but .*recorded aaaaaaa/);
  });

  /**
   * The stamp only named the commit, so a plugin added at the same tag never reached paf/, and the first
   * paf gen for it failed with nothing saying a sync was needed.
   */
  test('fills paf/ again when the unit lists another plugin at the same tag', () => {
    const unit = unitWith({
      'watchfaces/ide-vscode/paf.config.json': JSON.stringify({ framework: 'v4.1.0', commit: COMMIT, plugins: { icons: {}, thumbnails: {} } }),
      'watchfaces/ide-vscode/paf/.paf.json': JSON.stringify({ commit: COMMIT, tag: 'v4.1.0', plugins: ['icons'] }),
      'watchfaces/ide-vscode/package-lock.json': '{}',
    });
    const { run, calls } = fakeRunner((command, args) => {
      if (args.includes('ls-tree')) {
        return { stdout: 'src/plugins/icons\0src/plugins/thumbnails\0' };
      }

      if (command === 'npm') {
        fs.mkdirSync(path.join(unit.dir, 'node_modules'), { recursive: true });
      }

      return args.includes('rev-parse') ? { stdout: `${COMMIT}\n` } : undefined;
    });
    const { ctx } = makeContext(path.dirname(path.dirname(unit.dir)), run);

    syncUnit(ctx, unit, { locked: false, force: false });

    expect(calls.filter((call) => call.args.includes('restore'))).toHaveLength(1);
  });

  /** A plugin folder deleted from paf/ by hand read as held, so doctor said to sync and the sync never put it back. */
  test("fills paf/ again when a listed plugin's folder is gone", () => {
    const unit = unitWith({
      'watchfaces/ide-vscode/paf.config.json': JSON.stringify({ framework: 'v4.1.0', commit: COMMIT, plugins: { icons: {} } }),
      'watchfaces/ide-vscode/paf/.paf.json': JSON.stringify({ commit: COMMIT, tag: 'v4.1.0', plugins: ['icons'] }),
      'watchfaces/ide-vscode/package-lock.json': '{}',
    });
    const { run, calls } = fakeRunner((command, args) => {
      if (args.includes('ls-tree')) {
        return { stdout: 'src/plugins/icons\0' };
      }

      if (command === 'npm') {
        fs.mkdirSync(path.join(unit.dir, 'node_modules'), { recursive: true });
      }

      return args.includes('rev-parse') ? { stdout: `${COMMIT}\n` } : undefined;
    });
    const { ctx } = makeContext(path.dirname(path.dirname(unit.dir)), run);

    syncUnit(ctx, unit, { locked: false, force: false });

    expect(calls.filter((call) => call.args.includes('restore'))).toHaveLength(1);
  });

  /**
   * A plugin deleted from paf/ by hand took its nested sharp with it. The refill brought the package.json
   * back, which put the package hash back as the install recorded it, so npm never ran and sharp stayed gone.
   * A delete Windows held up leaves part of sharp behind, which carried across would be as broken.
   */
  test.each([
    ['deleted whole', (icons: string) => fs.rmSync(icons, { recursive: true })],
    ['left with part of its nested install', (icons: string) => {
      fs.rmSync(path.join(icons, 'package.json'));
      fs.mkdirSync(path.join(icons, 'node_modules', 'sharp'), { recursive: true });
    }],
  ])('installs again when a refill brings back a plugin %s', (_how, remove) => {
    const unit = unitWith({
      ...currentUnit('ide-vscode'),
      'watchfaces/ide-vscode/paf.config.json': JSON.stringify({ framework: 'v4.1.0', commit: COMMIT, plugins: { icons: {} } }),
      'watchfaces/ide-vscode/paf/.paf.json': JSON.stringify({ commit: COMMIT, tag: 'v4.1.0', plugins: ['icons'] }),
      'watchfaces/ide-vscode/paf/plugins/icons/package.json': '{}',
    });
    const installStamp = path.join(unit.dir, 'node_modules', '.paf-install.json');
    const core = fs.readFileSync(path.join(unit.dir, 'paf', 'package.json'), 'utf8');

    // the install was made with the plugin in place, and then the plugin was deleted by hand
    fs.writeFileSync(installStamp, JSON.stringify({ ...JSON.parse(fs.readFileSync(installStamp, 'utf8')), framework: frameworkPackageHash(unit.dir) }));
    remove(path.join(unit.dir, 'paf', 'plugins', 'icons'));

    const { run, calls } = fakeRunner((command, args) => {
      if (args.includes('ls-tree')) {
        return { stdout: 'src/plugins/icons\0' };
      }

      // the restore writes the tag's files back, the same package.json files the install was made from
      if (args.includes('restore')) {
        const dest = args[args.indexOf('--work-tree') + 1];

        fs.mkdirSync(path.join(dest, 'plugins', 'icons'), { recursive: true });
        fs.writeFileSync(path.join(dest, 'package.json'), core);
        fs.writeFileSync(path.join(dest, 'plugins', 'icons', 'package.json'), '{}');
      }

      return args.includes('rev-parse') ? { stdout: `${COMMIT}\n` } : undefined;
    });
    const { ctx } = makeContext(path.dirname(path.dirname(unit.dir)), run);

    syncUnit(ctx, unit, { locked: false, force: false });

    expect(calls.filter((call) => call.command === 'npm')).toHaveLength(1);
    expect(fs.existsSync(path.join(unit.dir, 'paf', 'plugins', 'icons', 'node_modules'))).toBe(false);
  });

  /** A paf/ deleted whole took every nested install with it, and a refill with the same package.json files never ran npm. */
  test('installs again when paf/ was deleted and filled again', () => {
    const unit = unitWith(currentUnit('ide-vscode'));
    const core = fs.readFileSync(path.join(unit.dir, 'paf', 'package.json'), 'utf8');

    fs.rmSync(path.join(unit.dir, 'paf'), { recursive: true });

    const { run, calls } = fakeRunner((command, args) => {
      // the restore writes the tag's files back, the same package.json the install was made from
      if (args.includes('restore')) {
        fs.writeFileSync(path.join(args[args.indexOf('--work-tree') + 1], 'package.json'), core);
      }

      return args.includes('rev-parse') ? { stdout: `${COMMIT}\n` } : undefined;
    });
    const { ctx } = makeContext(path.dirname(path.dirname(unit.dir)), run);

    syncUnit(ctx, unit, { locked: false, force: false });

    expect(calls.filter((call) => call.command === 'npm')).toHaveLength(1);
  });

  /** A unit renamed from paf.json with its framework 3 pin kept would otherwise go on to copy a src/ that tag does not have. */
  test('refuses a pin below framework 4 before it asks the mirror', () => {
    const unit = unitWith({ 'watchfaces/ide-vscode/paf.config.json': JSON.stringify({ framework: 'v3.0.0', commit: COMMIT }) });
    const { run, calls } = mirrorAt(COMMIT);
    const { ctx } = makeContext(path.dirname(path.dirname(unit.dir)), run);

    const result = () => syncUnit(ctx, unit, { locked: false, force: false });

    expect(result).toThrow(/pins v3\.0\.0, which is framework 3 and needs paf 1\.0\.0\. This paf fills framework 4, so move the unit to a framework 4 tag with paf pin/);
    expect(calls).toEqual([]);
  });

  /** CI writes nothing, so a pin with no recorded commit has nothing to hold the tag to there. */
  test('refuses a pin with no recorded commit under --locked', () => {
    const unit = unitWith({ 'watchfaces/ide-vscode/paf.config.json': JSON.stringify({ framework: 'v4.1.0' }), 'watchfaces/ide-vscode/package-lock.json': '{}' });
    const { ctx } = makeContext(path.dirname(path.dirname(unit.dir)), mirrorAt(COMMIT).run);

    const result = () => syncUnit(ctx, unit, { locked: true, force: false });

    expect(result).toThrow(/records no commit/);
  });

  /** A unit left on a local framework would build and release against code that is not in any tag. */
  test('refuses a unit on a local framework under --locked', () => {
    const unit = unitWith({
      'watchfaces/ide-vscode/paf.config.json': JSON.stringify({ framework: 'v4.1.0', commit: COMMIT }),
      'watchfaces/ide-vscode/paf/.paf.json': JSON.stringify({ commit: COMMIT, local: '/work/pebble-app-framework' }),
      'watchfaces/ide-vscode/package-lock.json': '{}',
    });
    const { ctx } = makeContext(path.dirname(path.dirname(unit.dir)), mirrorAt(COMMIT).run);

    const result = () => syncUnit(ctx, unit, { locked: true, force: false });

    expect(result).toThrow(/local framework/);
  });

  /**
   * Every build syncs first, so a current unit has to cost nothing but a look. The unit is the shared
   * current one, with the core's package.json and its install hash, the way a real sync leaves it.
   */
  test('runs neither git restore nor npm for a unit that is current', () => {
    const unit = unitWith(currentUnit('ide-vscode'));
    const { run, calls } = mirrorAt(COMMIT);
    const { ctx } = makeContext(path.dirname(path.dirname(unit.dir)), run);

    syncUnit(ctx, unit, { locked: false, force: false });

    const result = calls.filter((call) => call.command === 'npm' || call.args.includes('restore'));

    expect(result).toEqual([]);
  });

  /**
   * node_modules made from Windows holds Windows builds of sharp and esbuild. A pin moved from WSL must
   * stop before it touches paf/, or the unit is left on the new framework with an install that breaks
   * on one side or the other.
   */
  test('stops before refilling paf/ when node_modules came from the other system', () => {
    const unit = unitWith({
      'watchfaces/ide-vscode/paf.config.json': JSON.stringify({ framework: 'v4.1.0', commit: COMMIT }),
      'watchfaces/ide-vscode/paf/.paf.json': JSON.stringify({ commit: MOVED, tag: 'v4.0.0' }),
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

  /** A swap carries paf/node_modules across, so the other system's native builds nested there survived --force too. */
  test('clears paf/node_modules from the other system under --force', () => {
    const unit = unitWith({
      'watchfaces/ide-vscode/package-lock.json': '{}',
      'watchfaces/ide-vscode/paf/node_modules/esbuild/linux.node': 'linux build',
      'watchfaces/ide-vscode/node_modules/.paf-install.json': JSON.stringify({ platform: 'win32', lock: 'x' }),
    });
    const leftBehind: boolean[] = [];
    const { run } = fakeRunner((command) => {
      if (command === 'npm') {
        leftBehind.push(fs.existsSync(path.join(unit.dir, 'paf', 'node_modules', 'esbuild')));
        fs.mkdirSync(path.join(unit.dir, 'node_modules'), { recursive: true });
      }

      return undefined;
    });
    const { ctx } = makeContext(path.dirname(path.dirname(unit.dir)), run);

    installUnit(ctx, unit, { locked: false, force: true });

    expect(leftBehind).toEqual([false]);
  });
});

describe('syncUnit on a paf/ paf did not fill', () => {
  /** A paf/ paf did not fill, such as a submodule mounted there by hand, can hold framework work not yet committed, which replacing it would lose. */
  test('stops rather than replace a paf/ with no stamp', () => {
    const unit = unitWith({
      'watchfaces/ide-vscode/paf.config.json': JSON.stringify({ framework: 'v4.1.0', commit: COMMIT }),
      'watchfaces/ide-vscode/paf/.git': 'gitdir: ../.git/modules/paf\n',
      'watchfaces/ide-vscode/paf/build.sh': 'uncommitted work',
    });
    const { ctx } = makeContext(path.dirname(path.dirname(unit.dir)), mirrorAt(COMMIT).run);

    const result = () => syncUnit(ctx, unit, { locked: false, force: false });

    expect(result).toThrow(/paf did not put there/);
    expect(fs.readFileSync(path.join(unit.dir, 'paf', 'build.sh'), 'utf8')).toBe('uncommitted work');
  });
});

describe('use pinned', () => {
  /** The local paf/ was deleted before the checks ran, so a refused move back left the unit with no framework at all. */
  test('keeps the local paf/ when the move back is refused', () => {
    const unit = unitWith({
      'watchfaces/ide-vscode/paf.config.json': JSON.stringify({ framework: 'v4.1.0', commit: COMMIT }),
      'watchfaces/ide-vscode/paf/.paf.json': JSON.stringify({ commit: COMMIT, local: '/work/pebble-app-framework' }),
      'watchfaces/ide-vscode/node_modules/.paf-install.json': JSON.stringify({ platform: 'win32', lock: 'x' }),
    });
    const { ctx } = makeContext(path.dirname(path.dirname(unit.dir)), mirrorAt(COMMIT).run);

    const result = () => use(ctx, 'ide-vscode', 'pinned', undefined);

    expect(result).toThrow(/installed from win32/);
    expect(fs.existsSync(path.join(unit.dir, 'paf', '.paf.json'))).toBe(true);
  });
});

describe('installUnit after a framework move', () => {
  /**
   * paf/ is swapped before the install runs. An install stopped partway left the old lock matching the old
   * stamp, so every sync after called it current and the new framework's dependencies never arrived.
   */
  test('installs again when the framework moved since the last install', () => {
    const unit = unitWith({
      'watchfaces/ide-vscode/paf/.paf.json': JSON.stringify({ commit: COMMIT, tag: 'v4.2.0' }),
      'watchfaces/ide-vscode/paf/package.json': JSON.stringify({ name: 'pebble-app-framework', version: '4.2.0' }),
      'watchfaces/ide-vscode/package-lock.json': JSON.stringify({ packages: { paf: { name: 'pebble-app-framework', version: '4.1.0' } } }),
      'watchfaces/ide-vscode/node_modules/.paf-install.json': JSON.stringify({ platform: 'linux', lock: 'the old lock', framework: MOVED }),
    });
    const { run, calls } = fakeRunner();
    const { ctx } = makeContext(path.dirname(path.dirname(unit.dir)), run);

    installUnit(ctx, unit, { locked: false, force: false });

    expect(calls.map((call) => `${call.command} ${call.args[0]}`)).toEqual(['npm install']);
  });
});

describe('syncUnit on a local framework', () => {
  /** paf/ was copied from the clone once, so framework edits made after paf use local were never built, and nothing said so. */
  test('copies the clone again so its latest edits reach paf/', () => {
    const clone = makeTree({ 'src/package.json': '{ "name": "pebble-app-framework" }', 'src/c/core/clock.c': 'fixed' });
    const unit = unitWith({
      'watchfaces/ide-vscode/paf.config.json': JSON.stringify({ framework: 'v4.1.0', commit: COMMIT }),
      'watchfaces/ide-vscode/paf/.paf.json': JSON.stringify({ commit: COMMIT, local: clone, hash: 'before the fix' }),
      'watchfaces/ide-vscode/paf/c/core/clock.c': 'broken',
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

    expect(fs.readFileSync(path.join(unit.dir, 'paf', 'c', 'core', 'clock.c'), 'utf8')).toBe('fixed');
  });

  /** A local paf/ needs neither the mirror nor the tag, and builds on one stopped offline or after the tag moved upstream. */
  test('syncs a local paf/ without asking the mirror for its tag', () => {
    const clone = makeTree({ 'src/package.json': '{ "name": "pebble-app-framework" }' });
    const unit = unitWith({
      'watchfaces/ide-vscode/paf.config.json': JSON.stringify({ framework: 'v4.1.0', commit: COMMIT }),
      'watchfaces/ide-vscode/paf/.paf.json': JSON.stringify({ commit: COMMIT, local: clone, hash: 'x' }),
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

describe('paf/ swaps', () => {
  /** npm nests the framework's own dependencies in paf/node_modules, and a swap threw them away where no install check could see. */
  test('carries paf/node_modules across', () => {
    const clone = makeTree({ 'src/package.json': '{ "name": "pebble-app-framework" }' });
    const unit = unitWith({
      'watchfaces/ide-vscode/paf.config.json': JSON.stringify({ framework: 'v4.1.0', commit: COMMIT }),
      'watchfaces/ide-vscode/paf/.paf.json': JSON.stringify({ commit: COMMIT, local: clone, hash: 'before' }),
      'watchfaces/ide-vscode/paf/package.json': '{ "name": "pebble-app-framework" }',
      'watchfaces/ide-vscode/paf/node_modules/esbuild/index.js': 'nested for the framework',
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

    expect(fs.readFileSync(path.join(unit.dir, 'paf', 'node_modules', 'esbuild', 'index.js'), 'utf8')).toBe('nested for the framework');
  });

  /**
   * npm nests a plugin's dependency, such as sharp, under the plugin when its version clashes with the
   * unit's. Losing it on a swap meant every paf gen reinstalled it, and keeping a dropped plugin's left a
   * stale native build under a folder the unit no longer lists.
   */
  test("carries each kept plugin's nested install across and drops a dropped one's", () => {
    const clone = makeTree({ 'src/package.json': '{ "name": "pebble-app-framework" }', 'src/plugins/icons/package.json': '{}', 'src/plugins/frame/package.json': '{}' });
    const unit = unitWith({
      'watchfaces/ide-vscode/paf.config.json': JSON.stringify({ framework: 'v4.1.0', commit: COMMIT, plugins: { icons: {} } }),
      'watchfaces/ide-vscode/paf/.paf.json': JSON.stringify({ commit: COMMIT, local: clone, hash: 'before', plugins: ['frame', 'icons'] }),
      'watchfaces/ide-vscode/paf/package.json': '{ "name": "pebble-app-framework" }',
      'watchfaces/ide-vscode/paf/plugins/icons/package.json': '{}',
      'watchfaces/ide-vscode/paf/plugins/icons/node_modules/sharp/index.js': 'nested for icons',
      'watchfaces/ide-vscode/paf/plugins/frame/node_modules/playwright/index.js': 'nested for frame',
      'watchfaces/ide-vscode/package-lock.json': '{}',
    });
    const { run } = fakeRunner((command, args) => {
      if (args.includes('ls-files')) {
        return { stdout: 'package.json\0plugins/icons/package.json\0plugins/frame/package.json\0' };
      }

      if (command === 'npm') {
        fs.mkdirSync(path.join(unit.dir, 'node_modules'), { recursive: true });
      }

      return args.includes('rev-parse') ? { stdout: `${COMMIT}\n` } : undefined;
    });
    const { ctx } = makeContext(path.dirname(path.dirname(unit.dir)), run);

    syncUnit(ctx, unit, { locked: false, force: false });

    expect(fs.readFileSync(path.join(unit.dir, 'paf', 'plugins', 'icons', 'node_modules', 'sharp', 'index.js'), 'utf8')).toBe('nested for icons');
    expect(fs.existsSync(path.join(unit.dir, 'paf', 'plugins', 'frame'))).toBe(false);
  });

  /** A clone switched to a framework 3 branch has no src/, and the sync failed with a git error that read as git not being installed. */
  test('explains a local clone that no longer holds framework 4', () => {
    const clone = makeTree({ 'package.json': '{ "name": "pebble-app-framework" }' });
    const unit = unitWith({
      'watchfaces/ide-vscode/paf.config.json': JSON.stringify({ framework: 'v4.1.0', commit: COMMIT }),
      'watchfaces/ide-vscode/paf/.paf.json': JSON.stringify({ commit: COMMIT, local: clone, hash: 'x' }),
    });
    const { ctx } = makeContext(path.dirname(path.dirname(unit.dir)), fakeRunner().run);

    const result = () => syncUnit(ctx, unit, { locked: false, force: false });

    expect(result).toThrow(/no longer holds a framework 4 clone.*or run paf use ide-vscode pinned/);
  });

  /** A clone path recorded from PowerShell reached git in WSL, which failed with nothing to say the path came from the other system. */
  test('explains a local clone that is not there', () => {
    const unit = unitWith({
      'watchfaces/ide-vscode/paf.config.json': JSON.stringify({ framework: 'v4.1.0', commit: COMMIT }),
      'watchfaces/ide-vscode/paf/.paf.json': JSON.stringify({ commit: COMMIT, local: 'E:\\_DEV_\\pebble-app-framework', hash: 'x' }),
    });
    const { ctx } = makeContext(path.dirname(path.dirname(unit.dir)), fakeRunner().run);

    const result = () => syncUnit(ctx, unit, { locked: false, force: false });

    expect(result).toThrow(/may have been recorded from the other system/);
  });
});

describe('installUnit after a swap that stopped', () => {
  /**
   * A swap stopped after its new stamp was written reads as current, so no fill ever ran again, and the
   * nested installs left in the old copy were never put back while the install read as current too.
   */
  test('installs again when a copy is left beside paf/, and clears it', () => {
    const unit = unitWith({
      'watchfaces/ide-vscode/paf/package.json': '{ "name": "pebble-app-framework" }',
      'watchfaces/ide-vscode/paf.paf-old/plugins/icons/node_modules/sharp/index.js': 'left behind',
      'watchfaces/ide-vscode/package-lock.json': '{}',
    });

    fs.mkdirSync(path.join(unit.dir, 'node_modules'));
    fs.writeFileSync(path.join(unit.dir, 'node_modules', '.paf-install.json'), JSON.stringify({ platform: 'linux', lock: '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a', framework: frameworkPackageHash(unit.dir) }));

    const { run, calls } = fakeRunner();
    const { ctx } = makeContext(path.dirname(path.dirname(unit.dir)), run);

    installUnit(ctx, unit, { locked: false, force: false });

    expect(calls.map((call) => `${call.command} ${call.args[0]}`)).toEqual(['npm install']);
    expect(fs.existsSync(path.join(unit.dir, 'paf.paf-old'))).toBe(false);
  });
});

describe('installUnit after a plugin is listed', () => {
  /** Listing frame changed neither the lock nor paf/package.json, so Playwright was never installed and the first frame bake failed. */
  test('installs again when a plugin joins paf/ with the lock unchanged', () => {
    const unit = unitWith({
      'watchfaces/ide-vscode/paf/package.json': '{ "name": "pebble-app-framework" }',
      'watchfaces/ide-vscode/package-lock.json': '{}',
    });
    const before = frameworkPackageHash(unit.dir);

    fs.mkdirSync(path.join(unit.dir, 'node_modules'));
    fs.writeFileSync(path.join(unit.dir, 'node_modules', '.paf-install.json'), JSON.stringify({ platform: 'linux', lock: '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a', framework: before }));
    fs.mkdirSync(path.join(unit.dir, 'paf', 'plugins', 'frame'), { recursive: true });
    fs.writeFileSync(path.join(unit.dir, 'paf', 'plugins', 'frame', 'package.json'), '{ "dependencies": { "playwright": "1" } }');

    const { run, calls } = fakeRunner();
    const { ctx } = makeContext(path.dirname(path.dirname(unit.dir)), run);

    installUnit(ctx, unit, { locked: false, force: false });

    expect(calls.map((call) => `${call.command} ${call.args[0]}`)).toEqual(['npm install']);
  });
});

describe('checkUnit and the workspaces', () => {
  /** A unit moved from ["lib"] by editing one word was told only to list paf, and its plugins never installed. */
  test('refuses a unit listing only paf, naming both workspaces', () => {
    const unit = unitWith({
      'watchfaces/ide-vscode/package.json': '{ "workspaces": ["paf"] }',
      'watchfaces/ide-vscode/paf.config.json': JSON.stringify({ framework: 'v4.1.0', commit: COMMIT }),
    });
    const { ctx } = makeContext(path.dirname(path.dirname(unit.dir)), mirrorAt(COMMIT).run);

    const result = () => syncUnit(ctx, unit, { locked: false, force: false });

    expect(result).toThrow('watchfaces/ide-vscode/package.json does not list paf/plugins/* in its workspaces, so npm never installs the plugins\' packages. Make it "workspaces": ["paf", "paf/plugins/*"]');
  });
});

describe('installUnit on a local framework', () => {
  /** Every edit in the framework clone ran a full npm install on the next build, though npm reads only paf/package.json. */
  test('installs nothing when only the framework code changed', () => {
    const unit = unitWith({
      'watchfaces/ide-vscode/paf/package.json': '{ "name": "pebble-app-framework" }',
      'watchfaces/ide-vscode/paf/c/core/clock.c': 'edited since the last install',
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
    const clone = makeTree({ 'src/package.json': '{ "name": "pebble-app-framework" }', 'src/tools/scratch/.git/HEAD': 'ref: refs/heads/main\n' });
    const unit = unitWith({
      'watchfaces/ide-vscode/paf.config.json': JSON.stringify({ framework: 'v4.1.0', commit: COMMIT }),
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

    expect(fs.existsSync(path.join(unit.dir, 'paf', 'package.json'))).toBe(true);
  });

  /** Any folder with a package.json was taken as the clone, and paf use x local . copied the face repo into paf/. */
  test('refuses a folder that is not a framework clone', () => {
    const notFramework = makeTree({ 'package.json': '{ "name": "pebble-watchfaces" }' });
    const unit = unitWith({ 'watchfaces/ide-vscode/paf.config.json': JSON.stringify({ framework: 'v4.1.0', commit: COMMIT }) });
    const { ctx } = makeContext(path.dirname(path.dirname(unit.dir)), fakeRunner().run);

    const result = () => use(ctx, 'ide-vscode', 'local', notFramework);

    expect(result).toThrow(/does not name pebble-app-framework/);
  });

  /**
   * The framework's root package.json is the repo it is developed in, and what ships is under src/. A
   * clone read by its root would pass on a framework 3 checkout and copy nothing, since it has no src/.
   */
  test('reads a clone by its src/package.json', () => {
    const oldLayout = makeTree({ 'package.json': '{ "name": "pebble-app-framework" }' });
    const unit = unitWith({ 'watchfaces/ide-vscode/paf.config.json': JSON.stringify({ framework: 'v4.1.0', commit: COMMIT }) });
    const { ctx } = makeContext(path.dirname(path.dirname(unit.dir)), fakeRunner().run);

    const result = () => use(ctx, 'ide-vscode', 'local', oldLayout);

    expect(result).toThrow(/its src\/package\.json does not name pebble-app-framework/);
  });
});

describe('checkUnit', () => {
  /** npm climbed out of a unit with no package.json and wrote the repo root's lock and node_modules. */
  test('stops on a unit with no package.json before anything is written', () => {
    const root = makeTree({ 'watchfaces/newfam/paf.config.json': JSON.stringify({ framework: 'v4.1.0', commit: COMMIT }) });
    const unit = { dir: path.join(root, 'watchfaces', 'newfam'), rel: 'watchfaces/newfam', name: 'newfam', where: 'watchfaces/newfam' };
    const { run, calls } = mirrorAt(COMMIT);
    const { ctx } = makeContext(root, run);

    const result = () => syncUnit(ctx, unit, { locked: false, force: false });

    expect(result).toThrow(/has no package.json, so npm would install into the folder above it/);
    expect(calls.filter((call) => call.command === 'npm' || call.args.includes('restore'))).toEqual([]);
  });

  /** A family face left with its appinfo in config/ was skipped by sync, check, and test, which then passed without it. */
  test('stops on a unit with a face whose appinfo is still in config/', () => {
    const root = makeTree({
      'watchfaces/mosaic/paf.config.json': JSON.stringify({ framework: 'v4.1.0', commit: COMMIT }),
      'watchfaces/mosaic/package.json': '{ "workspaces": ["paf", "paf/plugins/*"] }',
      'watchfaces/mosaic/core/.gitkeep': '',
      'watchfaces/mosaic/gridlock/pebble.appinfo.json': '{ "name": "gridlock" }',
      'watchfaces/mosaic/sidereel/config/pebble.appinfo.json': '{ "name": "sidereel" }',
    });
    const unit = { dir: path.join(root, 'watchfaces', 'mosaic'), rel: 'watchfaces/mosaic', name: 'mosaic', where: 'watchfaces/mosaic' };
    const { run, calls } = mirrorAt(COMMIT);
    const { ctx } = makeContext(root, run);

    const result = () => syncUnit(ctx, unit, { locked: false, force: false });

    expect(result).toThrow(/^watchfaces\/mosaic\/sidereel\/config\/pebble\.appinfo\.json is where framework 3 keeps an appinfo/);
    expect(calls.filter((call) => call.command === 'npm' || call.args.includes('restore'))).toEqual([]);
  });
});

describe('a leftover old paf/', () => {
  /**
   * The old copy's delete can fail after a finished swap. Brought back later as if the swap had stopped,
   * it put a unit on whatever that copy held, a local framework included.
   */
  test('is not brought back when no new paf/ sits beside it', () => {
    const unit = unitWith({
      'watchfaces/ide-vscode/paf.config.json': JSON.stringify({ framework: 'v4.1.0', commit: COMMIT }),
      'watchfaces/ide-vscode/paf.paf-old/.paf.json': JSON.stringify({ commit: COMMIT, local: '/work/pebble-app-framework', hash: 'x' }),
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

    expect(JSON.parse(fs.readFileSync(path.join(unit.dir, 'paf', '.paf.json'), 'utf8'))).toEqual({ commit: COMMIT, tag: 'v4.1.0', plugins: [] });
  });
});

describe('use', () => {
  /** Offline, paf use pinned showed a git fetch error for a unit still on framework 3, rather than how to move it. */
  test('refuses a framework 3 pin before it fetches for paf use pinned', () => {
    const root = makeTree({ 'watchfaces/mosaic/paf.config.json': JSON.stringify({ framework: 'v3.0.0', commit: COMMIT }) });
    const { run, calls } = fakeRunner();
    const { ctx } = makeContext(root, run);

    const result = () => use(ctx, 'mosaic', 'pinned', undefined);

    expect(result).toThrow(/pins v3\.0\.0, which is framework 3/);
    expect(calls).toEqual([]);
  });
});

describe('sync', () => {
  /** Offline, the fetch failed first, so a unit still on framework 3 showed a git error rather than how to move it. */
  test('refuses a framework 3 pin before it fetches', () => {
    const root = makeTree({ 'watchfaces/mosaic/paf.config.json': JSON.stringify({ framework: 'v3.0.0', commit: COMMIT }) });
    const { run, calls } = fakeRunner();
    const { ctx, printed } = makeContext(root, run);

    const result = sync(ctx, undefined, { locked: false, force: false });

    expect(result).toBe(1);
    expect(calls).toEqual([]);
    expect(printed[0]).toMatch(/^watchfaces\/mosaic: mosaic\/paf\.config\.json pins v3\.0\.0, which is framework 3/);
  });

  /** Offline, the fetch failed first, so a unit with no package.json showed a git error rather than what it lacks. */
  test('refuses a unit with no package.json before it fetches', () => {
    const root = makeTree({ 'watchfaces/mosaic/paf.config.json': JSON.stringify({ framework: 'v4.1.0', commit: COMMIT }) });
    const { run, calls } = fakeRunner();
    const { ctx, printed } = makeContext(root, run);

    const result = sync(ctx, undefined, { locked: false, force: false });

    expect(result).toBe(1);
    expect(calls).toEqual([]);
    expect(printed[0]).toMatch(/has no package\.json, so npm would install into the folder above it/);
  });

  /** sync stopped at the first unit it could not sync, so the units after it kept stale frameworks and CI only saw one problem. */
  test('syncs every unit when one fails', () => {
    const root = makeTree({
      'watchfaces/alpha/paf.config.json': '{}',
      ...currentUnit('beta'),
    });
    const { ctx, printed } = makeContext(root, mirrorAt(COMMIT).run);

    const result = sync(ctx, undefined, { locked: false, force: false });

    expect(result).toBe(1);
    expect(printed).toContain('sync failed in watchfaces/alpha');
  });
});
