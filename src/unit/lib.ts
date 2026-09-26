/**
 * Filling a unit's lib/ with the framework.
 *
 * lib/ holds the files the framework ships at the unit's tag and nothing else, with no git inside it,
 * so an editor or a tool opening it can never act on another checkout. A stamp inside it records what
 * it holds, so a sync that finds it current writes nothing.
 *
 * lib/ is built beside the old one and swapped in whole, so a sync stopped halfway leaves a whole
 * framework in lib/ or one beside it rather than half of each.
 */
import fs from 'node:fs';
import path from 'node:path';
import { exportTree, listFiles, showFile } from '../framework/mirror.ts';
import { shipPathspecs } from '../framework/ship.ts';
import { sha256 } from '../shared/hash.ts';
import { must, type Runner } from '../shared/runner.ts';

/** The stamp's name inside lib/. */
export const LIB_STAMP = '.paf-lib.json';

/**
 * What a unit's lib/ holds: a commit, the tag it came from, or the local clone it was copied out of and
 * a hash of what was copied, since a clone's working tree changes without its commit moving.
 */
export type LibStamp = {
  commit: string;
  tag?: string;
  local?: string;
  hash?: string;
};

// what the waf build reads at configure time from lib/: its helpers, the wscript template, and the
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
 * would slow the paf use local loop for nothing.
 *
 * @param unitDir The unit's folder.
 * @return The tag's commit, or the clone and a hash of what configure reads, or empty for no lib/.
 */
export function configureIdentity(unitDir: string): string {
  const stamp = readStamp(unitDir);

  if (!stamp) {
    return '';
  }

  if (!stamp.local) {
    return stamp.commit;
  }

  const lib = path.join(unitDir, 'lib');
  const files = CONFIGURE_INPUTS.flatMap((input) => filesUnder(path.join(lib, input)));

  return `${stamp.local} as ${sha256(files.flatMap((file) => [path.relative(lib, file), fs.readFileSync(file)]), 16)}`;
}

/**
 * A hash of the framework's package.json in a unit's lib/, which is all of lib/ that npm reads. The
 * install records it, so a new framework's dependencies are installed and a code edit costs nothing.
 *
 * @param unitDir The unit's folder.
 * @return The hash, or empty when lib/ has no package.json.
 */
export function frameworkPackageHash(unitDir: string): string {
  const file = path.join(unitDir, 'lib', 'package.json');

  return fs.existsSync(file) ? sha256(fs.readFileSync(file), 16) : '';
}

/**
 * The error for a lib/ paf did not fill, or null when paf can replace it.
 *
 * A lib/ with no stamp and something in it, such as the git submodule a repo mounted before it moved to
 * units, can hold work nobody has committed, so it is left for its owner to remove.
 *
 * @param unitDir The unit's folder.
 * @return The error, or null.
 */
export function foreignLib(unitDir: string): Error | null {
  const lib = path.join(unitDir, 'lib');

  if (fs.existsSync(lib) && !fs.existsSync(path.join(lib, LIB_STAMP)) && fs.readdirSync(lib).length > 0) {
    return new Error(`${lib} holds a framework paf did not put there. Remove it first, with git rm lib for a submodule`);
  }

  return null;
}

/**
 * Writes what a folder filled as lib/ holds.
 *
 * @param libDir The lib/ folder, or the one being filled to become it.
 * @param stamp What it holds.
 */
export function writeStamp(libDir: string, stamp: LibStamp): void {
  fs.writeFileSync(path.join(libDir, LIB_STAMP), JSON.stringify(stamp, null, 2) + '\n');
}

/**
 * Reads what a unit's lib/ holds.
 *
 * @param unitDir The unit's folder.
 * @return The stamp, or null when lib/ is missing or was not filled by paf.
 */
export function readStamp(unitDir: string): LibStamp | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(unitDir, 'lib', LIB_STAMP), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Fills a fresh folder beside lib/, then swaps it in for the old one.
 *
 * The old lib/ is renamed aside before the new one is renamed in, and only deleted after. A rename is
 * one step where a delete is many, so a sync stopped at any point, or a delete that an open file on
 * Windows stops partway, leaves a whole framework in lib/ or one beside it rather than half of one.
 */
