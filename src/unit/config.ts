/**
 * A unit's paf.config.json: the framework tag it builds on, the commit that tag pointed at when it was
 * pinned, the framework plugins it lists with each one's settings, and its own generators. A tag that
 * later points somewhere else is caught against the recorded commit rather than followed quietly.
 */
import fs from 'node:fs';
import path from 'node:path';
import { majorOf, newestTag } from '../framework/tags.ts';
import { messageOf } from '../shared/errors.ts';
import { isObject, isScript } from '../shared/json.ts';

/** The file that makes a folder a unit. */
export const CONFIG_FILE = 'paf.config.json';

/**
 * The framework major this paf fills. Each paf major pairs with one framework major: paf 1.0.0 fills
 * framework 3, this paf framework 4, and a later framework needs a later paf. Nothing fills a framework
 * older than 3.
 */
export const FRAMEWORK_MAJOR = 4;

/**
 * Why this paf cannot fill a framework tag, or null when it can. A tag has to be a version tag of
 * framework 4.
 *
 * @param tag The tag.
 * @return The tag and why, such as "v3.0.0, which is framework 3 and needs paf 1.0.0", or null.
 */
export function unfillable(tag: string): string | null {
  const major = majorOf(tag);

  if (major === null) {
    return `${tag}, which is not a framework version tag`;
  }

  if (major === 3) {
    return `${tag}, which is framework 3 and needs paf 1.0.0`;
  }

  if (major < FRAMEWORK_MAJOR) {
    return `${tag}, which is framework ${major} and older than any paf fills`;
  }

  return major > FRAMEWORK_MAJOR ? `${tag}, which is framework ${major} and needs a newer paf` : null;
}

/**
 * The tags this paf can fill, out of every tag the framework has.
 *
 * @param tags Every tag.
 * @return The framework 4 version tags.
 */
export function fillableTags(tags: string[]): string[] {
  return tags.filter((tag) => unfillable(tag) === null);
}

/**
 * The tag latest means: the newest framework 4 release, or while framework 4 has only candidates, the
 * newest of those rather than a release of another framework this paf would refuse.
 *
 * @param tags Every tag.
 * @return The tag, or null when there is no framework 4 tag.
 */
export function latestTag(tags: string[]): string | null {
  return newestTag(fillableTags(tags));
}

/**
 * The config file as messages name it, from the unit's folder, so a line stays short and still says
 * which unit.
 *
 * @param dir The unit's folder.
 * @return Such as mosaic/paf.config.json.
 */
export function configName(dir: string): string {
  return `${path.basename(path.resolve(dir))}/${CONFIG_FILE}`;
}

/**
 * Refuses a name a JavaScript object does not keep as it is. Most names made only of digits are moved
 * to the front, in number order, whatever order the file gives them, and plugins and gen run in the
 * order the file lists them. __proto__ is taken as the object's prototype rather than an entry.
 */
function refuseBadName(name: string, kind: string, file: string): void {
  if (/^\d+$/.test(name)) {
    throw new Error(`${file} names a ${kind} ${name}. A name made only of digits loses its place in the order, so give it a letter`);
  }

  if (name === '__proto__') {
    throw new Error(`${file} names a ${kind} __proto__, which JavaScript reads as something else. Give it another name`);
  }
}

/** The tag a unit builds on and the commit it pointed at when it was pinned. */
export type Pin = {
  framework: string;
  commit?: string;
};

/** One of a unit's own generators: the script it runs, the generator it follows, and what a face has to hold for it. */
export type UnitGen = {
  script: string;
  after?: string;
  when?: string;
};

/**
 * Everything a unit's paf.config.json says. `plugins` keeps the order the file lists them in, which is
 * the order their generators run in.
 */
export type UnitConfig = Pin & {
  plugins: Record<string, Record<string, unknown>>;
  gen: Record<string, UnitGen>;
};

/** paf.config.json parsed, which is every read of the file, whatever it then checks. */
function parseConfigFile(dir: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(dir, CONFIG_FILE), 'utf8'));
}

/** paf.config.json as it is on disk, with an error naming the file when it cannot be read. */
function readConfigFile(dir: string): Record<string, unknown> {
  const file = configName(dir);
  let data: unknown;

  try {
    data = parseConfigFile(dir);
  } catch (error) {
    throw new Error(`${file} could not be read. ${messageOf(error)}`, { cause: error });
  }

  if (!isObject(data)) {
    throw new Error(`${file} has to hold an object, such as { "framework": "<tag>" }`);
  }

  return data;
}

/** The plugins map, refusing one that is not a map of names to settings objects. */
function pluginsFrom(data: Record<string, unknown>, file: string): UnitConfig['plugins'] {
  if (data.plugins === undefined) {
    return {};
  }

  if (!isObject(data.plugins)) {
    throw new Error(`${file} has a plugins that is not a map of plugin names to their settings, such as { "icons": { "sources": "vendor" } }`);
  }

  for (const [name, settings] of Object.entries(data.plugins)) {
    refuseBadName(name, 'plugin', file);

    if (!isObject(settings)) {
      throw new Error(`${file} gives the ${name} plugin settings that are not an object. A plugin with no settings takes {}`);
    }
  }

  return data.plugins as UnitConfig['plugins'];
}

