/**
 * Which of the framework's files a unit's lib/ gets.
 *
 * The framework names them in its package.json `files` list, the usual way a package says what it
 * ships. paf turns that list into git pathspecs, so `git restore` and `git ls-files` take exactly those
 * files from a tag or from a local clone.
 */
import path from 'node:path';

function isGlob(entry: string): boolean {
  return /[*?[]/.test(entry);
}

/**
 * Whether one `files` entry takes a file, the way git reads it as a pathspec: a plain entry takes
 * itself and everything under it, and a glob, given as :(glob), takes only the files it matches.
 * git restore and git ls-files both take `c/*` as the files straight in c/, not the folders under it.
 *
 * Node's glob matching lets no * match a name that starts with a dot, where git's does, so a glob entry
 * that only matches dot files reads as matching nothing and is dropped. This only decides whether an
 * entry is there at all, and git does the taking.
 */
function entryTakes(entry: string, file: string): boolean {
  return isGlob(entry) ? path.posix.matchesGlob(file, entry) : file === entry || file.startsWith(`${entry}/`);
}

/**
 * The pathspecs for a framework's `files` list.
 *
 * An entry is a file, a folder, or a glob, and one starting with ! is a glob of files to leave out. For
 * git restore, an entry the commit does not hold, or a glob that matches nothing there, is dropped,
 * since git restore refuses a pathspec that matches nothing, and a later framework may list a file an
 * earlier tag never had. git ls-files takes such a pathspec as matching nothing, so a local clone
 * listed with it passes no file list and keeps every entry. package.json always ships, the same as npm
 * treats it, since the unit installs the framework as a workspace from it.
 *
 * @param files The framework's `files` list, or undefined when its package.json has none.
 * @param present Every file path the commit holds, or null for pathspecs git ls-files will read.
 * @return The pathspecs to take.
 */
export function shipPathspecs(files: string[] | undefined, present: string[] | null): string[] {
  if (!files) {
    return ['.'];
  }

  const has = (entry: string) => present === null || present.some((file) => entryTakes(entry, file));
  // npm reads ./x and /x as x, from the package's own folder
  const listed = files.filter((entry) => !entry.startsWith('!')).map((entry) => entry.replace(/^\.?\//, '').replace(/\/+$/, ''));
  const include = [...new Set(['package.json', ...listed])].filter(has).map((entry) => (isGlob(entry) ? `:(glob)${entry}` : entry));
  const exclude = files.filter((entry) => entry.startsWith('!')).map((entry) => `:(exclude,glob)${entry.slice(1)}`);

  if (include.length === 0) {
    throw new Error('the framework\'s files list names nothing this commit holds');
  }

  return [...include, ...exclude];
}
