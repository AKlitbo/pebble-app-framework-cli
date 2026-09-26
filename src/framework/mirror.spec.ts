/**
 * Specs for keeping the framework mirror.
 *
 * Every command that fills a lib/ goes through the mirror, so a mirror that cannot recover stops paf
 * everywhere. The cases worth pinning are a clone that was stopped partway, each place the framework
 * comes from getting a mirror of its own, and files coming out with the endings they were committed with.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { fakeRunner, makeContext, makeTree } from '../testing/tree.ts';
import { spawnRunner } from '../shared/runner.ts';
import { exportTree, mirrorOf, updateMirror } from './mirror.ts';

describe('updateMirror', () => {
  /** A clone killed partway left a folder with no HEAD, and git refused to clone into it again, so every sync failed from then on. */
  test('clears a folder a stopped clone left before cloning again', () => {
    const cache = makeTree({ 'mirror-abc.git/objects/pack/partial.pack': 'half a download' });
    const mirror = path.join(cache, 'mirror-abc.git');
    const leftBehind: boolean[] = [];
    const { run } = fakeRunner((command, args) => {
      if (args.includes('clone')) {
        leftBehind.push(fs.existsSync(path.join(mirror, 'objects', 'pack', 'partial.pack')));
      }

      return undefined;
    });

    updateMirror(run, mirror, 'https://github.com/AKlitbo/pebble-app-framework.git');

    expect(leftBehind).toEqual([false]);
  });
});

describe('mirrorOf', () => {
  /** Two sources sharing one mirror each pruned the other's tags, so a local-only candidate tag vanished on the next GitHub fetch. */
  test('gives each framework source its own mirror', () => {
    const { ctx } = makeContext(makeTree({}), fakeRunner().run);

    const result = mirrorOf({ ...ctx, repo: '/work/pebble-app-framework' });

    expect(result).not.toBe(mirrorOf({ ...ctx, repo: 'https://github.com/AKlitbo/pebble-app-framework.git' }));
  });
});

describe('exportTree', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /**
   * Git for Windows turns autocrlf on for the whole machine, and a lib/ filled from Windows got build.sh
   * with CRLF endings. bash in WSL then stopped on its first set line, and no sync put it right.
   */
  test('writes files with the endings they were committed with where autocrlf is on', () => {
    const source = makeTree({ 'build.sh': 'set -euo pipefail\necho built\n' });
    const mirror = path.join(makeTree({}), 'mirror.git');
    const dest = path.join(makeTree({}), 'lib');
    const git = (...args: string[]) => spawnRunner('git', ['-c', 'user.name=spec', '-c', 'user.email=spec@example.com', ...args], { cwd: source, capture: true });

    git('init', '-q');
    git('add', 'build.sh');
    git('commit', '-q', '-m', 'build');
    git('clone', '-q', '--bare', source, mirror);
    vi.stubEnv('GIT_CONFIG_COUNT', '1');
    vi.stubEnv('GIT_CONFIG_KEY_0', 'core.autocrlf');
    vi.stubEnv('GIT_CONFIG_VALUE_0', 'true');

    exportTree(spawnRunner, mirror, 'HEAD', ['build.sh'], dest);

    const result = fs.readFileSync(path.join(dest, 'build.sh'), 'utf8');

    expect(result).toBe('set -euo pipefail\necho built\n');
  });
});
