/**
 * Specs for the decisions paf build and paf gen make before running the framework's tools.
 *
 * A build that should have started clean fails on an undeclared message key, or ships an old library
 * while reporting success. gen all decides which generators a face gets, and one it skips leaves a
 * stale file for the specs to catch later.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { fakeRunner, makeContext, makeTree } from '../testing/tree.ts';
import { configureIdentity } from '../unit/lib.ts';
import { build, check, cleanReason, gen, genAllSteps, ready, runScript } from './run.ts';

const COMMIT = 'a'.repeat(40);

/** A unit pinned to v3.0.0 whose lib/ and node_modules are both current, so readying it runs nothing. */
function currentUnit(name: string): Record<string, string> {
  return {
    [`watchfaces/${name}/paf.json`]: JSON.stringify({ framework: 'v3.0.0', commit: COMMIT }),
    [`watchfaces/${name}/package.json`]: '{ "workspaces": ["lib"] }',
    [`watchfaces/${name}/lib/.paf-lib.json`]: JSON.stringify({ commit: COMMIT, tag: 'v3.0.0' }),
    [`watchfaces/${name}/package-lock.json`]: '{}',
    [`watchfaces/${name}/node_modules/.paf-install.json`]: JSON.stringify({
      platform: 'linux',
      lock: '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
      framework: '',
    }),
  };
}

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

  /** The waf helpers and the wscript come from lib/ and are read at configure time, so a new framework has to reconfigure. */
  test('starts clean when the framework in lib/ changed', () => {
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

describe('genAllSteps', () => {
  /** A face's own gen script already knows its steps, such as Gridlock's vibrant table, which no framework generator makes. */
  test('runs the face\'s own gen script when the unit has one', () => {
    const result = genAllSteps({ 'gen:gridlock': 'npm run gen:clay -- gridlock' }, 'gridlock', () => true);

    expect(result).toEqual([['gen:gridlock']]);
  });

  /** Only the generators a face has inputs for run, since the others stop on what is missing. */
  test('runs the generators the face has inputs for', () => {
    const has = (rel: string) => rel === 'resources/icons.json' || rel === 'frame/frame.config.json';

    const result = genAllSteps({}, 'radar-array', has);

    expect(result).toEqual([['gen:icons', '--', 'radar-array'], ['gen:frame', '--', 'radar-array', '--theme', 'all']]);
  });
});

describe('ready', () => {
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

  /** With no commit recorded, a build wrote whatever commit a stale mirror held for the tag into paf.json. */
  test('fetches the mirror before recording a commit for the first time', () => {
    const root = makeTree({ ...currentUnit('mosaic'), 'watchfaces/mosaic/paf.json': JSON.stringify({ framework: 'v3.0.0' }) });
    const { run, calls } = fakeRunner((command, args) => (args.includes('rev-parse') ? { stdout: `${COMMIT}\n` } : undefined));
    const { ctx } = makeContext(root, run);

    ready(ctx, { dir: path.join(root, 'watchfaces', 'mosaic'), rel: 'watchfaces/mosaic', name: 'mosaic', where: 'watchfaces/mosaic' });

    expect(calls.filter((call) => call.args.includes('fetch'))).toHaveLength(1);
  });

  /** A teammate took a moved tag, and every build here said the tag had moved when only the mirror was behind. */
  test('fetches the mirror when it has the tag at another commit than paf.json records', () => {
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
      if (command === 'bash') {
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
    expect(calls.filter((call) => call.command === 'bash').map((call) => call.args[1])).toEqual(['gridlock']);
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

  /** paf gen passes a single generator's arguments on the same way, and a typed -- reached it as a face name. */
  test('passes gen arguments on without a typed --', () => {
    const root = makeTree({ ...currentUnit('mosaic'), 'watchfaces/mosaic/core/.gitkeep': '', 'watchfaces/mosaic/gridlock/config/pebble.appinfo.json': '{ "name": "gridlock" }' });
    const { run, calls } = fakeRunner((command, args) => (args.includes('rev-parse') ? { stdout: `${COMMIT}\n` } : undefined));
    const { ctx } = makeContext(root, run);

    gen(ctx, 'gridlock', 'frame', ['--', '--theme', 'all']);

    expect(calls.find((call) => call.command === 'npm')?.args).toEqual(['run', 'gen:frame', '--', 'gridlock', '--theme', 'all']);
  });
});

describe('the build record on a local framework', () => {
  /** Every edit in the clone forced a clean build, though only the waf helpers and the wscript are read when a build configures. */
  test('stays the same when only framework code changed', () => {
    const root = makeTree({
      'watchfaces/mosaic/lib/.paf-lib.json': JSON.stringify({ commit: COMMIT, local: '/work/pebble-app-framework', hash: 'a' }),
      'watchfaces/mosaic/lib/py/waf_helpers.py': 'helpers',
      'watchfaces/mosaic/lib/c/core/clock.c': 'before the edit',
    });
    const unit = path.join(root, 'watchfaces', 'mosaic');
    const before = configureIdentity(unit);

    fs.writeFileSync(path.join(unit, 'lib', 'c', 'core', 'clock.c'), 'after the edit');

    const result = configureIdentity(unit);

    expect(result).toBe(before);
  });

  /** The waf helpers are read at configure time, so an edit there has to reconfigure or the build keeps the old ones. */
  test('changes when a waf helper changed', () => {
    const root = makeTree({
      'watchfaces/mosaic/lib/.paf-lib.json': JSON.stringify({ commit: COMMIT, local: '/work/pebble-app-framework', hash: 'a' }),
      'watchfaces/mosaic/lib/py/waf_helpers.py': 'helpers',
    });
    const unit = path.join(root, 'watchfaces', 'mosaic');
    const before = configureIdentity(unit);

    fs.writeFileSync(path.join(unit, 'lib', 'py', 'waf_helpers.py'), 'edited helpers');

    const result = configureIdentity(unit);

    expect(result).not.toBe(before);
  });
});

describe('fetching once per command', () => {
  /** A teammate moved several families to a new tag, and a check over them fetched the mirror once per unit. */
  test('fetches the mirror once for several units that need it', () => {
    const root = makeTree({ ...currentUnit('alpha'), ...currentUnit('beta') });
    // the tag has moved upstream, so the mirror still disagrees with each paf.json after the fetch
    const { run, calls } = fakeRunner((command, args) => (args.includes('rev-parse') ? { stdout: `${'b'.repeat(40)}\n` } : undefined));
    const { ctx } = makeContext(root, run);

    check(ctx, 'test', undefined);

    expect(calls.filter((call) => call.args.includes('fetch'))).toHaveLength(1);
  });
});

describe('check', () => {
  /** One unit that cannot be readied stopped the run, so the units after it were never tested and their failures never seen. */
  test('runs every unit when one cannot be readied', () => {
    const root = makeTree({ 'watchfaces/alpha/paf.json': '{}', ...currentUnit('beta') });
    const { run, calls } = fakeRunner((command, args) => (args.includes('rev-parse') ? { stdout: `${COMMIT}\n` } : undefined));
    const { ctx, printed } = makeContext(root, run);

    const result = check(ctx, 'test', undefined);

    expect(result).toBe(1);
    expect(calls.filter((call) => call.command === 'npm').map((call) => call.options.cwd)).toEqual([path.join(root, 'watchfaces', 'beta')]);
    expect(printed).toContain('test failed in watchfaces/alpha');
  });
});
