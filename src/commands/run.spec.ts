/**
 * Specs for the decisions paf build, run, and the unit checks make before running anything.
 *
 * A build that should have started clean fails on an undeclared message key, or ships an old library
 * while reporting success. A check over many units that stops at the first hides the failures after it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { COMMIT, currentUnit, fakeRunner, makeContext, makeTree } from '../testing/tree.ts';
import { configureIdentity } from '../unit/framework.ts';
import { SCRIPT_FLAGS } from '../unit/scripts.ts';
import { build, cleanReason, ready, runScript, unitCheck } from './run.ts';

describe('ready', () => {
  /** Offline, a build on a unit still on framework 3 showed a git fetch error rather than how to move it. */
  test('refuses a framework 3 pin before it asks the mirror', () => {
    const root = makeTree({ 'watchfaces/mosaic/paf.config.json': JSON.stringify({ framework: 'v3.0.0', commit: COMMIT }) });
    const { run, calls } = fakeRunner();
    const { ctx } = makeContext(root, run);

    const result = () => ready(ctx, { dir: path.join(root, 'watchfaces', 'mosaic'), rel: 'watchfaces/mosaic', name: 'mosaic', where: 'watchfaces/mosaic' });

    expect(result).toThrow(/pins v3\.0\.0, which is framework 3/);
    expect(calls).toEqual([]);
  });

  /** Offline, a build on a unit with no package.json showed a git fetch error rather than what the unit lacks. */
  test('refuses a unit the sync would refuse before it asks the mirror', () => {
    const root = makeTree({ 'watchfaces/mosaic/paf.config.json': JSON.stringify({ framework: 'v4.1.0' }) });
    const { run, calls } = fakeRunner(() => ({ code: 1 }));
    const { ctx } = makeContext(root, run);

    const result = () => ready(ctx, { dir: path.join(root, 'watchfaces', 'mosaic'), rel: 'watchfaces/mosaic', name: 'mosaic', where: 'watchfaces/mosaic' });

    expect(result).toThrow(/has no package\.json, so npm would install into the folder above it/);
    expect(calls).toEqual([]);
  });
});

describe('cleanReason', () => {
  /** The SDK reads message keys only when it configures, so a new key fails an incremental build. */
  test('starts clean when the message keys changed', () => {
    const result = cleanReason({ keys: 'old', lock: 'same', framework: 'v3' }, { keys: 'new', lock: 'same', framework: 'v3' });

    expect(result).toMatch(/message keys/);
  });

  /** The bundle step does not watch node_modules, so a new dependency ships the old library otherwise. */
  test('starts clean when the dependencies changed', () => {
    const result = cleanReason({ keys: 'same', lock: 'old', framework: 'v3' }, { keys: 'same', lock: 'new', framework: 'v3' });

    expect(result).toMatch(/dependencies/);
  });

  /** The waf helpers and the wscript come from paf/ and are read at configure time, so a new framework has to reconfigure. */
  test('starts clean when the framework in paf/ changed', () => {
    const result = cleanReason({ keys: 'same', lock: 'same', framework: 'v3' }, { keys: 'same', lock: 'same', framework: 'local' });

    expect(result).toMatch(/framework/);
  });

  /**
   * A build that failed records nothing but leaves its build folder, keys and all. A new face whose
   * first build failed then failed every build after on undeclared MESSAGE_KEY_ names.
   */
  test('starts clean when no passing build was recorded', () => {
    const result = cleanReason(undefined, { keys: 'a', lock: 'b', framework: 'v3' });

    expect(result).toMatch(/no passing build/);
  });

  /** A build from the same keys and lock as the last passing one can carry on from it. */
  test('forces nothing when nothing changed', () => {
    const result = cleanReason({ keys: 'a', lock: 'b', framework: 'v3' }, { keys: 'a', lock: 'b', framework: 'v3' });

    expect(result).toBeNull();
  });
});

