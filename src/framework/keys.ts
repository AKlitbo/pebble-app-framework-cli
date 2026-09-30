/**
 * The paf keys: what the framework and each plugin a unit lists offer to paf gen, paf check, paf tool,
 * and paf build, read from the paf key in each package.json in the unit's paf/.
 *
 * paf reads the keys and never learns what any tool does, so a generator, a check, or a tool the
 * framework adds reaches every unit through its key, with nothing in paf to change.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { UnitGen } from '../unit/config.ts';
import { FRAMEWORK_DIR, PLUGINS_FOLDER } from '../unit/framework.ts';
import { messageOf } from '../shared/errors.ts';
import { isObject } from '../shared/json.ts';
import { inSentence } from '../shared/words.ts';

/** A generator a package offers: its script, what a face has to hold for gen all to run it, and what gen all passes it. */
export type GenEntry = {
  script: string;
  when?: string;
  allArgs?: string[];
};

/** A package's paf key, as far as paf reads it. */
export type PafKey = {
  build?: { script: string };
  gen?: Record<string, GenEntry>;
  check?: string[];
  tools?: Record<string, { script: string }>;
};

/** One package's key: the plugin it belongs to or null for the core, who offers it for messages, and the folder its scripts are relative to. */
export type Keyed = {
  plugin: string | null;
  owner: string;
  dir: string;
  key: PafKey;
};

/** One generator in the order gen all runs them, with the folder its script is relative to. */
export type GenStep = GenEntry & {
  name: string;
  owner: string;
  dir: string;
};

/**
 * A package's paf key read from its package.json text, refusing a shape paf cannot run, since a broken
 * entry would only fail later inside node, far from the file that named it. Whether a script is .ts is
 * left to the run, so one bad entry only stops a run of itself.
 *
 * @param text The package.json's text.
 * @param file Its path, for messages.
 * @return The key, or an empty one when the package has none.
 */
export function parseKey(text: string, file: string): PafKey {
  let data: unknown;

  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`${file} could not be read. ${messageOf(error)}`, { cause: error });
  }

  const key = isObject(data) ? data.paf : undefined;

  if (key === undefined) {
    return {};
  }

  if (!isObject(key)) {
    throw new Error(`${file} has a paf key that is not an object`);
  }

  const scripts: unknown[] = [];

  if (key.build !== undefined) {
    scripts.push(isObject(key.build) ? key.build.script : undefined);
  }

  for (const [group, entries] of [['gen', key.gen], ['tools', key.tools]] as const) {
    if (entries !== undefined && !isObject(entries)) {
      throw new Error(`${file} has a ${group} that is not a map of names`);
    }

    for (const entry of Object.values(entries ?? {})) {
      scripts.push(isObject(entry) ? entry.script : undefined);
    }
  }

  if (key.check !== undefined && !Array.isArray(key.check)) {
    throw new Error(`${file} has a check that is not a list of scripts`);
  }

  scripts.push(...((key.check as unknown[] | undefined) ?? []));

  if (!scripts.every((script) => typeof script === 'string' && script.length > 0)) {
    throw new Error(`${file} names an entry with no script`);
  }

  for (const [name, entry] of Object.entries(isObject(key.gen) ? key.gen : {})) {
    const { when, allArgs } = entry as Record<string, unknown>;

    if (name === 'all') {
      throw new Error(`${file} offers a generator all, which paf gen <face> all reads as every generator`);
    }

    if ((when !== undefined && typeof when !== 'string') || (allArgs !== undefined && (!Array.isArray(allArgs) || !allArgs.every((arg) => typeof arg === 'string')))) {
      throw new Error(`${file} gives the ${name} generator a when that is not text or an allArgs that is not a list of text`);
    }
  }

  return key as PafKey;
}

/**
 * The paf keys of the framework in a unit's paf/ and of each plugin the unit lists, the core first and
 * the plugins in the order the unit lists them.
 *
 * @param unitDir The unit's folder.
 * @param plugins The plugins the unit lists.
 * @return Each package's key with who offers it and its folder.
 */
export function readKeys(unitDir: string, plugins: string[]): Keyed[] {
  const framework = path.join(unitDir, FRAMEWORK_DIR);
  const core = path.join(framework, 'package.json');

  if (!fs.existsSync(core)) {
    throw new Error(`${core} is not there. Run paf sync to fill paf/`);
  }

  const keys: Keyed[] = [{ plugin: null, owner: 'the core', dir: framework, key: parseKey(fs.readFileSync(core, 'utf8'), core) }];

  for (const name of plugins) {
    const dir = path.join(framework, PLUGINS_FOLDER, name);
    const file = path.join(dir, 'package.json');

    // a listed plugin read as offering nothing would have gen all skip its generator without a word
    if (!fs.existsSync(file)) {
      throw new Error(`the unit lists the plugin ${name}, which paf/ does not have yet. Run paf sync to fill it`);
    }

    keys.push({ plugin: name, owner: `the ${name} plugin`, dir, key: parseKey(fs.readFileSync(file, 'utf8'), file) });
  }

  return keys;
}

/**
 * The message for a name two owners offer, with what to do about it, which depends on which of the two
 * the reader can change.
 *
 * @param noun generator or tool.
 * @param name The name both offer.
 * @param first The owner read first, the core before any plugin and any plugin before the unit.
 * @param second The other owner.
 * @return The message.
 */
export function clashMessage(noun: string, name: string, first: string, second: string): string {
  let advice = 'List only one of the two plugins';

  if (second === 'the unit') {
    advice = `Rename the unit's ${name} ${noun} in paf.config.json`;
  } else if (first === 'the core') {
    advice = `The framework offers both, so leave the ${second.replace(/^the /, '')} out until it is fixed`;
  }

  return `the ${noun} ${name} is offered by both ${first} and ${second}, so paf cannot tell which to run. ${advice}`;
}

