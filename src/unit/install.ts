/**
 * Keeping a unit's node_modules installed from its lock.
 *
 * node_modules holds native binaries for one system, such as sharp's, esbuild's, and Vitest's, so an
 * install made from Windows breaks a build in WSL and the other way round. A stamp inside node_modules
 * records which system installed it, from which lock, and against which framework, and a sync from the
 * other system stops rather than replacing it without a word.
 *
 * paf/ is swapped before the install runs, so the framework's package.json is recorded here too. An
 * install that failed or was stopped after a framework move then reads as stale on the next sync and runs again,
 * where the lock alone, still matching the old install, would call it current.
 */
import fs from 'node:fs';
import path from 'node:path';
import { sha256 } from '../shared/hash.ts';
import { messageOf } from '../shared/errors.ts';

/** The stamp's name inside node_modules/. */
export const INSTALL_STAMP = '.paf-install.json';

export type InstallStamp = {
  platform: string;
  lock: string | null;
  framework?: string;
};

/** Where a unit's install stands against its lock and the system running paf. */
export type InstallState = 'current' | 'missing' | 'stale' | 'other-system';

/**
 * A hash of a unit's package-lock.json, or null when it has none.
 *
 * @param unitDir The unit's folder.
 * @return The hash.
 */
export function lockHash(unitDir: string): string | null {
  const file = path.join(unitDir, 'package-lock.json');

  if (!fs.existsSync(file)) {
    return null;
  }

  return sha256(fs.readFileSync(file));
}

/**
 * The workspaces a unit lists, which is how npm installs the framework's packages and each listed
 * plugin's beside the unit's own. A glob that matches nothing, such as paf/plugins/* in a unit that
 * lists no plugins, installs nothing, so a unit always lists both.
 */
export const FRAMEWORK_WORKSPACES = ['paf', 'paf/plugins/*'];

/** The workspaces line a unit's package.json holds, as a message gives it. */
export const WORKSPACES_LINE = `"workspaces": ${JSON.stringify(FRAMEWORK_WORKSPACES).replace(/,/g, ', ')}`;

/**
 * The framework workspaces a unit's package.json does not list.
 *
 * @param unitDir The unit's folder.
 * @return The missing ones, all of them when there is no package.json. One that cannot be read stops with its error.
 */
export function missingWorkspaces(unitDir: string): string[] {
  const file = path.join(unitDir, 'package.json');
  let listed: string[];

  try {
    const workspaces = JSON.parse(fs.readFileSync(file, 'utf8')).workspaces;
    const entries: unknown[] = Array.isArray(workspaces) ? workspaces : workspaces?.packages ?? [];

    listed = entries.filter((entry) => typeof entry === 'string').map((entry) => entry.replace(/^\.\//, '').replace(/\/+$/, ''));
  } catch (error) {
    // telling the user to add a key to a file that will not parse would send them the wrong way
    if (!fs.existsSync(file)) {
      return [...FRAMEWORK_WORKSPACES];
    }

    throw new Error(`${file} could not be read. ${messageOf(error)}`, { cause: error });
  }

  // npm reads paf/plugins/** the same as paf/plugins/*, since each plugin is one folder down
  return FRAMEWORK_WORKSPACES.filter((workspace) => !listed.includes(workspace) && !(workspace === 'paf/plugins/*' && listed.includes('paf/plugins/**')));
}

/**
 * Reads the install stamp.
 *
 * @param unitDir The unit's folder.
 * @return The stamp, or null when node_modules is missing or paf did not install it.
 */
export function readInstallStamp(unitDir: string): InstallStamp | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(unitDir, 'node_modules', INSTALL_STAMP), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Writes the install stamp.
 *
 * @param unitDir The unit's folder.
 * @param stamp The system and the lock it was installed from.
 */
export function writeInstallStamp(unitDir: string, stamp: InstallStamp): void {
  fs.writeFileSync(path.join(unitDir, 'node_modules', INSTALL_STAMP), JSON.stringify(stamp, null, 2) + '\n');
}

/** What a stale install records for its framework, which no package hash, the empty one included, can equal. */
const STALE = 'stale';

/**
 * Marks a unit's install as needing npm install again, keeping the system it was made on, so the next
 * sync installs rather than calling it current, and one from the other system is still refused.
 *
 * @param unitDir The unit's folder.
 */
export function markInstallStale(unitDir: string): void {
  const stamp = readInstallStamp(unitDir);

  if (stamp) {
    writeInstallStamp(unitDir, { ...stamp, framework: STALE });
  }
}

/**
 * Where a unit's install stands.
 *
 * An install with no stamp was made by hand, so paf cannot tell which system made it and reinstalls.
 *
 * @param hasModules Whether node_modules exists.
 * @param stamp The install stamp, or null.
 * @param platform The system running paf.
 * @param lock The lock's hash.
 * @param framework What paf/ holds now, or undefined to leave it out of the comparison.
 * @return What the install needs.
 */
export function installState(hasModules: boolean, stamp: InstallStamp | null, platform: string, lock: string | null, framework?: string): InstallState {
  if (!hasModules) {
    return 'missing';
  }

  if (!stamp) {
    return 'stale';
  }

  if (stamp.platform !== platform) {
    return 'other-system';
  }

  if (framework !== undefined && stamp.framework !== framework) {
    return 'stale';
  }

  return stamp.lock === lock ? 'current' : 'stale';
}