function replaceLib(unitDir: string, fill: (dest: string) => void, stamp: LibStamp): void {
  const lib = path.join(unitDir, 'lib');
  const next = path.join(unitDir, 'lib.paf-new');
  const old = path.join(unitDir, 'lib.paf-old');


  // the commands check this before they change anything, and this is the last guard before a delete
  const foreign = foreignLib(unitDir);

  if (foreign) {
    throw foreign;
  }

  fs.rmSync(next, { recursive: true, force: true });
  fs.rmSync(old, { recursive: true, force: true });
  fill(next);
  writeStamp(next, stamp);

  if (fs.existsSync(lib)) {
    fs.renameSync(lib, old);
  }

  // npm nests the framework's own dependencies in lib/node_modules when they clash with the unit's.
  // they belong to the install, not the framework copy, so they move across once the old lib/ is aside,
  // and a rename that fails leaves them where they were
  if (fs.existsSync(path.join(old, 'node_modules'))) {
    fs.renameSync(path.join(old, 'node_modules'), path.join(next, 'node_modules'));
  }

  fs.renameSync(next, lib);

  // the swap is done by now, so an old copy Windows will not let go of yet is left for doctor to name,
  // rather than failing a sync that worked
  try {
    fs.rmSync(old, { recursive: true, force: true });
  } catch {
    // doctor reports a lib.paf-old left beside a whole lib/
  }
}

/** The `files` list a framework package.json carries, or undefined when it has none. */
function filesList(packageJson: string | null): string[] | undefined {
  if (!packageJson) {
    return undefined;
  }

  const files = JSON.parse(packageJson).files;

  return Array.isArray(files) ? files : undefined;
}

/**
 * Fills a unit's lib/ with what the framework ships at a commit.
 *
 * @param run The runner.
 * @param mirror The mirror's folder.
 * @param unitDir The unit's folder.
 * @param tag The tag the commit came from.
 * @param commit The commit.
 * @return How many files lib/ holds.
 */
export function fillFromTag(run: Runner, mirror: string, unitDir: string, tag: string, commit: string): number {
  const pathspecs = shipPathspecs(filesList(showFile(run, mirror, commit, 'package.json')), listFiles(run, mirror, commit));
  let count = 0;

  replaceLib(unitDir, (dest) => {
    count = exportTree(run, mirror, commit, pathspecs, dest);
  }, { commit, tag });

  return count;
}

/**
 * Fills a unit's lib/ from a local framework clone's working tree, uncommitted edits included, for
 * building a face against framework work that is not tagged yet.
 *
 * Every sync copies the clone again, so an edit made in it since reaches the next build. The copy is
 * hashed first, and a lib/ that already holds the same files is left as it is, so its stamp, and the
 * build that records it, only change when the framework does.
 *
 * @param run The runner.
 * @param clone The local framework clone.
 * @param unitDir The unit's folder.
 * @return The commit the clone sits on, how many files lib/ holds, and whether they changed.
 */
export function fillFromClone(run: Runner, clone: string, unitDir: string): { commit: string; count: number; changed: boolean } {
  const source = path.resolve(clone);
  const commit = must(run, 'git', ['-C', source, 'rev-parse', 'HEAD'], { cwd: source, capture: true });
  // one listing of the clone with the ship pathspecs, so git reads them the same way it does for a tag.
  // -z gives each name as it is, where a plain list quotes one with unusual characters in it, and a file
  // both cached and changed is listed twice
  const packageJson = fs.existsSync(path.join(source, 'package.json')) ? fs.readFileSync(path.join(source, 'package.json'), 'utf8') : null;
  const listed = must(run, 'git', ['-C', source, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...shipPathspecs(filesList(packageJson), null)], { cwd: source, capture: true })
    .split('\0')
    .filter(Boolean);
  const files = [...new Set(listed)]
    // a file deleted but not yet committed is still listed as cached, and an untracked git repo inside
    // the clone is listed as its folder, so only what is a file now is copied
    .filter((file) => fs.statSync(path.join(source, file), { throwIfNoEntry: false })?.isFile());

  const hash = sha256(files.flatMap((file) => [file, fs.readFileSync(path.join(source, file))]), 16);
  const stamp = readStamp(unitDir);

  if (stamp?.local === source && stamp.commit === commit && stamp.hash === hash) {
    return { commit, count: files.length, changed: false };
  }

  replaceLib(unitDir, (dest) => {
    for (const file of files) {
      fs.mkdirSync(path.dirname(path.join(dest, file)), { recursive: true });
      fs.copyFileSync(path.join(source, file), path.join(dest, file));
    }
  }, { commit, local: source, hash });

  return { commit, count: files.length, changed: true };
}
