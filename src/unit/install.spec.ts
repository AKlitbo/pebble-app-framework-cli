/**
 * Specs for deciding when a unit's node_modules needs installing again.
 *
 * node_modules holds native binaries for one system, so one made from Windows breaks a build in WSL.
 * The decision worth pinning is that an install from the other system stops rather than being
 * replaced quietly, and that a changed lock always reinstalls.
 */
import { describe, expect, test } from 'vitest';
import { makeTree } from '../testing/tree.ts';
import { installState, missingWorkspaces } from './install.ts';

describe('installState', () => {
  /** Replacing the other system's install breaks every build over there, so it is its own state that stops the sync. */
  test('marks an install from the other system', () => {
    const result = installState(true, { platform: 'win32', lock: 'abc' }, 'linux', 'abc');

    expect(result).toBe('other-system');
  });

  /** A lock that moved on without a reinstall leaves node_modules holding the old versions. */
  test('marks an install from an older lock as stale', () => {
    const result = installState(true, { platform: 'linux', lock: 'old' }, 'linux', 'new');

    expect(result).toBe('stale');
  });

  /** An install with no stamp was made by hand, from whichever system, so it cannot be trusted. */
  test('treats an install with no stamp as stale', () => {
    const result = installState(true, null, 'linux', 'abc');

    expect(result).toBe('stale');
  });

  /** A current install is left alone, or every build would reinstall first. */
  test('leaves a current install alone', () => {
    const result = installState(true, { platform: 'linux', lock: 'abc' }, 'linux', 'abc');

    expect(result).toBe('current');
  });

  /** A new framework can bring new dependencies, and an install that never finished for it left them missing. */
  test('marks an install made for another framework as stale', () => {
    const result = installState(true, { platform: 'linux', lock: 'abc', framework: 'old' }, 'linux', 'abc', 'new');

    expect(result).toBe('stale');
  });
});

describe('missingWorkspaces', () => {
  /** A package.json that will not parse was read as missing its workspace, which sent the user to add a key to a broken file. */
  test('names a package.json that cannot be read', () => {
    const root = makeTree({ 'package.json': '{ "workspaces": ["paf", "paf/plugins/*"], }' });

    const result = () => missingWorkspaces(root);

    expect(result).toThrow(/package\.json could not be read/);
  });

  /** A unit moved from ["lib"] by editing one word listed paf alone, and no plugin's packages were ever installed. */
  test('names the plugins workspace a unit listing only paf is missing', () => {
    const root = makeTree({ 'package.json': '{ "workspaces": ["./paf/"] }' });

    const result = missingWorkspaces(root);

    expect(result).toEqual(['paf/plugins/*']);
  });
});
