/**
 * Specs for finding units and the faces in them.
 *
 * Every command starts here. A unit the lookup misses is never synced or built, and a face given to
 * the wrong unit builds against the wrong framework. The shapes worth pinning are the ones the repos
 * really have: a family, a face of its own, and a repo that is one face at its root. A plugin app is
 * pinned too, since a unit holding one that the lookup misses takes a framework too old to build it.
 */
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { makeTree } from '../testing/tree.ts';
import { allFaces, findUnit, findUnits, pluginApps, unitFaces } from './units.ts';

const PIN = '{ "framework": "v4.1.0" }';

/** A repo with a family and a face of its own, each a unit. */
function repo(): string {
  return makeTree({
    'watchfaces/mosaic/paf.config.json': PIN,
    'watchfaces/mosaic/core/.gitkeep': '',
    'watchfaces/mosaic/gridlock/pebble.appinfo.json': '{ "name": "gridlock" }',
    'watchfaces/mosaic/sidereel/pebble.appinfo.json': '{ "name": "sidereel" }',
    'watchfaces/ide-vscode/paf.config.json': PIN,
    'watchfaces/ide-vscode/pebble.appinfo.json': '{ "name": "ide-vscode" }',
    'watchfaces/notes/readme.md': 'not a unit',
  });
}

describe('findUnits', () => {
  /** Only a folder with a paf.config.json is a unit, so a stray folder under watchfaces/ is not synced as one. */
  test('finds each folder under watchfaces/ that holds a paf.config.json', () => {
    const result = findUnits(repo()).map((unit) => unit.rel);

    expect(result).toEqual(['watchfaces/ide-vscode', 'watchfaces/mosaic']);
  });

  /** A repo keeps its apps under watchapps/, and a unit there was never synced or pinned. */
  test('finds units under watchapps/ after the ones under watchfaces/', () => {
    const root = makeTree({ 'watchfaces/mosaic/paf.config.json': PIN, 'watchapps/toolbox/paf.config.json': PIN });

    const result = findUnits(root).map((unit) => unit.rel);

    expect(result).toEqual(['watchfaces/mosaic', 'watchapps/toolbox']);
  });

  /** A repo of plugin apps keeps them under plugins/, and a unit there was never synced, built, or pinned. */
  test('finds units under plugins/ after the ones under watchapps/', () => {
    const root = makeTree({ 'watchapps/toolbox/paf.config.json': PIN, 'plugins/calendar-ical/paf.config.json': PIN, 'watchfaces/mosaic/paf.config.json': PIN });

    const result = findUnits(root).map((unit) => unit.rel);

    expect(result).toEqual(['watchfaces/mosaic', 'watchapps/toolbox', 'plugins/calendar-ical']);
  });

  /** Commands take a unit by its folder's name, so paf pin toolbox with one in each folder moved whichever came first. */
  test('refuses two units with the same name', () => {
    const root = makeTree({ 'watchfaces/toolbox/paf.config.json': PIN, 'watchapps/toolbox/paf.config.json': PIN });

    const result = () => findUnits(root);

    expect(result).toThrow('two units are named toolbox, at watchfaces/toolbox and watchapps/toolbox. Rename one of the folders');
  });

  /**
   * A repo half moved to this paf would sync the units with a paf.config.json and quietly leave the
   * rest on paf 1.0.0's layout, so every unit still holding a paf.json is named and none is found.
   */
  test('names every unit still holding a paf.json and finds none', () => {
    const root = makeTree({
      'watchfaces/ide-vscode/paf.config.json': PIN,
      'watchfaces/mosaic/paf.json': PIN,
      'watchfaces/sketchbook/paf.json': PIN,
    });

    const result = () => findUnits(root);

    expect(result).toThrow('watchfaces/mosaic and watchfaces/sketchbook still have a paf.json, which paf 1.0.0 reads. This paf reads paf.config.json. Move each unit by hand, then delete its paf.json');
  });

  /** A unit renamed by copying its file rather than moving it would sync and keep paf 1.0.0's file beside it. */
  test('names a unit holding both files', () => {
    const root = makeTree({ 'watchfaces/mosaic/paf.config.json': PIN, 'watchfaces/mosaic/paf.json': PIN });

    const result = () => findUnits(root);

    expect(result).toThrow(/^watchfaces\/mosaic still has a paf\.json/);
  });

  /** A name clash thrown mid-walk hid the leftover paf.json, which only showed once the folder was renamed. */
  test('names a leftover paf.json before a name clash', () => {
    const root = makeTree({
      'watchfaces/toolbox/paf.config.json': PIN,
      'watchfaces/toolbox/paf.json': PIN,
      'watchapps/toolbox/paf.config.json': PIN,
    });

    const result = () => findUnits(root);

    expect(result).toThrow(/^watchfaces\/toolbox still has a paf\.json/);
  });

  /** A repo that is one face keeps its paf.config.json at the root, and the root is then the unit. */
  test('takes the repo root as a unit when it holds a paf.config.json', () => {
    const root = makeTree({ 'paf.config.json': PIN, 'pebble.appinfo.json': '{ "name": "lcars-stardate" }' });

    const result = findUnits(root).map((unit) => unit.rel);

    expect(result).toEqual(['.']);
  });
});