describe('ready', () => {
  /**
   * The command specs lean on currentUnit being ready as it is. If its install hash stopped matching
   * what frameworkPackageHash works out, every one of them would run a fake install and still pass.
   */
  test('runs no install for a current unit', () => {
    const root = makeTree(currentUnit('mosaic'));
    const { run, calls } = fakeRunner((command, args) => (args.includes('rev-parse') ? { stdout: `${COMMIT}\n` } : undefined));
    const { ctx } = makeContext(root, run);

    ready(ctx, { dir: path.join(root, 'watchfaces', 'mosaic'), rel: 'watchfaces/mosaic', name: 'mosaic', where: 'watchfaces/mosaic' });

    expect(calls.filter((call) => call.command === 'npm')).toEqual([]);
  });

  /** A build has to work offline once a sync has run, so a unit whose mirror already holds its commit must not fetch. */
  test('leaves the mirror alone when it has the pinned tag at the recorded commit', () => {
    const root = makeTree(currentUnit('mosaic'));
    const { run, calls } = fakeRunner((command, args) => (args.includes('rev-parse') ? { stdout: `${COMMIT}\n` } : undefined));
    const { ctx } = makeContext(root, run);

    ready(ctx, { dir: path.join(root, 'watchfaces', 'mosaic'), rel: 'watchfaces/mosaic', name: 'mosaic', where: 'watchfaces/mosaic' });

    expect(calls.filter((call) => call.args.includes('fetch'))).toEqual([]);
  });

  /** A teammate's pin to a newer tag arrives with a pull, and every build failed on a tag the mirror had simply never fetched. */
  test('fetches the mirror when it lacks the pinned tag', () => {
    const root = makeTree(currentUnit('mosaic'));
    let fetched = false;
    const { run, calls } = fakeRunner((command, args) => {
      if (args.includes('fetch')) {
        fetched = true;
      }

      if (args.includes('rev-parse')) {
        return fetched ? { stdout: `${COMMIT}\n` } : { code: 1 };
      }

      return undefined;
    });
    const { ctx } = makeContext(root, run);

    ready(ctx, { dir: path.join(root, 'watchfaces', 'mosaic'), rel: 'watchfaces/mosaic', name: 'mosaic', where: 'watchfaces/mosaic' });

    expect(calls.filter((call) => call.args.includes('fetch'))).toHaveLength(1);
  });

  /** With no commit recorded, a build wrote whatever commit a stale mirror held for the tag into paf.config.json. */
  test('fetches the mirror before recording a commit for the first time', () => {
    const root = makeTree({ ...currentUnit('mosaic'), 'watchfaces/mosaic/paf.config.json': JSON.stringify({ framework: 'v4.1.0' }) });
    const { run, calls } = fakeRunner((command, args) => (args.includes('rev-parse') ? { stdout: `${COMMIT}\n` } : undefined));
    const { ctx } = makeContext(root, run);

    ready(ctx, { dir: path.join(root, 'watchfaces', 'mosaic'), rel: 'watchfaces/mosaic', name: 'mosaic', where: 'watchfaces/mosaic' });

    expect(calls.filter((call) => call.args.includes('fetch'))).toHaveLength(1);
  });

  /** A teammate took a moved tag, and every build here said the tag had moved when only the mirror was behind. */
  test('fetches the mirror when it has the tag at another commit than paf.config.json records', () => {
    const root = makeTree(currentUnit('mosaic'));
    let fetched = false;
    const { run, calls } = fakeRunner((command, args) => {
      if (args.includes('fetch')) {
        fetched = true;
      }

      if (args.includes('rev-parse')) {
        return { stdout: `${fetched ? COMMIT : 'b'.repeat(40)}\n` };
      }

      return undefined;
    });
    const { ctx } = makeContext(root, run);

    ready(ctx, { dir: path.join(root, 'watchfaces', 'mosaic'), rel: 'watchfaces/mosaic', name: 'mosaic', where: 'watchfaces/mosaic' });

    expect(calls.filter((call) => call.args.includes('fetch'))).toHaveLength(1);
  });
});

