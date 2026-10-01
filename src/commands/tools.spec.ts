/**
 * Specs for paf gen, check, and tool, run against a unit whose paf/ carries the framework's keys.
 *
 * Each command decides which scripts run, with what, and from where, and a mistake in any of those
 * shows up as a generator baking the wrong themes, a stale face slipping through a check, or a tool
 * writing its output somewhere else. The fake runner's calls are what these pin.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { COMMIT, currentUnit, fakeRunner, makeContext, makeTree, type Call } from '../testing/tree.ts';
import { frameworkPackageHash } from '../unit/framework.ts';
import { INSTALL_STAMP } from '../unit/install.ts';
import { SCRIPT_FLAGS } from '../unit/scripts.ts';
import { check, gen, tool } from './tools.ts';

/** The keys the framework ships, cut down to what these specs run. */
const KEYS: Record<string, object> = {
  core: { gen: { clay: { script: 'tools/clay-components/generate-components.ts', when: 'src/pkjs/clay/builder' } }, check: ['tools/clay-components/check-components.ts'] },
  frame: { gen: { background: { script: 'generate-background.ts', when: 'frame/frame.config.json', allArgs: ['--frame', 'all', '--theme', 'all'] } }, check: [] },
  icons: { gen: { icons: { script: 'generate-icons.ts', when: 'resources/icons.json' } }, check: ['check-icons.ts'] },
  dev: { tools: { 'tap-walk': { script: 'tap-walk.ts' } } },
};

/**
 * The files of a family unit with a gridlock face, current for the plugins it lists, whose paf/ holds
 * the keys above.
 */
function keyedUnit(name: string, plugins: string[], extra: Record<string, string> = {}, unitGen: object = {}): Record<string, string> {
  const dir = `watchfaces/${name}`;
  const files: Record<string, string> = {
    ...currentUnit(name),
    [`${dir}/paf.config.json`]: JSON.stringify({ framework: 'v4.1.0', commit: COMMIT, plugins: Object.fromEntries(plugins.map((plugin) => [plugin, {}])), gen: unitGen }),
    [`${dir}/paf/.paf.json`]: JSON.stringify({ commit: COMMIT, tag: 'v4.1.0', plugins }),
    [`${dir}/paf/package.json`]: JSON.stringify({ paf: KEYS.core }),
    [`${dir}/core/.gitkeep`]: '',
    [`${dir}/gridlock/pebble.appinfo.json`]: '{ "name": "gridlock" }',
  };

  for (const plugin of plugins) {
    files[`${dir}/paf/plugins/${plugin}/package.json`] = JSON.stringify({ paf: KEYS[plugin] });
  }

  return { ...files, ...Object.fromEntries(Object.entries(extra).map(([file, text]) => [`${dir}/${file}`, text])) };
}

/** Records the install as made from paf/ as it now is, so readying the unit runs nothing. */
function settle(root: string, name: string): void {
  const unit = path.join(root, 'watchfaces', name);
  const file = path.join(unit, 'node_modules', INSTALL_STAMP);
  const stamp = JSON.parse(fs.readFileSync(file, 'utf8'));

  fs.writeFileSync(file, JSON.stringify({ ...stamp, framework: frameworkPackageHash(unit) }));
}

/** A tree of the given units, each settled, with a context whose mirror already holds the pinned commit. */
function setUp(units: Record<string, Record<string, string>>, fail: (args: string[]) => number = () => 0, git: (args: string[]) => string | undefined = () => undefined) {
  const root = makeTree(Object.assign({}, ...Object.values(units)));

  for (const name of Object.keys(units)) {
    settle(root, name);
  }

  const { run, calls } = fakeRunner((command, args) => {
    if (args.includes('rev-parse')) {
      return { stdout: `${COMMIT}\n` };
    }

    if (command === 'git') {
      const stdout = git(args);

      return stdout === undefined ? undefined : { stdout };
    }

    return command === process.execPath ? { code: fail(args) } : undefined;
  });
  const { ctx, printed } = makeContext(root, run);

  return { root, ctx, calls, printed };
}