describe('unitFaces', () => {
  /** A family's faces sit beside its core, and the core carries no appinfo, so it is never taken for a face. */
  test('finds the faces beside a family core', () => {
    const result = unitFaces(path.join(repo(), 'watchfaces', 'mosaic')).map((face) => face.name);

    expect(result).toEqual(['gridlock', 'sidereel']);
  });

  /** A face of its own still holding config/pebble.appinfo.json read as a unit with no faces, so its build said there was no such face. */
  test('refuses a face of its own that keeps its appinfo in config/', () => {
    const root = makeTree({ 'paf.config.json': PIN, 'config/pebble.appinfo.json': '{ "name": "lcars-stardate" }' });

    const result = () => unitFaces(root);

    expect(result).toThrow(/^config\/pebble\.appinfo\.json is where framework 3 keeps an appinfo/);
  });

  /** A family face left with its appinfo in config/ dropped out of the family without a word. */
  test('names each family face that keeps its appinfo in config/', () => {
    const root = makeTree({
      'core/.gitkeep': '',
      'gridlock/pebble.appinfo.json': '{ "name": "gridlock" }',
      'sidereel/config/pebble.appinfo.json': '{ "name": "sidereel" }',
    });

    const result = () => unitFaces(root);

    expect(result).toThrow(/^sidereel\/config\/pebble\.appinfo\.json is where framework 3/);
  });

  /** A name that was not a string became the face's name here, while the plugin check named the unit by its folder, so status lost the plugin app mark. */
  test('refuses a face of its own whose appinfo name is not a string', () => {
    const root = makeTree({ 'paf.config.json': PIN, 'pebble.appinfo.json': '{ "name": 42 }' });

    const result = () => unitFaces(root);

    expect(result).toThrow(/needs a name in its pebble\.appinfo\.json/);
  });
});

describe('findUnit', () => {
  /** A face in a family moves with its family, so naming the face has to reach the family's unit. */
  test('finds the unit holding a face by the face name', () => {
    const units = findUnits(repo());

    const result = findUnit(units, 'sidereel').rel;

    expect(result).toBe('watchfaces/mosaic');
  });
});

