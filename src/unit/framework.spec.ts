/**
 * Specs for filling a unit's paf/ from a tag and from a local clone, with real git.
 *
 * The fills are where git reads the ship pathspecs, and a fake runner cannot say how git reads `**` in
 * an exclude. What is worth pinning is that a tag lands what the unit gets at the top of paf/, with
 * nothing left under a src/ folder or in a swap folder, and that a clone of the same commit gives the
 * same files under the same names.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { spawnRunner } from '../shared/runner.ts';
import { makeTree } from '../testing/tree.ts';
import { fillFromClone, fillFromTag, unitFramework } from './framework.ts';

/** A framework repo laid out the framework 4 way, with a spec, fixtures, and two plugins, committed and tagged. */
function frameworkRepo(): { source: string; mirror: string; commit: string } {
  const source = makeTree({
    'package.json': '{ "name": "pebble-app-framework-dev" }',
    'src/package.json': '{ "name": "pebble-app-framework" }',
    'src/tools/build.ts': 'export {};\n',
    'src/tools/build.spec.ts': 'the build spec\n',
    'src/tools/fixtures/face.json': '{}\n',
    'src/c/core/clock.c': 'int clock;\n',
    'src/c/core/clock.spec.c': 'int spec;\n',
    'src/plugins/icons/package.json': '{ "name": "@paf/icons" }',
    'src/plugins/icons/generate-icons.ts': 'export {};\n',
    'src/plugins/frame/package.json': '{ "name": "@paf/frame" }',
    'src/plugins/README.md': 'what a plugin is\n',
  });
  const mirror = path.join(makeTree({}), 'mirror.git');
  const git = (...args: string[]) => spawnRunner('git', ['-c', 'user.name=spec', '-c', 'user.email=spec@example.com', ...args], { cwd: source, capture: true });

  git('init', '-q');
  git('add', '.');
  git('commit', '-q', '-m', 'framework');
  git('tag', 'v4.1.0');
  git('clone', '-q', '--bare', source, mirror);

  return { source, mirror, commit: git('rev-parse', 'HEAD').stdout.trim() };
}

/** Every file under a folder, as paths from it with forward slashes, sorted. */
function filesIn(dir: string): string[] {
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
    .sort();
}

/** What a unit listing only icons gets, the stamp included. */
const SHIPPED = ['.paf.json', 'c/core/clock.c', 'package.json', 'plugins/README.md', 'plugins/icons/generate-icons.ts', 'plugins/icons/package.json', 'tools/build.ts'];

describe('unitFramework', () => {
  /**
   * A new unit put on a local clone before its first pin still has its own generators. Reading them as
   * none had gen all skip vibrant without a word, so the icons were built from an old colour table.
   */
  test('reads the generators of a local unit with no pin yet', () => {
    const root = makeTree({
      'paf.config.json': JSON.stringify({ plugins: { icons: {} }, gen: { vibrant: { script: 'core/tools/vibrant.ts', after: 'clay' } } }),
      'paf/.paf.json': JSON.stringify({ commit: 'a'.repeat(40), local: '/work/pebble-app-framework' }),
    });

    const result = unitFramework(root);

    expect(result.gen).toEqual({ vibrant: { script: 'core/tools/vibrant.ts', after: 'clay', when: undefined } });
    expect(result.plugins).toEqual(['icons']);
  });
});

describe('fillFromTag', () => {
  /**
   * A restore under the repo's own paths would leave a unit with paf/src/tools/build.ts, and every path
   * the framework's tools use would miss. A spec, a fixture, or an unlisted plugin shipped would be files
   * no build needs, and an unlisted plugin brings its packages to the install.
   */
  test('lands what ships at the top of paf/ with nothing left over', () => {
    const { mirror, commit } = frameworkRepo();
    const unit = makeTree({});

    const result = fillFromTag(spawnRunner, mirror, unit, 'v4.1.0', commit, ['icons']);

    expect(result).toBe(SHIPPED.length - 1);
    expect(filesIn(path.join(unit, 'paf'))).toEqual(SHIPPED);
    expect(fs.readdirSync(unit)).toEqual(['paf']);
  });
});

