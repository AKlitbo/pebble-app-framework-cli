/**
 * Which of the framework's files a unit's paf/ gets.
 *
 * Everything the framework ships sits in its src/ folder. paf takes that folder from a tag or from a
 * local clone, leaving out the specs, their fixtures, and every plugin the unit does not list, so a unit
 * carries only what its faces run and installs only what its plugins need.
 */
import { inSentence } from '../shared/words.ts';

/** The framework folder everything a unit gets comes from. */
export const SHIP_ROOT = 'src';

/** The folder in the framework repo that holds one folder per plugin. */
export const PLUGINS_DIR = `${SHIP_ROOT}/plugins`;

/** What ships from src/ whatever the unit lists: all of it but the specs and their fixtures. */
export const BASE_PATHSPECS = ['.', ':(exclude,glob)**/*.spec.ts', ':(exclude,glob)**/*.spec.c', ':(exclude,glob)**/fixtures/**'];

/**
 * The pathspecs for what a unit gets from the framework, in git's form and relative to src/, so git
 * restore reads them against the tag's src/ tree and git ls-files against the clone's src/ folder, and
 * both give paths that are already paf/'s.
 *
 * A plugin the unit lists that the framework does not offer is refused. git would take the exclude
 * list without it and the unit would sync clean, then fail on the first paf gen with nothing saying the
 * plugin was never there.
 *
 * @param listed The plugins the unit lists in paf.config.json.
 * @param offered The plugins the framework has, the folders under src/plugins.
 * @param source What the framework was read from, such as a tag, for the refusal.
 * @return The pathspecs.
 */
export function shipPathspecs(listed: string[], offered: string[], source: string): string[] {
  const missing = listed.filter((name) => !offered.includes(name));

  if (missing.length) {
    const has = offered.length ? `It has ${inSentence([...offered].sort())}` : 'It has no plugins';

    throw new Error(`the unit lists the plugin${missing.length === 1 ? '' : 's'} ${inSentence(missing)}, which ${source} does not have. ${has}`);
  }

  return [...BASE_PATHSPECS, ...offered.filter((name) => !listed.includes(name)).map((name) => `:(exclude,glob)plugins/${name}/**`)];
}
