/**
 * Specs for the SDK verdict and the workflow check in paf doctor, and the unit state paf status shows.
 *
 * The SDK verdict is what tells someone their SDK is behind the framework. The rule worth pinning is
 * that being ahead never fails, since a unit left on an old tag would otherwise nag forever once the
 * SDK moved on. A unit that cannot be read is reported on its own row, so it never hides the others.
 */
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { fakeRunner, makeContext, makeTree } from '../testing/tree.ts';
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
    const result = workflowActionTags('uses: AKlitbo/pebble-app-framework/.github/actions/setup-pebble@v3.0.0\nuses: actions/checkout@v7');

    expect(result).toEqual(['v3.0.0']);
  });
});

describe('unitState', () => {
  /** One unit with a broken paf.json stopped paf status before its table, so no other unit was shown either. */
  test('reports a unit it cannot read as a problem rather than throwing', () => {
    const root = makeTree({ 'watchfaces/mosaic/paf.json': '{ not json' });
    const { ctx } = makeContext(root, fakeRunner().run);

    const result = unitState(ctx, { dir: path.join(root, 'watchfaces', 'mosaic'), rel: 'watchfaces/mosaic', name: 'mosaic', where: 'watchfaces/mosaic' });

    expect(result).toMatch(/^problem: .*paf\.json could not be read/);
  });
});

describe('doctor', () => {
  /** A unit on a local framework made doctor fail for as long as the paf use local loop was in use, though nothing was wrong. */
  test('notes a unit on a local framework rather than calling it a problem', () => {
    const root = makeTree({
      'watchfaces/mosaic/paf.json': JSON.stringify({ framework: 'v3.0.0', commit: 'a'.repeat(40) }),
      'watchfaces/mosaic/lib/.paf-lib.json': JSON.stringify({ commit: 'a'.repeat(40), local: '/work/pebble-app-framework', hash: 'x' }),
    });
    // git check-ignore prints back each folder that is ignored, and here all of them are
    const { ctx, printed } = makeContext(root, fakeRunner((command, args) => {
      if (command === 'pebble') {
        return { code: 1 };
      }

      return args.includes('check-ignore') ? { stdout: args.slice(args.indexOf('check-ignore') + 1).join('\n') } : undefined;
    }).run);

    doctor(ctx);

    expect(printed.find((line) => line.includes('watchfaces/mosaic') && !line.includes('.github'))).toMatch(/^note /);
  });

  /** One check-ignore call serves every unit, so each folder has to be matched in what git prints back. */
  test('names the one folder git does not report as ignored', () => {
    const root = makeTree({ 'watchfaces/mosaic/paf.json': JSON.stringify({ framework: 'v3.0.0', commit: 'a'.repeat(40) }) });
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
  test('shows each toolchain under the tag its lib/ holds', () => {
    const toolchain = (sdk: string) => JSON.stringify({ format: 1, sdk, pebbleTool: '5.0.40', node: 24 });
    const root = makeTree({
      'watchfaces/alpha/paf.json': JSON.stringify({ framework: 'v3.1.0', commit: 'a'.repeat(40) }),
      'watchfaces/alpha/lib/.paf-lib.json': JSON.stringify({ commit: 'a'.repeat(40), tag: 'v3.1.0' }),
      'watchfaces/alpha/lib/project/toolchain.json': toolchain('4.40.0'),
      'watchfaces/beta/paf.json': JSON.stringify({ framework: 'v3.1.0', commit: 'a'.repeat(40) }),
      'watchfaces/beta/lib/.paf-lib.json': JSON.stringify({ commit: 'b'.repeat(40), tag: 'v3.0.0' }),
      'watchfaces/beta/lib/project/toolchain.json': toolchain('4.33.1'),
    });
    const { ctx, printed } = makeContext(root, fakeRunner((command) => (command === 'pebble' ? { code: 1 } : undefined)).run);

    status(ctx);

    expect(printed.at(-1)).toBe('toolchain: no pebble here. v3.1.0 was built with 4.40.0, v3.0.0 was built with 4.33.1');
  });

  /** A toolchain.json paf cannot read went unreported whenever pebble was not on the PATH, so doctor passed a broken unit. */
  test('reports an unreadable toolchain without a pebble to compare it with', () => {
    const root = makeTree({
      'watchfaces/mosaic/paf.json': JSON.stringify({ framework: 'v3.0.0', commit: 'a'.repeat(40) }),
      'watchfaces/mosaic/lib/project/toolchain.json': '{ "format": 2 }',
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

  /** A stopped swap leaves a whole framework copy in lib.paf-old, and a unit that does not ignore it could commit hundreds of files. */
  test('names a unit whose swap folders are not gitignored', () => {
    const root = makeTree({ 'watchfaces/mosaic/paf.json': JSON.stringify({ framework: 'v3.0.0', commit: 'a'.repeat(40) }) });
    const { ctx, printed } = makeContext(root, fakeRunner((command, args) => {
      if (command === 'pebble') {
        return { code: 1 };
      }

      return args.includes('check-ignore') ? { stdout: args.slice(args.indexOf('check-ignore') + 1).filter((folder) => !folder.includes('lib.paf-')).join('\n') } : undefined;
    }).run);

    doctor(ctx);

    expect(printed.filter((line) => line.includes('is not gitignored'))).toEqual([
      'problem  watchfaces/mosaic/lib.paf-*/ is not gitignored, so a framework copy a stopped swap leaves could be committed',
    ]);
  });
});