describe('build', () => {
  /**
   * A clean build that failed had already set its sandbox up from the new inputs. Going back to the old
   * inputs then matched the old record, and an incremental build shipped what the failed one left.
   */
  test('leaves no record behind a failed build, so the next one is clean', () => {
    const root = makeTree({
      ...currentUnit('mosaic'),
      'watchfaces/mosaic/core/.gitkeep': '',
      'watchfaces/mosaic/gridlock/config/pebble.appinfo.json': '{ "name": "gridlock" }',
      'watchfaces/mosaic/targets/.paf-build.json': JSON.stringify({ gridlock: { keys: 'k', lock: 'l', framework: COMMIT } }),
    });
    const { run } = fakeRunner((command, args) => {
      if (command === process.execPath) {
        return { code: 1 };
      }

      return args.includes('rev-parse') ? { stdout: `${COMMIT}\n` } : undefined;
    });
    const { ctx } = makeContext(root, run);

    build(ctx, 'gridlock', []);

    expect(JSON.parse(fs.readFileSync(path.join(root, 'watchfaces', 'mosaic', 'targets', '.paf-build.json'), 'utf8'))).toEqual({});
  });

  /** A half-edited appinfo threw out of build all, and every face after it was left unbuilt. */
  test('builds the other faces when one appinfo cannot be read', () => {
    const root = makeTree({
      ...currentUnit('mosaic'),
      'watchfaces/mosaic/core/.gitkeep': '',
      'watchfaces/mosaic/gridlock/config/pebble.appinfo.json': '{ "name": "gridlock" }',
      'watchfaces/mosaic/sidereel/config/pebble.appinfo.json': '{ half edited',
    });
    const { run, calls } = fakeRunner((command, args) => (args.includes('rev-parse') ? { stdout: `${COMMIT}\n` } : undefined));
    const { ctx } = makeContext(root, run);

    const result = build(ctx, 'all', []);

    expect(result).toBe(1);
    expect(calls.filter((call) => call.command === process.execPath).map((call) => call.args[SCRIPT_FLAGS.length + 1])).toEqual(['gridlock']);
  });

  /** The build script refuses anything but a face first, so a --clean put ahead of it failed every build that had to start clean. */
  test('runs the core build script with the face first and --clean after it', () => {
    const root = makeTree({
      ...currentUnit('mosaic'),
      'watchfaces/mosaic/core/.gitkeep': '',
      'watchfaces/mosaic/gridlock/config/pebble.appinfo.json': '{ "name": "gridlock" }',
    });
    const { run, calls } = fakeRunner((command, args) => (args.includes('rev-parse') ? { stdout: `${COMMIT}\n` } : undefined));
    const { ctx } = makeContext(root, run);

    build(ctx, 'gridlock', ['--debug']);

    const [call] = calls.filter((each) => each.command === process.execPath);

    expect(call.args).toEqual([...SCRIPT_FLAGS, path.join(root, 'watchfaces', 'mosaic', 'paf', 'tools', 'build.ts'), 'gridlock', '--debug', '--clean']);
  });

  /** A -- typed out of habit went on to pebble build, which read the flag after it as something else. */
  test('drops a typed -- before the build arguments', () => {
    const root = makeTree({
      ...currentUnit('mosaic'),
      'watchfaces/mosaic/core/.gitkeep': '',
      'watchfaces/mosaic/gridlock/config/pebble.appinfo.json': '{ "name": "gridlock" }',
      'watchfaces/mosaic/targets/.paf-build.json': '{}',
    });
    const { run, calls } = fakeRunner((command, args) => (args.includes('rev-parse') ? { stdout: `${COMMIT}\n` } : undefined));
    const { ctx } = makeContext(root, run);

    build(ctx, 'gridlock', ['--', '--debug', '--clean']);

    expect(calls.find((each) => each.command === process.execPath)?.args.slice(SCRIPT_FLAGS.length + 1)).toEqual(['gridlock', '--debug', '--clean']);
  });

  /**
   * Under Node 23 the build refuses before its script runs, naming the range, rather than failing inside
   * the script. The refusal comes before a face's record is touched, so the record of the last passing
   * build is still there to decide whether the next one starts clean.
   */
  test("refuses a Node outside the framework's range before touching the build record", () => {
    const record = JSON.stringify({ gridlock: { keys: 'k', lock: 'l', framework: COMMIT } });
    const root = makeTree({
      ...currentUnit('mosaic'),
      'watchfaces/mosaic/paf/package.json': JSON.stringify({ engines: { node: '^22.18.0 || >=24.2.0' }, paf: { build: { script: 'tools/build.ts' } } }),
      'watchfaces/mosaic/core/.gitkeep': '',
      'watchfaces/mosaic/gridlock/config/pebble.appinfo.json': '{ "name": "gridlock" }',
      'watchfaces/mosaic/targets/.paf-build.json': record,
    });
    const { run, calls } = fakeRunner((command, args) => (args.includes('rev-parse') ? { stdout: `${COMMIT}\n` } : undefined));
    const { ctx, printed } = makeContext(root, run);

    ctx.node = '23.11.0';

    const result = build(ctx, 'gridlock', []);

    expect(result).toBe(1);
    expect(calls.filter((call) => call.command === process.execPath)).toEqual([]);
    expect(printed).toContainEqual(expect.stringMatching(/^watchfaces\/mosaic: paf\/package\.json asks for Node \^22\.18\.0 \|\| >=24\.2\.0, and this is 23\.11\.0\./));
    expect(fs.readFileSync(path.join(root, 'watchfaces', 'mosaic', 'targets', '.paf-build.json'), 'utf8')).toBe(record);
  });

  /** A captured build leaves the memory report out of the CI log, and the report posts a blank one. */
  test('runs the build uncaptured', () => {
    const root = makeTree({
      ...currentUnit('mosaic'),
      'watchfaces/mosaic/core/.gitkeep': '',
      'watchfaces/mosaic/gridlock/config/pebble.appinfo.json': '{ "name": "gridlock" }',
    });
    const { run, calls } = fakeRunner((command, args) => (args.includes('rev-parse') ? { stdout: `${COMMIT}\n` } : undefined));
    const { ctx } = makeContext(root, run);

    build(ctx, 'gridlock', []);

    expect(calls.find((each) => each.command === process.execPath)?.options.capture).toBeUndefined();
  });

  /** A plugin's broken key stopped every build in the unit, though a build never runs anything a plugin offers. */
  test('builds when a listed plugin has a broken key', () => {
    const root = makeTree({
      ...currentUnit('mosaic'),
      'watchfaces/mosaic/paf.config.json': JSON.stringify({ framework: 'v4.1.0', commit: COMMIT, plugins: { dev: {} } }),
      'watchfaces/mosaic/paf/.paf.json': JSON.stringify({ commit: COMMIT, tag: 'v4.1.0', plugins: ['dev'] }),
      'watchfaces/mosaic/paf/plugins/dev/package.json': '{ "paf": { "tools": { "shots": {} } } }',
      'watchfaces/mosaic/core/.gitkeep': '',
      'watchfaces/mosaic/gridlock/config/pebble.appinfo.json': '{ "name": "gridlock" }',
    });
    const { run } = fakeRunner((command, args) => (args.includes('rev-parse') ? { stdout: `${COMMIT}\n` } : undefined));
    const { ctx } = makeContext(root, run);

    const result = build(ctx, 'gridlock', []);

    expect(result).toBe(0);
  });

  /** A framework whose core names no build would otherwise run node on nothing and fail with a message about a missing file. */
  test('says so when the core names no build script', () => {
    const root = makeTree({
      ...currentUnit('mosaic'),
      'watchfaces/mosaic/paf/package.json': '{ "paf": {} }',
      'watchfaces/mosaic/core/.gitkeep': '',
      'watchfaces/mosaic/gridlock/config/pebble.appinfo.json': '{ "name": "gridlock" }',
    });
    const { run } = fakeRunner((command, args) => (args.includes('rev-parse') ? { stdout: `${COMMIT}\n` } : undefined));
    const { ctx, printed } = makeContext(root, run);

    const result = build(ctx, 'gridlock', []);

    expect(result).toBe(1);
    expect(printed).toContain('watchfaces/mosaic: paf/package.json names no build script under its paf key');
  });
});

