/**
 * Filling a unit's paf/ with the framework.
 *
 * paf/ holds what the framework ships at the unit's tag, which is its src/ folder less the specs, their
 * fixtures, and the plugins the unit does not list, with no git inside it, so an editor or a tool
 * opening it can never act on another checkout. A stamp inside it records what it holds, so a sync that
 * finds it current writes nothing.
 *
 * paf/ is built beside the old one and swapped in whole, so a sync stopped halfway leaves a whole
 * framework in paf/ or one beside it rather than half of each.
 */
import fs from 'node:fs';
import path from 'node:path';
import { exportTree, listFolders } from '../framework/mirror.ts';
import { BASE_PATHSPECS, PLUGINS_DIR, SHIP_ROOT, shipPathspecs } from '../framework/ship.ts';
import { messageOf } from '../shared/errors.ts';
import { sha256 } from '../shared/hash.ts';
import { must, type Runner } from '../shared/runner.ts';
import { readConfig, readConfigIfSet, readPlugins, type UnitConfig } from './config.ts';
import { markInstallStale } from './install.ts';

/** The folder in a unit that holds its framework. */
export const FRAMEWORK_DIR = 'paf';

/** The stamp's name inside paf/. */
export const FRAMEWORK_STAMP = '.paf.json';

/**
 * What a unit's paf/ holds: a commit, the tag it came from, or the local clone it was copied out of and
 * a hash of what was copied, since a clone's working tree changes without its commit moving, and the
 * plugins it was filled with, since a unit that lists another plugin needs filling again at the same tag.
 */
export type FrameworkStamp = {
  commit: string;
  tag?: string;
  local?: string;
  hash?: string;
  plugins?: string[];
};

/**
 * Whether paf/ holds the plugins a unit lists.
 *
 * @param stamp What paf/ holds.
 * @param listed The plugins the unit lists.
 * @return True when the two are the same set.
 */
export function holdsPlugins(stamp: FrameworkStamp, listed: string[]): boolean {
  return [...(stamp.plugins ?? [])].sort().join(',') === [...listed].sort().join(',');
}

// what the waf build reads at configure time from paf/: its helpers, the wscript template, and the
// package.json the sandbox's manifest is made from
const CONFIGURE_INPUTS = ['py', path.join('tools', 'waf'), 'package.json'];

/** Every file under a path, itself when it is a file, sorted so the order never changes a hash. */
function filesUnder(target: string): string[] {
  const stat = fs.statSync(target, { throwIfNoEntry: false });

  if (!stat) {
    return [];
  }

  if (stat.isFile()) {
    return [target];
  }

  return fs.readdirSync(target).sort().flatMap((name) => filesUnder(path.join(target, name)));
}

/**
 * One string naming what a build of this unit configured from, which changes when a clean build is
 * needed. A tag's commit covers everything. On a local framework only the files configure reads count,
 * since an edit to the framework's C or TypeScript builds incrementally and a clean build each time
 * would slow the paf use local loop for nothing. A plugin's C is staged into the build, so the plugins
 * paf/ holds are part of it too.
 *
 * @param unitDir The unit's folder.
 * @return The tag's commit, or the clone and a hash of what configure reads, with the plugins, or empty for no paf/.
 */
export function configureIdentity(unitDir: string): string {
  const stamp = readStamp(unitDir);

  if (!stamp) {
    return '';
  }

  const plugins = [...(stamp.plugins ?? [])].sort().join(',');

  if (!stamp.local) {
    return `${stamp.commit} with ${plugins}`;
  }

  const framework = path.join(unitDir, FRAMEWORK_DIR);
  const files = CONFIGURE_INPUTS.flatMap((input) => filesUnder(path.join(framework, input)));

  return `${stamp.local} as ${sha256(files.flatMap((file) => [path.relative(framework, file), fs.readFileSync(file)]), 16)} with ${plugins}`;
}

/**
 * The folders in a unit's paf/ that npm installs as workspaces: paf/ itself and each plugin in it.
 *
 * @param unitDir The unit's folder.
 * @return Each folder's full path, paf/ first and the plugins by name.
 */