/** The framework scripts a run started, each as the script's path from the repo root with the arguments after it. */
function scripts(root: string, calls: Call[]): string[][] {
  return calls
    .filter((call) => call.command === process.execPath)
    .map((call) => [path.relative(root, call.args[SCRIPT_FLAGS.length]).split(path.sep).join('/'), ...call.args.slice(SCRIPT_FLAGS.length + 1)]);
}

describe('gen', () => {
  /** --theme all bakes every theme, so passing it to a single background run would ignore the theme the person typed. */
  test('passes allArgs to gen all and not to a single kind', () => {
    const { root, ctx, calls } = setUp({ mosaic: keyedUnit('mosaic', ['frame'], { 'gridlock/frame/frame.config.json': '{}' }) });

    gen(ctx, 'gridlock', 'all', []);
    gen(ctx, 'gridlock', 'background', ['--theme', 'dark']);

    expect(scripts(root, calls)).toEqual([
      ['watchfaces/mosaic/paf/plugins/frame/generate-background.ts', 'gridlock', '--frame', 'all', '--theme', 'all'],
      ['watchfaces/mosaic/paf/plugins/frame/generate-background.ts', 'gridlock', '--theme', 'dark'],
    ]);
  });

  /**
   * A face without icons.json has no icons to make, and the Clay builder of a family lives in its core,
   * which is the one case the core is looked in for.
   */
  test('skips a generator the face lacks inputs for and finds the Clay builder in the family core', () => {
    const { root, ctx, calls } = setUp({ mosaic: keyedUnit('mosaic', ['icons'], { 'core/pkjs/clay/builder/index.ts': '' }) });

    gen(ctx, 'gridlock', 'all', []);

    expect(scripts(root, calls)).toEqual([['watchfaces/mosaic/paf/tools/clay-components/generate-components.ts', 'gridlock']]);
  });

  /** The colour table the unit makes from the Clay output has to be written before the icons read it. */
  test('runs the unit generator right after the one it names, from the unit', () => {
    const unit = keyedUnit('mosaic', ['icons'], { 'core/pkjs/clay/builder/index.ts': '', 'gridlock/resources/icons.json': '{}' }, { vibrant: { script: 'core/tools/vibrant.ts', after: 'clay' } });
    const { root, ctx, calls } = setUp({ mosaic: unit });

    gen(ctx, 'gridlock', 'all', []);

    expect(scripts(root, calls).map(([script]) => script)).toEqual([
      'watchfaces/mosaic/paf/tools/clay-components/generate-components.ts',
      'watchfaces/mosaic/core/tools/vibrant.ts',
      'watchfaces/mosaic/paf/plugins/icons/generate-icons.ts',
    ]);
  });

  /**
   * The frame generator's --out paths are relative to where it runs, so a script run from the repo root
   * writes them in the wrong place. The flag keeps Node's typeless package warning off every run.
   */
  test('runs each script under the Node paf is on, from the unit, with the face first', () => {
    const { root, ctx, calls } = setUp({ mosaic: keyedUnit('mosaic', []) });

    gen(ctx, 'gridlock', 'clay', []);

    const [call] = calls.filter((each) => each.command === process.execPath);

    expect(call.args.slice(0, SCRIPT_FLAGS.length)).toEqual(['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON']);
    expect(call.args.slice(SCRIPT_FLAGS.length + 1)).toEqual(['gridlock']);
    expect(call.options.cwd).toBe(path.join(root, 'watchfaces', 'mosaic'));
  });

  /** Under Node 23 the framework's tools have no import.meta.main and stop before they start, so paf says why first. */
  test("runs nothing under a Node outside the framework's range, naming both", () => {
    const unit = keyedUnit('mosaic', [], { 'paf/package.json': JSON.stringify({ engines: { node: '^22.18.0 || >=24.2.0' }, paf: KEYS.core }) });
    const { ctx, calls } = setUp({ mosaic: unit });

    ctx.node = '23.11.0';

    const result = () => gen(ctx, 'gridlock', 'clay', []);

    expect(result).toThrow(/^watchfaces\/mosaic\/paf\/package\.json asks for Node \^22\.18\.0 \|\| >=24\.2\.0, and this is 23\.11\.0\./);
    expect(calls.filter((call) => call.command === process.execPath)).toEqual([]);
  });

  /**
   * A paf/ copied while the clone asked for Node 24 refused Node 22 though the clone had since widened its
   * range, and the sync that would have copied the wider one never ran.
   */
  test('reads the range from the framework the sync leaves, not a stale copy', () => {
    const clone = { name: 'pebble-app-framework', engines: { node: '^22.18.0 || >=24.2.0' }, paf: KEYS.core };
    const unit = keyedUnit('mosaic', [], {
      'paf/package.json': JSON.stringify({ engines: { node: '>=24.2.0' }, paf: KEYS.core }),
    });
    const { root, ctx, calls } = setUp({ mosaic: unit }, undefined, (args) => (args.includes('ls-files') ? 'package.json\0' : undefined));

    fs.mkdirSync(path.join(root, 'clone', 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'clone', 'src', 'package.json'), JSON.stringify(clone));
    fs.writeFileSync(path.join(root, 'watchfaces', 'mosaic', 'paf', '.paf.json'), JSON.stringify({ commit: COMMIT, local: path.join(root, 'clone'), plugins: [] }));
    ctx.node = '22.22.2';

    gen(ctx, 'gridlock', 'clay', []);

    expect(calls.filter((call) => call.command === process.execPath)).toHaveLength(1);
  });

  /** A person who types the background generator on a unit that does not list the plugin needs to be told which one to list. */
  test('names the plugin to list for a kind an unlisted plugin offers', () => {
    // the tag in the mirror has the frame plugin, which the unit leaves out of paf/
    const { ctx } = setUp({ mosaic: keyedUnit('mosaic', []) }, undefined, (args) => {
      if (args.includes('ls-tree')) {
        return 'src/plugins/frame\0';
      }

      return args.includes(`${COMMIT}:src/plugins/frame/package.json`) ? JSON.stringify({ paf: KEYS.frame }) : undefined;
    });

    const result = () => gen(ctx, 'gridlock', 'background', []);

    expect(result).toThrow(/The frame plugin offers it, so list it under plugins in paf\.config\.json/);
  });

  /** A typed -- reached the generator as a face name, since node reads everything after one as a plain argument. */
  test("drops a -- typed before a single generator's arguments", () => {
    const { root, ctx, calls } = setUp({ mosaic: keyedUnit('mosaic', ['frame']) });

    gen(ctx, 'gridlock', 'background', ['--', '--theme', 'dark']);

    expect(scripts(root, calls)).toEqual([['watchfaces/mosaic/paf/plugins/frame/generate-background.ts', 'gridlock', '--theme', 'dark']]);
  });

  /** A generator that fails partway leaves the ones after it reading its half-written output, so gen all stops there and passes its code on. */
  test('stops gen all at the first failure with its exit code', () => {
    const unit = keyedUnit('mosaic', ['icons'], { 'core/pkjs/clay/builder/index.ts': '', 'gridlock/resources/icons.json': '{}' });
    const { root, ctx, calls } = setUp({ mosaic: unit }, (args) => (args.some((arg) => arg.endsWith('generate-components.ts')) ? 2 : 0));

    const result = gen(ctx, 'gridlock', 'all', []);

    expect(result).toBe(2);
    expect(scripts(root, calls)).toHaveLength(1);
  });
});

