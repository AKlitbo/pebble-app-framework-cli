/**
 * The framework mirror: a bare clone in the cache for each place the framework comes from, which
 * every unit's paf/ is filled from.
 *
 * Tags are fetched with --force, so a tag that moved upstream is seen straight away and the pin check
 * can catch it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Context } from '../shared/context.ts';
import { sha256 } from '../shared/hash.ts';
import { must, type Runner } from '../shared/runner.ts';

/**
 * The mirror's folder in the cache, one for each place the framework is fetched from.
 *
 * Every fetch points the mirror at its source and prunes the tags that source lacks, so two sources
 * sharing one mirror, such as a local clone in PAF_REPO and GitHub, would each drop the other's tags.
 *
 * @param ctx The command context.
 * @return The folder.
 */
export function mirrorOf(ctx: Context): string {
  return path.join(ctx.cache, `mirror-${sha256(ctx.repo, 12)}.git`);
}

/**
 * Makes the mirror if it is missing, then fetches every tag.
 *
 * The clone is a full one. A clone without file contents would fetch each file on its own as git
 * restore fills paf/, and the whole framework is only a few tens of megabytes.
 *
 * @param run The runner.
 * @param mirror The mirror's folder.
 * @param repo The framework's URL or local path.
 */
export function updateMirror(run: Runner, mirror: string, repo: string): void {
  if (!fs.existsSync(path.join(mirror, 'HEAD'))) {
    // a clone stopped partway leaves a folder with no HEAD, which git refuses to clone into
    fs.rmSync(mirror, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(mirror), { recursive: true });

    must(run, 'git', ['clone', '--bare', '--quiet', repo, mirror], { cwd: path.dirname(mirror), capture: true });
  }

  must(run, 'git', ['-C', mirror, 'fetch', '--quiet', '--force', '--prune', 'origin', '+refs/tags/*:refs/tags/*'], { cwd: mirror, capture: true });
}

/**
 * The commit a tag points at in the mirror, or null when the mirror does not have it.
 *
 * Only tags are looked up. The mirror fetches nothing else, so a branch the clone happened to copy
 * would stay where it was that day and freeze a unit pinned to it.
 *
 * @param run The runner.
 * @param mirror The mirror's folder.
 * @param tag The tag.
 * @return The full commit hash, or null.
 */
export function resolveRef(run: Runner, mirror: string, tag: string): string | null {
  if (!fs.existsSync(path.join(mirror, 'HEAD'))) {
    return null;
  }

  const result = run('git', ['-C', mirror, 'rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`], { cwd: mirror, capture: true });

  return result.code === 0 ? result.stdout.trim() : null;
}

/**
 * Every tag in the mirror, in no set order. git sorts a candidate above its release, so callers order
 * them with compareTags.
 *
 * @param run The runner.
 * @param mirror The mirror's folder.
 * @return The tags.
 */
export function listTags(run: Runner, mirror: string): string[] {
  const out = must(run, 'git', ['-C', mirror, 'tag', '--list'], { cwd: mirror, capture: true });

  return out ? out.split('\n') : [];
}

/**
 * One file as it is at a commit, or null when it does not exist there.
 *
 * @param run The runner.
 * @param mirror The mirror's folder.
 * @param ref The tag or commit.
 * @param file The file's path in the framework repo.
 * @return Its contents, or null.
 */
export function showFile(run: Runner, mirror: string, ref: string, file: string): string | null {
  const result = run('git', ['-C', mirror, 'show', `${ref}:${file}`], { cwd: mirror, capture: true });

  return result.code === 0 ? result.stdout : null;
}

/**
 * The folders straight inside a folder at a commit, such as the plugins a framework tag offers.
 *
 * @param run The runner.
 * @param mirror The mirror's folder.
 * @param ref The tag or commit.
 * @param dir The folder's path in the framework repo, with forward slashes.
 * @return Each folder's name, or none when the commit has no such folder.
 */
export function listFolders(run: Runner, mirror: string, ref: string, dir: string): string[] {
  // -d lists only folders, and -z gives each name as it is, where a plain list quotes one with unusual
  // characters in it
  const out = must(run, 'git', ['-C', mirror, 'ls-tree', '-d', '-z', '--name-only', ref, `${dir}/`], { cwd: mirror, capture: true });

  return out.split('\0').filter(Boolean).map((entry) => entry.slice(entry.lastIndexOf('/') + 1));
}

/** How many files are under a folder. */
function countFiles(dir: string): number {
  return fs.readdirSync(dir, { withFileTypes: true, recursive: true }).filter((entry) => entry.isFile() || entry.isSymbolicLink()).length;
}

/**
 * Writes the files a commit holds under the given pathspecs into a folder.
 *
 * git restore writes them itself, with the mirror as the repo and the folder as its work tree, so
 * paths, symlinks, and modes come out the way git means them. A spare index file keeps the bare
 * mirror's own untouched.
 *
 * @param run The runner.
 * @param mirror The mirror's folder.
 * @param ref The tag or commit.
 * @param pathspecs What to take, in git's pathspec form.
 * @param dest The folder to write into. It is made if missing.
 * @return How many files it wrote.
 */
export function exportTree(run: Runner, mirror: string, ref: string, pathspecs: string[], dest: string): number {
  const index = path.join(os.tmpdir(), `paf-${process.pid}-${Date.now()}.index`);

  fs.mkdirSync(dest, { recursive: true });

  try {
    // the framework's .gitattributes asks for LF on every text file, since the Pebble toolchain breaks
    // on CRLF. the restore starts from an empty folder and a spare index, so it never reads that file,
    // and Git for Windows turns autocrlf on for the whole machine. the files are taken as committed, so a
    // unit filled from Windows holds the same bytes as one filled from WSL
    must(run, 'git', ['-c', 'core.autocrlf=false', '--git-dir', mirror, '--work-tree', dest, 'restore', `--source=${ref}`, '--worktree', '--', ...pathspecs], {
      cwd: dest,
      capture: true,
      env: { ...process.env, GIT_INDEX_FILE: index },
    });

    return countFiles(dest);
  } finally {
    fs.rmSync(index, { force: true });
  }
}
