/**
 * Specs for the SDK verdict and the workflow check in paf doctor, and the unit state paf status shows.
 *
 * The SDK verdict is what tells someone their SDK is behind the framework. The rule worth pinning is
 * that being ahead never fails, since a unit left on an old tag would otherwise nag forever once the
 * SDK moved on. A unit that cannot be read is reported on its own row, so it never hides the others.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { COMMIT, currentUnit, fakeRunner, makeContext, makeTree } from '../testing/tree.ts';
import { frameworkPackageHash } from '../unit/framework.ts';
import { doctor, sdkVerdict, status, unitState, workflowActionTags } from './info.ts';

describe('sdkVerdict', () => {
  /** An older SDK can lack what the framework uses, such as a platform, so it is a problem. */
  test('calls an older SDK behind', () => {
    const result = sdkVerdict('4.17', '4.33.1');

    expect(result).toEqual({ word: 'behind', problem: true });
  });

  /** A newer SDK is normal, and failing on it would nag every unit left on an older tag. */
  test('notes a newer SDK without calling it a problem', () => {
    const result = sdkVerdict('4.40', '4.33.1');

    expect(result).toEqual({ word: 'note', problem: false });
  });
});

describe('workflowActionTags', () => {
  /** doctor compares these against the newest unit, and an action older than a unit may not know its layout. */
  test('reads the tag each framework action is loaded at', () => {
    const result = workflowActionTags('uses: AKlitbo/pebble-app-framework/.github/actions/setup-pebble@v4.1.0\nuses: actions/checkout@v7');

    expect(result).toEqual(['v4.1.0']);
  });
});

describe('unitState', () => {
  /** A unit read as ready had an old copy beside paf/, and the next sync installed again with no warning. */
  test('calls a unit with an old copy beside paf/ in need of a sync', () => {
    const root = makeTree({ ...currentUnit('mosaic'), 'watchfaces/mosaic/paf.paf-old/package.json': '{}' });
    const { ctx } = makeContext(root, fakeRunner((command, args) => (args.includes('rev-parse') ? { stdout: `${COMMIT}\n` } : undefined)).run);

    const result = unitState(ctx, { dir: path.join(root, 'watchfaces', 'mosaic'), rel: 'watchfaces/mosaic', name: 'mosaic', where: 'watchfaces/mosaic' });

    expect(result).toBe('needs paf sync, since paf.paf-old is left beside paf/');
  });

  /** One unit with a broken paf.config.json stopped paf status before its table, so no other unit was shown either. */
  test('reports a unit it cannot read as a problem rather than throwing', () => {
    const root = makeTree({ 'watchfaces/mosaic/paf.config.json': '{ not json' });
    const { ctx } = makeContext(root, fakeRunner().run);

    const result = unitState(ctx, { dir: path.join(root, 'watchfaces', 'mosaic'), rel: 'watchfaces/mosaic', name: 'mosaic', where: 'watchfaces/mosaic' });

    expect(result).toMatch(/^problem: .*paf\.config\.json could not be read/);
  });

  /** A plugin added to paf.config.json showed as ready, so nothing said a sync was needed before its paf gen failed. */
  test('calls a unit whose paf/ holds other plugins than it lists in need of a sync', () => {
    const root = makeTree({
      'watchfaces/mosaic/paf.config.json': JSON.stringify({ framework: 'v4.1.0', commit: 'a'.repeat(40), plugins: { icons: {}, thumbnails: {} } }),
      'watchfaces/mosaic/paf/.paf.json': JSON.stringify({ commit: 'a'.repeat(40), tag: 'v4.1.0', plugins: ['icons'] }),
    });
    const { ctx } = makeContext(root, fakeRunner().run);

    const result = unitState(ctx, { dir: path.join(root, 'watchfaces', 'mosaic'), rel: 'watchfaces/mosaic', name: 'mosaic', where: 'watchfaces/mosaic' });

    expect(result).toBe('needs paf sync');
  });

  /** sync and build take a unit on a local framework whatever it pins, so status calling it a problem sent people chasing nothing. */
  test('shows a unit on a local framework as local, whatever it pins', () => {
    const root = makeTree({
      'watchfaces/mosaic/paf.config.json': JSON.stringify({ framework: 'v3.0.0', commit: 'a'.repeat(40) }),
      'watchfaces/mosaic/paf/.paf.json': JSON.stringify({ commit: 'a'.repeat(40), local: '/work/pebble-app-framework', hash: 'x' }),
    });
    const { ctx } = makeContext(root, fakeRunner().run);

    const result = unitState(ctx, { dir: path.join(root, 'watchfaces', 'mosaic'), rel: 'watchfaces/mosaic', name: 'mosaic', where: 'watchfaces/mosaic' });

    expect(result).toBe('local, /work/pebble-app-framework');
  });
});

