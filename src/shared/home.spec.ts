/**
 * Specs for where the mirror fetches the framework from.
 *
 * git runs the clone from the cache and each fetch from inside the mirror, so the path worth pinning is
 * a relative PAF_REPO, which has to mean the folder paf was run from rather than either of those.
 */
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { makeTree } from '../testing/tree.ts';
import { frameworkRepo } from './home.ts';

describe('frameworkRepo', () => {
  /** A relative path reached git as it was, so the clone looked beside the cache and found nothing or the wrong repo. */
  test('makes a relative path to a folder that is there absolute', () => {
    const work = makeTree({ 'pebble-watchfaces/.keep': '', 'pebble-app-framework/.keep': '' });

    const result = frameworkRepo({ PAF_REPO: '../pebble-app-framework' }, path.join(work, 'pebble-watchfaces'));

    expect(result).toBe(path.join(work, 'pebble-app-framework'));
  });

  /** An ssh remote has a colon but no scheme, and resolving it as a path would point the mirror at a folder that is not there. */
  test('leaves an ssh remote alone', () => {
    const result = frameworkRepo({ PAF_REPO: 'git@github.com:AKlitbo/pebble-app-framework.git' }, '/work');

    expect(result).toBe('git@github.com:AKlitbo/pebble-app-framework.git');
  });

  /** A Host alias from ~/.ssh/config has no user, and it was made into a path the clone could never find. */
  test('leaves an ssh host alias alone', () => {
    const result = frameworkRepo({ PAF_REPO: 'gh:AKlitbo/pebble-app-framework.git' }, '/work');

    expect(result).toBe('gh:AKlitbo/pebble-app-framework.git');
  });
});