describe('allFaces', () => {
  /** A face's name is its build folder and its release tag, so two faces with one name would overwrite each other. */
  test('refuses two faces with the same name', () => {
    const root = makeTree({
      'watchfaces/one/paf.config.json': PIN,
      'watchfaces/one/core/.gitkeep': '',
      'watchfaces/one/clock/pebble.appinfo.json': '{}',
      'watchfaces/two/paf.config.json': PIN,
      'watchfaces/two/core/.gitkeep': '',
      'watchfaces/two/clock/pebble.appinfo.json': '{}',
    });

    const result = () => allFaces(findUnits(root));

    expect(result).toThrow(/two faces are named clock/);
  });

  /** A face with a broken appinfo was reported as not existing at all, which sent the user looking for a typo. */
  test('names an unreadable unit when a lookup by face finds nothing', () => {
    const root = makeTree({
      'watchfaces/radar-array/paf.config.json': '{}',
      'watchfaces/radar-array/pebble.appinfo.json': '{ half edited',
    });

    const result = () => findUnit(findUnits(root), 'radar-array-face');

    expect(result).toThrow(/These could not be read: watchfaces\/radar-array: /);
  });

  /** One half-edited appinfo stopped build, gen, and sync for every unit, however unrelated. */
  test('leaves out a unit it cannot read and names it', () => {
    const root = makeTree({
      'watchfaces/mosaic/paf.config.json': '{}',
      'watchfaces/mosaic/core/.gitkeep': '',
      'watchfaces/mosaic/gridlock/pebble.appinfo.json': '{ "name": "gridlock" }',
      'watchfaces/sketchbook/paf.config.json': '{}',
      'watchfaces/sketchbook/pebble.appinfo.json': '{ half edited',
    });
    const unreadable: string[] = [];

    const result = allFaces(findUnits(root), unreadable).map((entry) => entry.face.name);

    expect(result).toEqual(['gridlock']);
    expect(unreadable).toEqual([expect.stringMatching(/^watchfaces\/sketchbook: /)]);
  });
});

/** A plugin app's appinfo, which the Pebble SDK marks with projectType. */
const PLUGIN_APPINFO = '{ "name": "calendar-ical", "projectType": "plugin" }';

describe('pluginApps', () => {
  /** A plugin app missed here builds on a framework too old for it, which stops partway with nothing pointing at the pin. */
  test('names a unit that is a plugin app', () => {
    const root = makeTree({ 'paf.config.json': PIN, 'pebble.appinfo.json': PLUGIN_APPINFO });

    const result = pluginApps(root);

    expect(result).toEqual(['calendar-ical']);
  });

  /** A watchface marked as a plugin app would be refused a framework it builds on fine. */
  test('leaves out faces with no projectType or another one', () => {
    const root = makeTree({
      'core/.gitkeep': '',
      'gridlock/pebble.appinfo.json': '{ "name": "gridlock" }',
      'sidereel/pebble.appinfo.json': '{ "name": "sidereel", "projectType": "native" }',
      'agenda/pebble.appinfo.json': '{ "name": "agenda", "projectType": "plugin" }',
    });

    const result = pluginApps(root);

    expect(result).toEqual(['agenda']);
  });

  /** A plugin app with no name yet slipped past the framework 6 check, and a pin to framework 5 was written. */
  test('names a unit that is a plugin app even when its faces cannot be read', () => {
    const root = makeTree({ 'pebble.appinfo.json': '{ "projectType": "plugin" }' });

    const result = pluginApps(root);

    expect(result).toEqual([path.basename(root)]);
  });

  /** A half-edited watchface appinfo is named by whatever reads the faces, so its unit must not be refused as a plugin app. */
  test('counts a face whose appinfo cannot be read as not a plugin app', () => {
    const root = makeTree({ 'core/.gitkeep': '', 'gridlock/pebble.appinfo.json': '{ "name": ' });

    const result = pluginApps(root);

    expect(result).toEqual([]);
  });

  /** A plugin app half-edited on a pin before framework 6 slipped past the check and stopped partway in an old framework's build. */
  test('counts an appinfo that cannot be read but still sets the plugin projectType as a plugin app', () => {
    const root = makeTree({ 'core/.gitkeep': '', 'calendar-ical/pebble.appinfo.json': '{ "name": "calendar-ical", "projectType": "plugin", ' });

    const result = pluginApps(root);

    expect(result).toEqual(['calendar-ical']);
  });
});