describe('status', () => {
  /** With only framework 3 releases out, LATEST offered one that paf pin refuses, beside a unit on a framework 4 candidate. */
  test('shows the latest framework 4 tag, not a framework 3 release', () => {
    const root = makeTree({ 'watchfaces/mosaic/paf.config.json': JSON.stringify({ framework: 'v4.1.0-rc.27', commit: 'a'.repeat(40) }) });
    const { ctx, printed } = makeContext(root, fakeRunner((command, args) => (args.includes('tag') ? { stdout: 'v3.1.0\nv4.1.0-rc.27\n' } : undefined)).run);

    status(ctx);

    expect(printed[1]).toMatch(/v4\.1\.0-rc\.27\s+v4\.1\.0-rc\.27/);
  });

  /** A unit renamed from paf.json showed its tag as ?, hiding the pin it had to move off. */
  test('shows a framework 3 pin as its tag and the unit as a problem', () => {
    const root = makeTree({ 'watchfaces/mosaic/paf.config.json': JSON.stringify({ framework: 'v3.0.0', commit: 'a'.repeat(40) }) });
    const { ctx, printed } = makeContext(root, fakeRunner().run);

    status(ctx);

    expect(printed[1]).toMatch(/v3\.0\.0 .*problem: mosaic\/paf\.config\.json pins v3\.0\.0, which is framework 3/);
  });
});

/**
 * doctor over one mosaic unit that is otherwise clean: current, every folder ignored, and no pebble, so
 * the problem lines it prints are the ones the files given on top cause.
 */
function problemsWith(files: Record<string, string>): { result: number; problems: string[] } {
  const root = makeTree({ ...currentUnit('mosaic'), ...files });
  const unit = path.join(root, 'watchfaces', 'mosaic');
  const stamp = path.join(unit, 'node_modules', '.paf-install.json');

  // the install was made from paf/ as it now is, so the unit reads as ready
  fs.writeFileSync(stamp, JSON.stringify({ ...JSON.parse(fs.readFileSync(stamp, 'utf8')), framework: frameworkPackageHash(unit) }));

  const { ctx, printed } = makeContext(root, fakeRunner((command, args) => {
    if (command === 'pebble') {
      return { code: 1 };
    }

    if (args.includes('rev-parse')) {
      return { stdout: `${COMMIT}\n` };
    }

    return args.includes('check-ignore') ? { stdout: args.slice(args.indexOf('check-ignore') + 1).join('\n') } : undefined;
  }).run);
  const result = doctor(ctx);

  return { result, problems: printed.filter((line) => /^(problem|behind) /.test(line)) };
}

