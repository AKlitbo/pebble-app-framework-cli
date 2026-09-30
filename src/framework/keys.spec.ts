/**
 * Specs for reading the paf keys and ordering what paf gen <face> all runs.
 *
 * The order decides whether a table the unit makes from the Clay output lands before the asset that
 * reads it, and a generator read as offering nothing is skipped without a word. Both only show up as a
 * stale file much later, so the order and the refusals are what is worth pinning.
 */
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { makeTree } from '../testing/tree.ts';
import { applies, genPlan, notOffered, parseKey, readKeys, type Keyed } from './keys.ts';

/** A key offering the named generators, each running a script of the same name. */
function offering(owner: string, ...names: string[]): Keyed {
  return { plugin: owner === 'the core' ? null : owner, owner, dir: `/unit/paf/${owner}`, key: { gen: Object.fromEntries(names.map((name) => [name, { script: `${name}.ts` }])) } };
}

describe('genPlan', () => {
  /**
   * The order settled for gen all. A vibrant table written after the icons or thumbnails that read
   * it leaves them built from the last run's colours.
   */
  test('runs a unit generator with after right after the one it names', () => {
    const keys = [offering('the core', 'clay'), offering('the icons plugin', 'icons'), offering('the thumbnails plugin', 'thumbnails')];

    const result = genPlan(keys, { vibrant: { script: 'core/tools/vibrant.ts', after: 'clay' } }, '/unit');

    expect(result.map((step) => step.name)).toEqual(['clay', 'vibrant', 'icons', 'thumbnails']);
  });

  /** A unit generator following another unit generator still lands after it, wherever that one sits. */
  test('follows a chain of unit generators', () => {
    const keys = [offering('the core', 'clay'), offering('the icons plugin', 'icons')];

    const result = genPlan(keys, { shades: { script: 'shades.ts', after: 'vibrant' }, vibrant: { script: 'vibrant.ts', after: 'clay' } }, '/unit');

    expect(result.map((step) => step.name)).toEqual(['clay', 'vibrant', 'shades', 'icons']);
  });

  /** Left unrefused, the unit's generator would run last, which is where a stale vibrant table comes from. */
  test('refuses an after naming a generator nothing listed offers', () => {
    const keys = [offering('the core', 'clay')];

    const result = () => genPlan(keys, { vibrant: { script: 'vibrant.ts', after: 'icons' } }, '/unit');

    expect(result).toThrow(/vibrant runs after icons, which nothing the unit lists offers/);
  });

  /** Two unit generators that each wait on the other would never run, and gen all would skip both without a word. */
  test('refuses a ring of unit generators', () => {
    const keys = [offering('the core', 'clay')];

    const result = () => genPlan(keys, { a: { script: 'a.ts', after: 'b' }, b: { script: 'b.ts', after: 'a' } }, '/unit');

    expect(result).toThrow(/generators a and b each run after another of them/);
  });

  /** A generator after itself is a mistake of its own, and calling it a ring sends the reader looking for others. */
  test('refuses a unit generator that runs after itself', () => {
    const keys = [offering('the core', 'clay')];

    const result = () => genPlan(keys, { vibrant: { script: 'vibrant.ts', after: 'vibrant' } }, '/unit');

    expect(result).toThrow(/vibrant runs after itself/);
  });

  /** A generator that only follows the ring is not part of it, and naming it sends the reader to fix the wrong entry. */
  test('names only the ring, not a generator that follows it', () => {
    const keys = [offering('the core', 'clay')];

    const result = () => genPlan(keys, { c: { script: 'c.ts', after: 'a' }, a: { script: 'a.ts', after: 'b' }, b: { script: 'b.ts', after: 'a' } }, '/unit');

    expect(result).toThrow(/generators a and b each run after/);
  });

  /** paf gen <face> icons would quietly pick one of the two, and which one would depend on the listing. */
  test('refuses a name offered by a plugin and the unit, naming both', () => {
    const keys = [offering('the core', 'clay'), offering('the icons plugin', 'icons')];

    const result = () => genPlan(keys, { icons: { script: 'icons.ts' } }, '/unit');

    expect(result).toThrow(/icons is offered by both the icons plugin and the unit, so paf cannot tell which to run\. Rename the unit's icons generator in paf\.config\.json/);
  });

  /** The core cannot be left out, so telling the reader to list one of the plugins gives them nothing to do. */
  test('says which plugin to leave out when it clashes with the core', () => {
    const keys = [offering('the core', 'clay'), offering('the frame plugin', 'clay')];

    const result = () => genPlan(keys, {}, '/unit');

    expect(result).toThrow(/leave the frame plugin out/);
  });

  /** A unit script is relative to the unit and a plugin's to its own folder, so each has to run from where it was named. */
  test('gives each step the folder its script is relative to', () => {
    const keys = [offering('the icons plugin', 'icons')];

    const result = genPlan(keys, { vibrant: { script: 'vibrant.ts' } }, '/unit');

    expect(result.map((step) => step.dir)).toEqual(['/unit/paf/the icons plugin', '/unit']);
  });
});

describe('parseKey', () => {
  /** paf gen <face> all reads all as every generator, so a generator by that name could never run alone. */
  test('refuses a generator called all', () => {
    const result = () => parseKey('{ "paf": { "gen": { "all": { "script": "all.ts" } } } }', 'frame/package.json');

    expect(result).toThrow(/offers a generator all/);
  });

  /** A trailing comma in one of several package.json files gave a bare JSON error with no hint of which one. */
  test('names the file it cannot parse', () => {
    const result = () => parseKey('{ "paf": {}, }', 'paf/plugins/icons/package.json');

    expect(result).toThrow(/paf\/plugins\/icons\/package\.json could not be read/);
  });
});

describe('notOffered', () => {
  /** The plugin to list is the one offering the name, which for a tool is never the tool's own name. */
  test('names the unlisted plugin that offers a tool', () => {
    const dev: Keyed = { plugin: 'dev', owner: 'the dev plugin', dir: 'src/plugins/dev', key: { tools: { 'clay-preview': { script: 'clay-preview.ts' } } } };

    const result = notOffered('tools', 'clay-preview', [], [dev]);

    expect(result).toMatch(/The dev plugin offers it, so list it under plugins/);
  });

  /** A plugin named like the thing asked for but offering nothing by that name would send the reader round in a circle. */
  test('names no plugin when none of the unlisted ones offers the name', () => {
    const dev: Keyed = { plugin: 'dev', owner: 'the dev plugin', dir: 'src/plugins/dev', key: { gen: {} } };

    const result = notOffered('gen', 'dev', ['clay'], [dev]);

    expect(result).toBe('no generator called dev. What the unit lists offers clay, and no plugin the unit leaves out offers it either');
  });
});

describe('readKeys', () => {
  /** A listed plugin read as offering nothing would have gen all skip its generator without a word. */
  test('says to sync when a listed plugin is missing from paf/', () => {
    const root = makeTree({ 'paf/package.json': '{ "paf": {} }' });

    const result = () => readKeys(root, ['frame']);

    expect(result).toThrow(/lists the plugin frame, which paf\/ does not have yet\. Run paf sync/);
  });

  /** The plugins' generators run in the order the unit lists them, which is the only order control a unit has over them. */
  test('reads the core first and the plugins in the order listed', () => {
    const root = makeTree({
      'paf/package.json': '{ "paf": {} }',
      'paf/plugins/icons/package.json': '{ "paf": {} }',
      'paf/plugins/frame/package.json': '{}',
    });

    const result = readKeys(root, ['frame', 'icons']);

    expect(result.map((keyed) => keyed.owner)).toEqual(['the core', 'the frame plugin', 'the icons plugin']);
    expect(result[1].key).toEqual({});
  });

  /** A gen entry with no script only fails later as a run of node with no file, far from the package that named it. */
  test('refuses a generator with no script, naming the file', () => {
    const root = makeTree({ 'paf/package.json': '{ "paf": { "gen": { "clay": { "when": "src/pkjs" } } } }' });

    const result = () => readKeys(root, []);

    expect(result).toThrow(/package\.json names an entry with no script/);
  });
});

describe('applies', () => {
  /** A family keeps its Clay builder in core/pkjs, so reading only the face would skip the Clay generator for every face in it. */
  test('finds a src/pkjs/ path in the family core', () => {
    const root = makeTree({ 'core/pkjs/clay/builder/index.ts': '' });

    const result = applies('src/pkjs/clay/builder', path.join(root, 'gridlock'), root);

    expect(result).toBe(true);
  });

  /** Only a src/pkjs/ path is looked for in the core, so a face without a frame of its own never runs the frame generator. */
  test('does not look in the core for other paths', () => {
    const root = makeTree({ 'core/frame/frame.config.json': '{}' });

    const result = applies('frame/frame.config.json', path.join(root, 'gridlock'), root);

    expect(result).toBe(false);
  });
});