describe('a swap after one that stopped', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * A swap stopped partway, or one whose old copy could not be deleted, can take nested installs with the
   * folder the next fill clears, and the install stamp still read as current, so sharp or esbuild stayed
   * missing until node_modules was cleared by hand. Deleting the stamp to force it dropped the system the
   * install was made on, so one from the other system was then wiped without --force.
   */
  test('marks the install stale, keeping the system it was made on', () => {
    const { mirror, commit } = frameworkRepo();
    const unit = makeTree({
      'paf.paf-old/node_modules/esbuild/index.js': 'nested',
      'node_modules/.paf-install.json': JSON.stringify({ platform: 'win32', lock: 'x', framework: 'h' }),
    });

    fillFromTag(spawnRunner, mirror, unit, 'v4.1.0', commit, ['icons']);

    expect(JSON.parse(fs.readFileSync(path.join(unit, 'node_modules', '.paf-install.json'), 'utf8'))).toEqual({ platform: 'win32', lock: 'x', framework: 'stale' });
  });

  /**
   * A leftover old copy Windows would not let go of was half deleted, and its node_modules still came
   * across into the new paf/. npm took each package whose package.json survived as installed, so the
   * unit kept a nested dependency with files missing.
   */
  test('carries nothing from a leftover it could not clear', () => {
    const { mirror, commit } = frameworkRepo();
    const unit = makeTree({ 'paf.paf-old/node_modules/esbuild/index.js': 'half deleted' });
    const old = path.join(unit, 'paf.paf-old');
    const rmSync = fs.rmSync;

    vi.spyOn(fs, 'rmSync').mockImplementation((target, options) => {
      if (target === old) {
        throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      }

      rmSync(target, options);
    });

    fillFromTag(spawnRunner, mirror, unit, 'v4.1.0', commit, ['icons']);

    const result = fs.existsSync(path.join(unit, 'paf', 'node_modules'));

    expect(result).toBe(false);
  });
});

describe('fillFromClone', () => {
  /** A clone copied under its src/ names would give paf use local a different paf/ from the tag it is a working copy of. */
  test('gives the same files under the same names as the tag', () => {
    const { source } = frameworkRepo();
    const unit = makeTree({});

    const result = fillFromClone(spawnRunner, source, unit, ['icons']).count;

    expect(result).toBe(SHIPPED.length - 1);
    expect(filesIn(path.join(unit, 'paf'))).toEqual(SHIPPED);
  });

  /** A plugin deleted from a local unit's paf/ read as held, since the clone had not changed, and no sync put it back. */
  test('copies the clone again when a listed plugin is gone from paf/', () => {
    const { source } = frameworkRepo();
    const unit = makeTree({});

    fillFromClone(spawnRunner, source, unit, ['icons']);
    fs.rmSync(path.join(unit, 'paf', 'plugins', 'icons'), { recursive: true });

    const result = fillFromClone(spawnRunner, source, unit, ['icons']).changed;

    expect(result).toBe(true);
    expect(fs.existsSync(path.join(unit, 'paf', 'plugins', 'icons', 'package.json'))).toBe(true);
  });

  /**
   * A plugin folder another branch left on disk, holding only ignored files, was read as a plugin the
   * clone offers, so a unit listing it synced clean with no plugin in paf/, where the tag refused it.
   */
  test('reads the plugins the clone offers from git, not from folders on disk', () => {
    const { source } = frameworkRepo();
    const unit = makeTree({});

    fs.mkdirSync(path.join(source, 'src', 'plugins', 'dev', 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(source, '.gitignore'), 'node_modules/\n');
    fs.writeFileSync(path.join(source, 'src', 'plugins', 'dev', 'node_modules', 'left.js'), '');

    const result = () => fillFromClone(spawnRunner, source, unit, ['dev']);

    expect(result).toThrow(/lists the plugin dev, which the clone at .* does not have\. It has frame and icons/);
  });

  /** git still lists a plugin deleted in the working tree, so it passed as offered and the unit got no plugin with nothing said. */
  test('does not offer a plugin deleted in the working tree', () => {
    const { source } = frameworkRepo();
    const unit = makeTree({});

    fs.rmSync(path.join(source, 'src', 'plugins', 'frame'), { recursive: true });

    const result = () => fillFromClone(spawnRunner, source, unit, ['frame']);

    expect(result).toThrow(/lists the plugin frame, which the clone at .* does not have\. It has icons$/);
  });
});