describe('doctor', () => {
  /**
   * A unit moved by hand keeps its old lib/ until someone deletes it, and nothing else in paf looks at it.
   * paf 1.0.0 stamped the copies it filled, and one from before that is known by the framework's package.
   */
  test.each([
    ['lib/.paf-lib.json', '{}'],
    ['lib/package.json', '{ "name": "pebble-app-framework" }'],
  ])('names a lib/ left from paf 1.0.0, known by %s', (file, text) => {
    const result = problemsWith({ [`watchfaces/mosaic/${file}`]: text });

    expect(result.problems).toEqual(['problem  watchfaces/mosaic/lib is left from paf 1.0.0, which filled it. Delete it, since paf 2.0.0 fills paf/']);
  });

  /** A face may keep code of its own in a folder called lib, which is not the framework's to name. */
  test("leaves alone a lib/ of the face's own", () => {
    const result = problemsWith({ 'watchfaces/mosaic/lib/colours.ts': 'export {};' });

    expect(result.problems).toEqual([]);
  });

  /** A plugin listed but not synced is only noticed when paf gen <face> icons fails, unless doctor says so first. */
  test('names a listed plugin paf/ does not hold', () => {
    const result = problemsWith({
      'watchfaces/mosaic/paf.config.json': JSON.stringify({ framework: 'v4.1.0', commit: COMMIT, plugins: { icons: {} } }),
      'watchfaces/mosaic/paf/.paf.json': JSON.stringify({ commit: COMMIT, tag: 'v4.1.0', plugins: ['icons'] }),
    });

    expect(result.problems).toEqual([
      'problem  watchfaces/mosaic lists the icons plugin, which paf/ does not hold. Run paf sync mosaic',
      'problem  watchfaces/mosaic need attention, see paf status',
    ]);
  });

  /** A package.json broken by an edit read as fine to doctor, which passed while sync refused the unit. */
  test('names a package.json that cannot be read', () => {
    const result = problemsWith({ 'watchfaces/mosaic/package.json': '{ "workspaces": ["paf", ' });

    expect(result.result).toBe(1);
    expect(result.problems).toEqual([expect.stringMatching(/^problem {2}.*package\.json could not be read/)]);
  });

  /** sync refuses a unit whose workspaces leave out the plugins, and doctor is where someone looks first. */
  test('names a workspaces that leaves out the plugins', () => {
    const result = problemsWith({ 'watchfaces/mosaic/package.json': '{ "workspaces": ["paf"] }' });

    expect(result.problems).toEqual([
      'problem  watchfaces/mosaic/package.json does not list paf/plugins/* in its workspaces, so npm never installs the plugins\' packages. Make it "workspaces": ["paf", "paf/plugins/*"]',
    ]);
  });

  /**
   * A paf gen refused for the Node has to show up in doctor too, or the reason is only ever one error line.
   * The unit is otherwise clean, so the Node is the one thing that can fail it.
   */
  test('fails on a unit whose framework takes another Node, and on nothing else', () => {
    const root = makeTree({
      ...currentUnit('mosaic'),
      'watchfaces/mosaic/paf/package.json': '{ "engines": { "node": "^22.18.0 || >=24.2.0" } }',
    });
    const unit = path.join(root, 'watchfaces', 'mosaic');
    const stamp = path.join(unit, 'node_modules', '.paf-install.json');

    // the install was made from this paf/package.json, so the unit reads as ready
    fs.writeFileSync(stamp, JSON.stringify({ ...JSON.parse(fs.readFileSync(stamp, 'utf8')), framework: frameworkPackageHash(unit) }));

    const { ctx, printed } = makeContext(root, fakeRunner((command, args) => {
      if (command === 'pebble') {
        return { code: 1 };
      }

      if (args.includes('rev-parse')) {
        return { stdout: `${COMMIT}\n` };
      }

      return args.includes('check-ignore') ? { stdout: args.slice(args.indexOf('check-ignore') + 1).join('\n') } : undefined;
    }).run);

    ctx.node = '23.11.0';

    const result = doctor(ctx);

    expect(result).toBe(1);
    expect(printed.filter((line) => /^(problem|behind) /.test(line))).toEqual([
      'problem  watchfaces/mosaic: paf/package.json asks for Node ^22.18.0 || >=24.2.0, and this is 23.11.0. Outside it a tool can stop partway, or stop before it starts, so run paf from a Node inside it, or run paf sync if its pin moved since the last one',
    ]);
  });

  /** A unit on a local framework made doctor fail for as long as the paf use local loop was in use, though nothing was wrong. */
  test('notes a unit on a local framework rather than calling it a problem', () => {
    const root = makeTree({
      'watchfaces/mosaic/paf.config.json': JSON.stringify({ framework: 'v4.1.0', commit: 'a'.repeat(40) }),
      'watchfaces/mosaic/paf/.paf.json': JSON.stringify({ commit: 'a'.repeat(40), local: '/work/pebble-app-framework', hash: 'x' }),
      'watchfaces/mosaic/package.json': '{ "workspaces": ["paf", "paf/plugins/*"] }',
    });
    // git check-ignore prints back each folder that is ignored, and here all of them are
    const { ctx, printed } = makeContext(root, fakeRunner((command, args) => {
      if (command === 'pebble') {
        return { code: 1 };
      }

      return args.includes('check-ignore') ? { stdout: args.slice(args.indexOf('check-ignore') + 1).join('\n') } : undefined;
    }).run);

    const result = doctor(ctx);

    expect(result).toBe(0);
    expect(printed.find((line) => line.includes('watchfaces/mosaic') && !line.includes('.github'))).toMatch(/^note /);
  });

  /** One check-ignore call serves every unit, so each folder has to be matched in what git prints back. */
  test('names the one folder git does not report as ignored', () => {
    const root = makeTree({ 'watchfaces/mosaic/paf.config.json': JSON.stringify({ framework: 'v4.1.0', commit: 'a'.repeat(40) }) });
    const { ctx, printed } = makeContext(root, fakeRunner((command, args) => {
      if (command === 'pebble') {
        return { code: 1 };
      }

      return args.includes('check-ignore') ? { stdout: args.slice(args.indexOf('check-ignore') + 1).filter((folder) => !folder.includes('targets')).join('\n') } : undefined;
    }).run);

    doctor(ctx);

    expect(printed.filter((line) => line.includes('is not gitignored'))).toEqual([
      'problem  watchfaces/mosaic/targets is not gitignored, so build output and paf\'s build record could be committed',
    ]);
  });

  /** A unit pulled to a new pin before a sync still holds the old framework, and its toolchain was shown as the new tag's. */
  test('shows each toolchain under the tag its paf/ holds', () => {
    const toolchain = (sdk: string) => JSON.stringify({ format: 1, sdk, pebbleTool: '5.0.40', node: 24 });
    const root = makeTree({
      'watchfaces/alpha/paf.config.json': JSON.stringify({ framework: 'v4.2.0', commit: 'a'.repeat(40) }),
      'watchfaces/alpha/paf/.paf.json': JSON.stringify({ commit: 'a'.repeat(40), tag: 'v4.2.0' }),
      'watchfaces/alpha/paf/toolchain.json': toolchain('4.40.0'),
      'watchfaces/beta/paf.config.json': JSON.stringify({ framework: 'v4.2.0', commit: 'a'.repeat(40) }),
      'watchfaces/beta/paf/.paf.json': JSON.stringify({ commit: 'b'.repeat(40), tag: 'v4.1.0' }),
      'watchfaces/beta/paf/toolchain.json': toolchain('4.33.1'),
    });
    const { ctx, printed } = makeContext(root, fakeRunner((command) => (command === 'pebble' ? { code: 1 } : undefined)).run);

    status(ctx);

    expect(printed.at(-1)).toBe('toolchain: no pebble here. v4.2.0 was built with 4.40.0, v4.1.0 was built with 4.33.1');
  });

  /** A toolchain.json paf cannot read went unreported whenever pebble was not on the PATH, so doctor passed a broken unit. */
  test('reports an unreadable toolchain without a pebble to compare it with', () => {
    const root = makeTree({
      'watchfaces/mosaic/paf.config.json': JSON.stringify({ framework: 'v4.1.0', commit: 'a'.repeat(40) }),
      'watchfaces/mosaic/paf/toolchain.json': '{ "format": 2 }',
    });
    const { ctx, printed } = makeContext(root, fakeRunner((command, args) => {
      if (command === 'pebble') {
        return { code: 1 };
      }

      return args.includes('check-ignore') ? { stdout: args.slice(args.indexOf('check-ignore') + 1).join('\n') } : undefined;
    }).run);

    const result = doctor(ctx);

    expect(result).toBe(1);
    expect(printed.some((line) => line.startsWith('problem') && line.includes('toolchain.json'))).toBe(true);
  });

  /** A stopped swap leaves a whole framework copy in paf.paf-old, and a unit that does not ignore it could commit hundreds of files. */
  test('names a unit whose swap folders are not gitignored', () => {
    const root = makeTree({ 'watchfaces/mosaic/paf.config.json': JSON.stringify({ framework: 'v4.1.0', commit: 'a'.repeat(40) }) });
    const { ctx, printed } = makeContext(root, fakeRunner((command, args) => {
      if (command === 'pebble') {
        return { code: 1 };
      }

      return args.includes('check-ignore') ? { stdout: args.slice(args.indexOf('check-ignore') + 1).filter((folder) => !folder.includes('paf.paf-')).join('\n') } : undefined;
    }).run);

    doctor(ctx);

    expect(printed.filter((line) => line.includes('is not gitignored'))).toEqual([
      'problem  watchfaces/mosaic/paf.paf-*/ is not gitignored, so a framework copy a stopped swap leaves could be committed',
    ]);
  });
});