describe('check', () => {
  /** One stale face in the first unit stopped the run, which hid the second unit's stale face until the next push. */
  test('runs every check of every unit before reporting', () => {
    const { root, ctx, calls, printed } = setUp({ alpha: keyedUnit('alpha', ['icons']), beta: keyedUnit('beta', []) }, (args) => (args.some((arg) => arg.includes(`alpha${path.sep}paf${path.sep}tools`)) ? 1 : 0));

    const result = check(ctx, undefined);

    expect(result).toBe(1);
    expect(scripts(root, calls)).toEqual([
      ['watchfaces/alpha/paf/tools/clay-components/check-components.ts'],
      ['watchfaces/alpha/paf/plugins/icons/check-icons.ts'],
      ['watchfaces/beta/paf/tools/clay-components/check-components.ts'],
    ]);
    expect(printed).toContain('check failed in watchfaces/alpha');
  });

  /** A Node outside the range fails every check in a unit alike, so it is said once and no check runs. */
  test('refuses the Node once for a unit and runs none of its checks', () => {
    const unit = keyedUnit('mosaic', ['icons'], { 'paf/package.json': JSON.stringify({ engines: { node: '^22.18.0 || >=24.2.0' }, paf: KEYS.core }) });
    const { ctx, calls, printed } = setUp({ mosaic: unit });

    ctx.node = '23.11.0';

    const result = check(ctx, undefined);

    expect(result).toBe(1);
    expect(calls.filter((call) => call.command === process.execPath)).toEqual([]);
    expect(printed.filter((line) => line.includes('asks for Node'))).toHaveLength(1);
  });

  /** A check paf refuses to run fails its unit, and the other checks still run, so one bad entry hides nothing else. */
  test('fails a check that is not .ts on its own and runs the rest', () => {
    const unit = keyedUnit('mosaic', ['icons'], { 'paf/plugins/icons/package.json': JSON.stringify({ paf: { check: ['check-icons.sh'] } }) });
    const { root, ctx, calls, printed } = setUp({ mosaic: unit });

    const result = check(ctx, undefined);

    expect(result).toBe(1);
    expect(scripts(root, calls)).toEqual([['watchfaces/mosaic/paf/tools/clay-components/check-components.ts']]);
    expect(printed.some((line) => /check-icons\.sh is not a \.ts script/.test(line))).toBe(true);
  });
});