describe('runScript', () => {
  /** npm run needs a -- before a script's arguments, and one typed out of habit reached the generator as a face name. */
  test('passes on one -- when the user typed one too', () => {
    const root = makeTree(currentUnit('mosaic'));
    const { run, calls } = fakeRunner((command, args) => (args.includes('rev-parse') ? { stdout: `${COMMIT}\n` } : undefined));
    const { ctx } = makeContext(root, run);

    runScript(ctx, 'mosaic', 'gen:clay', ['--', 'gridlock']);

    expect(calls.find((call) => call.command === 'npm')?.args).toEqual(['run', 'gen:clay', '--', 'gridlock']);
  });
});

describe('the build record on a local framework', () => {
  /** Every edit in the clone forced a clean build, though only the waf helpers and the wscript go untracked by waf. */
  test('stays the same when only framework code changed', () => {
    const root = makeTree({
      'watchfaces/mosaic/paf/.paf.json': JSON.stringify({ commit: COMMIT, local: '/work/pebble-app-framework', hash: 'a' }),
      'watchfaces/mosaic/paf/waf/paf_staging.py': 'helpers',
      'watchfaces/mosaic/paf/c/core/clock.c': 'before the edit',
      'watchfaces/mosaic/paf/tools/build.ts': 'before the edit',
    });
    const unit = path.join(root, 'watchfaces', 'mosaic');
    const before = configureIdentity(unit);

    fs.writeFileSync(path.join(unit, 'paf', 'c', 'core', 'clock.c'), 'after the edit');
    fs.writeFileSync(path.join(unit, 'paf', 'tools', 'build.ts'), 'after the edit');

    const result = configureIdentity(unit);

    expect(result).toBe(before);
  });

  /** waf does not track the helpers' code, so an edit there has to start clean or the build keeps what the old ones made. */
  test('changes when a waf helper changed', () => {
    const root = makeTree({
      'watchfaces/mosaic/paf/.paf.json': JSON.stringify({ commit: COMMIT, local: '/work/pebble-app-framework', hash: 'a' }),
      'watchfaces/mosaic/paf/waf/paf_staging.py': 'helpers',
    });
    const unit = path.join(root, 'watchfaces', 'mosaic');
    const before = configureIdentity(unit);

    fs.writeFileSync(path.join(unit, 'paf', 'waf', 'paf_staging.py'), 'edited helpers');

    const result = configureIdentity(unit);

    expect(result).not.toBe(before);
  });

  /** Every build writes bytecode for the waf helpers it imports, and read as an edit it made each build after the first start clean. */
  test('stays the same when a build writes the helpers\' bytecode', () => {
    const root = makeTree({
      'watchfaces/mosaic/paf/.paf.json': JSON.stringify({ commit: COMMIT, local: '/work/pebble-app-framework', hash: 'a' }),
      'watchfaces/mosaic/paf/waf/paf_staging.py': 'helpers',
    });
    const unit = path.join(root, 'watchfaces', 'mosaic');
    const before = configureIdentity(unit);

    // Python 3 writes into __pycache__, and Python 2 beside the source
    fs.mkdirSync(path.join(unit, 'paf', 'waf', '__pycache__'));
    fs.writeFileSync(path.join(unit, 'paf', 'waf', '__pycache__', 'paf_staging.cpython-311.pyc'), 'bytecode');
    fs.writeFileSync(path.join(unit, 'paf', 'waf', 'paf_staging.pyc'), 'bytecode');

    const result = configureIdentity(unit);

    expect(result).toBe(before);
  });
});

