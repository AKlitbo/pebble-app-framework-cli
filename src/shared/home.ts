/**
 * Where paf keeps its cache, and where the face repo it is working on starts.
 *
 * The cache holds the framework mirror. Nothing in it belongs to one repo, so every repo on the machine
 * shares it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The framework repo the mirror fetches from unless PAF_REPO says otherwise. */
export const DEFAULT_FRAMEWORK_REPO = 'https://github.com/AKlitbo/pebble-app-framework.git';

/**
 * The cache folder. PAF_HOME wins, then the platform's usual cache location.
 *
 * @param env The environment to read.
 * @return The cache folder, which may not exist yet.
 */
export function cacheHome(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PAF_HOME) {
    return path.resolve(env.PAF_HOME);
  }

  if (process.platform === 'win32') {
    return path.join(env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'paf');
  }

  return path.join(env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache'), 'paf');
}

/**
 * Where the mirror fetches the framework from.
 *
 * git runs the clone from the cache folder and each fetch from inside the mirror, so a local path is
 * made absolute from where paf was run before either sees it. A value is a local path when it names a
 * folder that is there, and anything else, a URL or an ssh address, goes to git as it is.
 *
 * @param env The environment to read.
 * @param cwd The folder paf was run from.
 * @return A git URL or an absolute local path.
 */
export function frameworkRepo(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string {
  const repo = env.PAF_REPO || DEFAULT_FRAMEWORK_REPO;
  const local = path.resolve(cwd, repo);

  return fs.existsSync(local) ? local : repo;
}

/**
 * The repo a command run from `start` works on: the nearest folder above it that git calls the top of a
 * repo. Units sit inside it, so running paf from inside a family still sees every unit.
 *
 * @param start Where the command was run from.
 * @return The repo root, or null when `start` is in no git repo.
 */
export function findRepoRoot(start: string): string | null {
  let dir = path.resolve(start);

  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) {
      return dir;
    }

    const parent = path.dirname(dir);

    if (parent === dir) {
      return null;
    }

    dir = parent;
  }
}