/**
 * The unit generators that wait on each other in a ring, found by following the after of one that was
 * never placed until a name comes round again. Entries that only follow the ring are left out.
 */
function ringOf(unplaced: (GenStep & { after?: string })[]): string[] {
  const byName = new Map(unplaced.map((step) => [step.name, step]));
  const walked: string[] = [];
  let name: string | undefined = unplaced[0].name;

  while (name !== undefined && !walked.includes(name)) {
    walked.push(name);
    name = byName.get(name)?.after;
  }

  return name === undefined ? walked : walked.slice(walked.indexOf(name));
}

/**
 * Every generator the framework, the listed plugins, and the unit offer, in the order gen all runs them.
 *
 * The core's run first, then each listed plugin's in the order the unit lists them, then the unit's own.
 * A unit generator with an after runs right after the generator it names, wherever that one is, so a
 * colour table the unit makes from the Clay output lands before a plugin's asset reads it. The same name
 * offered twice is refused with both owners named, so paf gen <face> <kind> never quietly picks one.
 *
 * @param keys The keys readKeys gave.
 * @param unitGen The unit's own generators from paf.config.json.
 * @param unitDir The unit's folder, which a unit generator's script is relative to.
 * @return The generators, in order.
 */
export function genPlan(keys: Keyed[], unitGen: Record<string, UnitGen>, unitDir: string): GenStep[] {
  const framework: GenStep[] = keys.flatMap(({ owner, dir, key }) => Object.entries(key.gen ?? {}).map(([name, entry]) => ({ ...entry, name, owner, dir })));
  const unit: (GenStep & { after?: string })[] = Object.entries(unitGen).map(([name, entry]) => ({ name, owner: 'the unit', dir: unitDir, script: entry.script, when: entry.when, after: entry.after }));
  const owners = new Map<string, string>();

  for (const step of [...framework, ...unit]) {
    const other = owners.get(step.name);

    if (other) {
      throw new Error(clashMessage('generator', step.name, other, step.owner));
    }

    owners.set(step.name, step.owner);
  }

  for (const step of unit) {
    if (step.after === step.name) {
      throw new Error(`the unit's generator ${step.name} runs after itself, so it can never run. Give it an after naming another generator, or none`);
    }

    if (step.after !== undefined && !owners.has(step.after)) {
      throw new Error(`the unit's generator ${step.name} runs after ${step.after}, which nothing the unit lists offers. The generators are ${inSentence([...owners.keys()])}`);
    }
  }

  // each generator is followed by the unit's that name it in after, in the order the file gives them
  const following = new Map<string, GenStep[]>();

  for (const step of unit.filter((each) => each.after !== undefined)) {
    following.set(step.after as string, [...(following.get(step.after as string) ?? []), step]);
  }

  const plan: GenStep[] = [];
  const place = (step: GenStep): void => {
    plan.push(step);

    for (const next of following.get(step.name) ?? []) {
      place(next);
    }
  };

  for (const step of [...framework, ...unit.filter((each) => each.after === undefined)]) {
    place(step);
  }

  // an entry never placed follows one that never runs either, which only a ring can cause
  const unplaced = unit.filter((step) => !plan.includes(step));

  if (unplaced.length) {
    throw new Error(`the unit's generators ${inSentence(ringOf(unplaced))} each run after another of them, so none of them can run first. Give one an after outside the ring, or none`);
  }

  return plan.map(({ name, owner, dir, script, when, allArgs }) => ({ name, owner, dir, script, when, allArgs }));
}

/**
 * Whether a face holds what a generator needs: the path under the face, or for a src/pkjs/ path, under
 * the family core's pkjs/ too, since a family keeps its shared Clay builder there.
 *
 * @param when The path the generator's when names, relative to a face, or undefined for every face.
 * @param faceDir The face's folder.
 * @param unitDir The unit's folder.
 * @return Whether the generator runs for the face.
 */
export function applies(when: string | undefined, faceDir: string, unitDir: string): boolean {
  if (when === undefined) {
    return true;
  }

  return fs.existsSync(path.join(faceDir, when)) || (when.startsWith('src/pkjs/') && fs.existsSync(path.join(unitDir, 'core', when.slice('src/'.length))));
}

/**
 * The message for a generator or a tool nobody the unit lists offers, naming the plugin to list when one
 * the unit leaves out offers it.
 *
 * @param what gen for a generator or tools for a tool, the key it sits under.
 * @param name The name asked for.
 * @param offered What the unit's keys do offer.
 * @param unlisted The keys of the plugins the framework has and the unit does not list, or null when
 * they could not be read.
 * @return The message.
 */
export function notOffered(what: 'gen' | 'tools', name: string, offered: string[], unlisted: Keyed[] | null): string {
  const noun = what === 'gen' ? 'generator' : 'tool';
  const owner = unlisted?.find(({ key }) => Object.hasOwn(key[what] ?? {}, name));

  if (owner?.plugin) {
    return `no ${noun} called ${name}. The ${owner.plugin} plugin offers it, so list it under plugins in paf.config.json and run paf sync`;
  }

  const those = offered.length ? `What the unit lists offers ${inSentence(offered)}` : `Nothing the unit lists offers a ${noun}`;

  const rest = unlisted ? 'and no plugin the unit leaves out offers it either' : 'and a plugin offers nothing until it is listed under plugins in paf.config.json';

  return `no ${noun} called ${name}. ${those}, ${rest}`;
}