describe('fetching once per command', () => {
  /** A teammate moved several families to a new tag, and a check over them fetched the mirror once per unit. */
  test('fetches the mirror once for several units that need it', () => {
    const root = makeTree({ ...currentUnit('alpha'), ...currentUnit('beta') });
    // the tag has moved upstream, so the mirror still disagrees with each paf.config.json after the fetch
    const { run, calls } = fakeRunner((command, args) => (args.includes('rev-parse') ? { stdout: `${'b'.repeat(40)}\n` } : undefined));
    const { ctx } = makeContext(root, run);

    unitCheck(ctx, 'test', undefined);

    expect(calls.filter((call) => call.args.includes('fetch'))).toHaveLength(1);
  });
});

describe('unitCheck', () => {
  /** One unit that cannot be readied stopped the run, so the units after it were never tested and their failures never seen. */
  test('runs every unit when one cannot be readied', () => {
    const root = makeTree({ 'watchfaces/alpha/paf.config.json': '{}', ...currentUnit('beta') });
    const { run, calls } = fakeRunner((command, args) => (args.includes('rev-parse') ? { stdout: `${COMMIT}\n` } : undefined));
    const { ctx, printed } = makeContext(root, run);

    const result = unitCheck(ctx, 'test', undefined);

    expect(result).toBe(1);
    expect(calls.filter((call) => call.command === 'npm').map((call) => call.options.cwd)).toEqual([path.join(root, 'watchfaces', 'beta')]);
    expect(printed).toContain('test failed in watchfaces/alpha');
  });
});