describe('tool', () => {
  /** The rule that keeps shell scripts out of a unit for good, checked before anything runs. */
  test('refuses a tool that is not a .ts script', () => {
    const unit = keyedUnit('mosaic', ['dev'], { 'paf/plugins/dev/package.json': JSON.stringify({ paf: { tools: { shots: { script: 'shots.sh' } } } }) });
    const { ctx, calls } = setUp({ mosaic: unit });

    const result = () => tool(ctx, 'gridlock', 'shots', []);

    expect(result).toThrow(/shots\.sh is not a \.ts script, and paf only runs \.ts scripts/);
    expect(calls.filter((call) => call.command === process.execPath)).toEqual([]);
  });

  /** One bad tool entry in a plugin stopped every paf gen and paf check in the unit, though nobody asked to run it. */
  test('leaves gen working when a listed plugin has a tool that is not .ts', () => {
    const unit = keyedUnit('mosaic', ['dev'], { 'paf/plugins/dev/package.json': JSON.stringify({ paf: { tools: { shots: { script: 'shots.sh' } } } }) });
    const { root, ctx, calls } = setUp({ mosaic: unit });

    gen(ctx, 'gridlock', 'clay', []);

    expect(scripts(root, calls)).toEqual([['watchfaces/mosaic/paf/tools/clay-components/generate-components.ts', 'gridlock']]);
  });

  /**
   * A captured tool sits silent for the minutes a tap walk takes, and clay-preview --watch never shows its
   * page is ready. -h has to reach the tool, not paf.
   */
  test('runs uncaptured and passes every argument after the name as typed', () => {
    const { root, ctx, calls } = setUp({ mosaic: keyedUnit('mosaic', ['dev']) });

    tool(ctx, 'gridlock', 'tap-walk', ['-h', '--', '--out', 'shots']);

    const [call] = calls.filter((each) => each.command === process.execPath);

    expect(scripts(root, [call])).toEqual([['watchfaces/mosaic/paf/plugins/dev/tap-walk.ts', 'gridlock', '-h', '--', '--out', 'shots']]);
    expect(call.options.capture).toBeUndefined();
  });
});