export function workspaceFolders(unitDir: string): string[] {
  const framework = path.join(unitDir, FRAMEWORK_DIR);
  const plugins = path.join(framework, 'plugins');
  const names = fs.existsSync(plugins) ? fs.readdirSync(plugins, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort() : [];

  return [framework, ...names.map((name) => path.join(plugins, name))];
}

/**
 * A hash of every package.json in a unit's paf/ that npm installs from, the framework's and each
 * plugin's, which is all of paf/ that npm reads. The install records it, so a new framework's
 * dependencies, or a plugin listed or dropped, are installed, and a code edit costs nothing.
 *
 * @param unitDir The unit's folder.
 * @return The hash, or empty when paf/ has no package.json.
 */
export function frameworkPackageHash(unitDir: string): string {
  const framework = path.join(unitDir, FRAMEWORK_DIR);

  if (!fs.existsSync(path.join(framework, 'package.json'))) {
    return '';
  }

  // each package.json goes in after its path, so moving one to another plugin changes the hash too
  const pieces = workspaceFolders(unitDir)
    .map((folder) => path.join(folder, 'package.json'))
    .filter((file) => fs.existsSync(file))
    .flatMap((file) => [path.relative(framework, file).split(path.sep).join('/'), fs.readFileSync(file)]);

  return sha256(pieces, 16);
}

/**
 * The error for a paf/ paf did not fill, or null when paf can replace it.
 *
 * A paf/ with no stamp and something in it, such as a git submodule mounted there by hand, can hold
 * work nobody has committed, so it is left for its owner to remove.
 *
 * @param unitDir The unit's folder.
 * @return The error, or null.
 */
export function foreignFramework(unitDir: string): Error | null {
  const framework = path.join(unitDir, FRAMEWORK_DIR);

  if (fs.existsSync(framework) && !fs.existsSync(path.join(framework, FRAMEWORK_STAMP)) && fs.readdirSync(framework).length > 0) {
    return new Error(`${framework} holds a framework paf did not put there. Remove it first, with git rm ${FRAMEWORK_DIR} for a submodule`);
  }

  return null;
}

/**
 * Writes what a folder filled as paf/ holds.
 *
 * @param frameworkDir The paf/ folder, or the one being filled to become it.
 * @param stamp What it holds.
 */
export function writeStamp(frameworkDir: string, stamp: FrameworkStamp): void {
  fs.writeFileSync(path.join(frameworkDir, FRAMEWORK_STAMP), JSON.stringify(stamp, null, 2) + '\n');
}

/**
 * Reads what a unit's paf/ holds.
 *
 * @param unitDir The unit's folder.
 * @return The stamp, or null when paf/ is missing or was not filled by paf.
 */
export function readStamp(unitDir: string): FrameworkStamp | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(unitDir, FRAMEWORK_DIR, FRAMEWORK_STAMP), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * What a unit builds from: what its paf/ holds, its paf.config.json, and the plugins it lists. A unit
 * read as local builds from its clone and may have no pin, and any other unit has a pin this paf fills.
 */
export type UnitFramework =
  | { local: true; stamp: FrameworkStamp & { local: string }; config: UnitConfig | null; plugins: string[] }
  | { local: false; stamp: FrameworkStamp | null; config: UnitConfig; plugins: string[] };

/**
 * Reads what a unit builds from, the one place that decides how strictly its pin is read.
 *
 * A unit on a local framework builds from its clone whatever it pins, so its file is read without
 * refusing the pin, which still reports a file that cannot be read. Any other unit's pin has to be one
 * this paf fills, and so does a local unit's being put back on its tag. A pin that cannot be filled
 * stops here, before anything asks the mirror.
 *
 * @param unitDir The unit's folder.
 * @param repin Whether a local unit is being put back on its tag, which reads its pin strictly too.
 * @return What the unit builds from, read as local only for a local unit that is not being put back.
 */
export function unitFramework(unitDir: string, repin = false): UnitFramework {
  const stamp = readStamp(unitDir);

  if (stamp?.local && !repin) {
    const config = readConfigIfSet(unitDir);

    // a local unit may have no pin yet, and its plugins are still listed
    return { local: true, stamp: { ...stamp, local: stamp.local }, config, plugins: config ? Object.keys(config.plugins) : readPlugins(unitDir) };
  }

  const config = readConfig(unitDir);

  return { local: false, stamp, config, plugins: Object.keys(config.plugins) };
}

/**
 * Whether a folder holds a framework 4 clone, whose src/package.json names pebble-app-framework. The
 * root package.json is the repo the framework is developed in, and a framework 3 checkout has no src/.
 *
 * @param source The folder.
 * @return Whether it does.
 */
export function isFrameworkClone(source: string): boolean {
  try {
    return JSON.parse(fs.readFileSync(path.join(source, SHIP_ROOT, 'package.json'), 'utf8')).name === 'pebble-app-framework';
  } catch {
    return false;
  }
}

/**
 * Moves each nested install from the old copy into the same folder of paf/, for paf/ and each plugin
 * paf/ still has. A plugin paf/ no longer has keeps its install in the old copy, which goes with it.
 */
function carryNestedInstalls(unitDir: string): void {
  const framework = path.join(unitDir, FRAMEWORK_DIR);
  const old = path.join(unitDir, `${FRAMEWORK_DIR}.paf-old`);

  for (const folder of workspaceFolders(unitDir)) {
    const from = path.join(old, path.relative(framework, folder), 'node_modules');

    if (fs.existsSync(from)) {
      fs.renameSync(from, path.join(folder, 'node_modules'));
    }
  }
}

/**
 * Whether a unit has an old copy left beside paf/ by an earlier swap, which stopped partway or could
 * not delete it. Nested installs are only ever carried out of the old copy, so it is the one that can
 * have taken them with it.
 *
 * @param unitDir The unit's folder.
 * @return Whether paf.paf-old is there.
 */
export function hasOldCopy(unitDir: string): boolean {
  return fs.existsSync(path.join(unitDir, `${FRAMEWORK_DIR}.paf-old`));
}

/**
 * Deletes the copies an earlier swap left beside paf/, as far as nothing is holding them.
 *
 * @param unitDir The unit's folder.
 */
export function clearSwapLeftovers(unitDir: string): void {
  for (const name of [`${FRAMEWORK_DIR}.paf-new`, `${FRAMEWORK_DIR}.paf-old`]) {
    try {
      fs.rmSync(path.join(unitDir, name), { recursive: true, force: true });
    } catch {
      // doctor names a leftover that stays
    }
  }
}

/**
 * Fills a fresh folder beside paf/, then swaps it in for the old one.
 *
 * The old paf/ is renamed aside before the new one is renamed in, and only deleted after. A rename is
 * one step where a delete is many, so a sync stopped at any point, or a delete that an open file on
 * Windows stops partway, leaves a whole framework in paf/ or one beside it rather than half of one.
 *
 * npm nests a package under the workspace that asked for it when its version clashes with the unit's,
 * in paf/node_modules or a plugin's node_modules. Those belong to the install rather than the copy, so
 * they move into the new paf/ once it is in place, to save an install. Nothing depends on the move
 * working: a leftover copy from an earlier swap, or a move that fails, such as on a native build Windows
 * is holding, marks the install stale, and the next npm install puts back whatever did not arrive. They
 * only come from the paf/ this swap moved aside. A leftover it could not clear may be half deleted, and
 * npm takes a package whose package.json survived as installed whatever else is missing.
 */
function replaceFramework(unitDir: string, fill: (dest: string) => void, stamp: FrameworkStamp): void {
  const framework = path.join(unitDir, FRAMEWORK_DIR);
  const next = path.join(unitDir, `${FRAMEWORK_DIR}.paf-new`);
  const old = path.join(unitDir, `${FRAMEWORK_DIR}.paf-old`);

  // the commands check this before they change anything, and this is the last guard before a delete
  const foreign = foreignFramework(unitDir);

  if (foreign) {
    throw foreign;
  }

  if (hasOldCopy(unitDir)) {
    markInstallStale(unitDir);
  }

  fs.rmSync(next, { recursive: true, force: true });

  // the old copy's place is needed when paf/ is renamed aside, so one Windows is holding stops here,
  // before the fill rather than after it. with no paf/ nothing goes there, and the fill can go ahead
  try {
    fs.rmSync(old, { recursive: true, force: true });
  } catch (error) {
    if (fs.existsSync(framework)) {
      throw new Error(`${old} is left from an earlier swap and could not be removed, and this one needs its place. Close whatever has a file open in it, then sync again. ${messageOf(error)}`, { cause: error });
    }
  }

  fill(next);
  writeStamp(next, stamp);

  const movedAside = fs.existsSync(framework);

  if (movedAside) {
    fs.renameSync(framework, old);
  }

  fs.renameSync(next, framework);

  try {
    if (movedAside) {
      carryNestedInstalls(unitDir);
    }
  } catch {
    markInstallStale(unitDir);
  }

  // the swap is done by now, so an old copy Windows will not let go of yet is left for doctor to name,
  // rather than failing a sync that worked
  try {
    fs.rmSync(old, { recursive: true, force: true });
  } catch {
    // doctor reports a paf.paf-old left beside a whole paf/
  }
}

/**
 * Fills a unit's paf/ with what the framework ships at a commit.
 *
 * @param run The runner.
 * @param mirror The mirror's folder.
 * @param unitDir The unit's folder.
 * @param tag The tag the commit came from.
 * @param commit The commit.
 * @param plugins The plugins the unit lists.
 * @return How many files paf/ holds.
 */
export function fillFromTag(run: Runner, mirror: string, unitDir: string, tag: string, commit: string, plugins: string[]): number {
  const pathspecs = shipPathspecs(plugins, listFolders(run, mirror, commit, PLUGINS_DIR), tag);
  let count = 0;

  // the restore reads the tag's src/ tree, so what ships lands at the top of paf/ as it is named there
  replaceFramework(unitDir, (dest) => {
    count = exportTree(run, mirror, `${commit}:${SHIP_ROOT}`, pathspecs, dest);
  }, { commit, tag, plugins: [...plugins].sort() });

  return count;
}

/**
 * Fills a unit's paf/ from a local framework clone's working tree, uncommitted edits included, for
 * building a face against framework work that is not tagged yet.
 *
 * Every sync copies the clone again, so an edit made in it since reaches the next build. The copy is
 * hashed first, and a paf/ that already holds the same files is left as it is, so its stamp, and the
 * build that records it, only change when the framework does. git lists the clone's src/ folder, so the
 * names are paf/'s already, and a unit filled from a tag and one filled from the same commit's clone hold
 * the same files under the same names. The plugins the clone offers come from that listing too, the way
 * a tag's come from its tree, so a folder left on disk by another branch is never taken for one.
 *
 * @param run The runner.
 * @param clone The local framework clone.
 * @param unitDir The unit's folder.
 * @param plugins The plugins the unit lists.
 * @return The commit the clone sits on, how many files paf/ holds, and whether they changed.
 */
export function fillFromClone(run: Runner, clone: string, unitDir: string, plugins: string[]): { commit: string; count: number; changed: boolean } {
  const source = path.resolve(clone);
  const commit = must(run, 'git', ['-C', source, 'rev-parse', 'HEAD'], { cwd: source, capture: true });
  const root = path.join(source, SHIP_ROOT);
  // one listing of the clone's src/ with the pathspecs every unit gets. -z gives each name as it is, where
  // a plain list quotes one with unusual characters in it, and an unmerged file is listed once per stage
  const listed = must(run, 'git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...BASE_PATHSPECS], { cwd: root, capture: true })
    .split('\0')
    .filter(Boolean);
  const present = [...new Set(listed)]
    // a file deleted but not yet committed is still listed as cached, and an untracked git repo inside
    // the clone is listed as its folder, so only what is a file now counts
    .filter((file) => fs.statSync(path.join(root, file), { throwIfNoEntry: false })?.isFile());
  // a plugin is a folder under plugins/ with a file in it now, the way a tag's are the folders in its
  // tree, so a plugin deleted in the working tree is not offered and a file straight in plugins/ is none
  const pluginOf = (file: string) => (file.startsWith('plugins/') && file.split('/').length > 2 ? file.split('/')[1] : null);
  const offered = [...new Set(present.map(pluginOf).filter((name) => name !== null))];

  // refuses a listed plugin the clone does not have, the same as a tag
  shipPathspecs(plugins, offered, `the clone at ${source}`);

  const files = present.filter((file) => {
    const plugin = pluginOf(file);

    return plugin === null || plugins.includes(plugin);
  });

  const hash = sha256(files.flatMap((file) => [file, fs.readFileSync(path.join(root, file))]), 16);
  const stamp = readStamp(unitDir);

  if (stamp?.local === source && stamp.commit === commit && stamp.hash === hash) {
    return { commit, count: files.length, changed: false };
  }

  replaceFramework(unitDir, (dest) => {
    for (const file of files) {
      fs.mkdirSync(path.dirname(path.join(dest, file)), { recursive: true });
      fs.copyFileSync(path.join(root, file), path.join(dest, file));
    }
  }, { commit, local: source, hash, plugins: [...plugins].sort() });

  return { commit, count: files.length, changed: true };
}