/**
 * The gen map, refusing an entry with no script, since a generator with nothing to run would only fail
 * later as a run of node with no file.
 */
function genFrom(data: Record<string, unknown>, file: string): UnitConfig['gen'] {
  if (data.gen === undefined) {
    return {};
  }

  if (!isObject(data.gen)) {
    throw new Error(`${file} has a gen that is not a map of generator names, such as { "vibrant": { "script": "core/tools/vibrant.ts" } }`);
  }

  const gen: UnitConfig['gen'] = {};

  for (const [name, entry] of Object.entries(data.gen)) {
    refuseBadName(name, 'generator', file);

    // paf gen <face> all runs every generator, so one called all could never run alone
    if (name === 'all') {
      throw new Error(`${file} names a generator all, which paf gen <face> all reads as every generator. Give it another name`);
    }

    if (!isObject(entry) || typeof entry.script !== 'string' || !entry.script) {
      throw new Error(`${file} gives the ${name} generator no script. Each one in gen holds { "script": "<path from the unit>" }`);
    }

    if (!isScript(entry.script)) {
      throw new Error(`${file} gives the ${name} generator the script ${entry.script}, and paf only runs .ts scripts`);
    }

    for (const key of ['after', 'when'] as const) {
      if (entry[key] !== undefined && typeof entry[key] !== 'string') {
        throw new Error(`${file} gives the ${name} generator's ${key} as something other than text`);
      }
    }

    gen[name] = { script: entry.script, after: entry.after as string | undefined, when: entry.when as string | undefined };
  }

  return gen;
}

/** The unit's settings in paf.config.json's data, or null for the pin when it names no framework yet. */
function configFrom(data: Record<string, unknown>, file: string): UnitConfig | null {
  const plugins = pluginsFrom(data, file);
  const gen = genFrom(data, file);

  if (typeof data.framework !== 'string' || !data.framework) {
    return null;
  }

  return { framework: data.framework, commit: typeof data.commit === 'string' ? data.commit : undefined, plugins, gen };
}

/**
 * Reads a unit's paf.config.json for a command that uses its framework.
 *
 * A pin this paf cannot fill, such as one a unit kept when its file was renamed from paf 1.0.0's,
 * stops here, so status shows it as a problem and a build stops before it fetches anything.
 *
 * @param dir The unit's folder.
 * @return The unit's settings.
 */
export function readConfig(dir: string): UnitConfig {
  const file = configName(dir);
  const config = configFrom(readConfigFile(dir), file);

  if (!config) {
    throw new Error(`${file} names no framework tag. It holds { "framework": "<tag>" }`);
  }

  const why = unfillable(config.framework);

  if (why) {
    throw new Error(`${file} pins ${why}. This paf fills framework ${FRAMEWORK_MAJOR}, so move the unit to a framework ${FRAMEWORK_MAJOR} tag with paf pin`);
  }

  return config;
}

/**
 * Reads a unit's paf.config.json for a pin, which may be moving it for the first time. A pin to a
 * framework this paf cannot fill is read rather than refused, since paf pin is how a unit moves off it.
 *
 * @param dir The unit's folder.
 * @return The unit's settings, or null when the file names no framework yet.
 */
export function readConfigIfSet(dir: string): UnitConfig | null {
  return configFrom(readConfigFile(dir), configName(dir));
}

/**
 * The tag a unit's paf.config.json names, read without checking the rest of the file, for a status line
 * that shows the pin even when the plugins or gen beside it are wrong.
 *
 * @param dir The unit's folder.
 * @return The tag, or null when the file names none or cannot be read.
 */
export function pinnedTag(dir: string): string | null {
  try {
    const data = parseConfigFile(dir);

    return isObject(data) && typeof data.framework === 'string' && data.framework ? data.framework : null;
  } catch {
    return null;
  }
}

/**
 * The plugins a unit lists, in the order the file gives them, and its own generators, read whether or
 * not the file names a framework yet, since a unit going local before its first pin still has plugins to
 * copy and generators to run.
 *
 * @param dir The unit's folder.
 * @return The plugin names and the generators by name.
 */
export function readListed(dir: string): { plugins: string[]; gen: UnitConfig['gen'] } {
  const data = readConfigFile(dir);
  const file = configName(dir);

  return { plugins: Object.keys(pluginsFrom(data, file)), gen: genFrom(data, file) };
}

/**
 * Writes the pin into a unit's paf.config.json.
 *
 * @param dir The unit's folder.
 * @param pin The tag and its commit.
 */
export function writePin(dir: string, pin: Pin): void {
  // every other key the file holds is kept, which is what carries plugins and gen across a pin, and a
  // $schema or a note along with them
  let kept: Record<string, unknown>;

  try {
    const data = parseConfigFile(dir);

    kept = isObject(data) ? data : {};
  } catch {
    kept = {};
  }

  fs.writeFileSync(path.join(dir, CONFIG_FILE), JSON.stringify({ ...kept, framework: pin.framework, commit: pin.commit }, null, 2) + '\n');
}
