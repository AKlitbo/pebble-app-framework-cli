/**
 * Specs for finding units and the faces in them.
 *
 * Every command starts here. A unit the lookup misses is never synced or built, and a face given to
 * the wrong unit builds against the wrong framework. The shapes worth pinning are the ones the repos
 * really have: a family, a face of its own, and a repo that is one face at its root.
 */
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { makeTree } from '../testing/tree.ts';
import { allFaces, findUnit, findUnits, unitFaces } from './units.ts';

const PIN = '{ "framework": "v3.0.0" }';

/** A repo with a family and a face of its own, each a unit. */
function repo(): string {
  return makeTree({
    'watchfaces/mosaic/paf.json': PIN,
    'watchfaces/mosaic/core/.gitkeep': '',
    'watchfaces/mosaic/gridlock/config/pebble.appinfo.json': '{ "name": "gridlock" }',
    'watchfaces/mosaic/sidereel/config/pebble.appinfo.json': '{ "name": "sidereel" }',
    'watchfaces/ide-vscode/paf.json': PIN,
    'watchfaces/ide-vscode/config/pebble.appinfo.json': '{ "name": "ide-vscode" }',
    'watchfaces/notes/readme.md': 'not a unit',
  });
}

describe('findUnits', () => {
  /** Only a folder with a paf.json is a unit, so a stray folder under watchfaces/ is not synced as one. */
  test('finds each folder under watchfaces/ that holds a paf.json', () => {
    const result = findUnits(repo()).map((unit) => unit.rel);

    expect(result).toEqual(['watchfaces/ide-vscode', 'watchfaces/mosaic']);
  });

  /** A repo keeps its apps under watchapps/, and a unit there was never synced or pinned. */
  test('finds units under watchapps/ after the ones under watchfaces/', () => {
    const root = makeTree({ 'watchfaces/mosaic/paf.json': PIN, 'watchapps/toolbox/paf.json': PIN });

    const result = findUnits(root).map((unit) => unit.rel);

    expect(result).toEqual(['watchfaces/mosaic', 'watchapps/toolbox']);
  });

  /** Commands take a unit by its folder's name, so paf pin toolbox with one in each folder moved whichever came first. */
  test('refuses two units with the same name', () => {
    const root = makeTree({ 'watchfaces/toolbox/paf.json': PIN, 'watchapps/toolbox/paf.json': PIN });

    const result = () => findUnits(root);

    expect(result).toThrow('two units are named toolbox, at watchfaces/toolbox and watchapps/toolbox. Rename one of the folders');
  });

  /** A repo that is one face keeps its paf.json at the root, and the root is then the unit. */
  test('takes the repo root as a unit when it holds a paf.json', () => {
    const root = makeTree({ 'paf.json': PIN, 'config/pebble.appinfo.json': '{ "name": "lcars-stardate" }' });

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
      'watchfaces/one/paf.json': PIN,
      'watchfaces/one/core/.gitkeep': '',
      'watchfaces/one/clock/config/pebble.appinfo.json': '{}',
      'watchfaces/two/paf.json': PIN,
      'watchfaces/two/core/.gitkeep': '',
      'watchfaces/two/clock/config/pebble.appinfo.json': '{}',
    });

    const result = () => allFaces(findUnits(root));

    expect(result).toThrow(/two faces are named clock/);
  });

  /** A face with a broken appinfo was reported as not existing at all, which sent the user looking for a typo. */
  test('names an unreadable unit when a lookup by face finds nothing', () => {
    const root = makeTree({
      'watchfaces/radar-array/paf.json': '{}',
      'watchfaces/radar-array/config/pebble.appinfo.json': '{ half edited',
    });

    const result = () => findUnit(findUnits(root), 'radar-array-face');

    expect(result).toThrow(/These could not be read: watchfaces\/radar-array: /);
  });

  /** One half-edited appinfo stopped build, gen, and sync for every unit, however unrelated. */
  test('leaves out a unit it cannot read and names it', () => {
    const root = makeTree({
      'watchfaces/mosaic/paf.json': '{}',
      'watchfaces/mosaic/core/.gitkeep': '',
      'watchfaces/mosaic/gridlock/config/pebble.appinfo.json': '{ "name": "gridlock" }',
      'watchfaces/sketchbook/paf.json': '{}',
      'watchfaces/sketchbook/config/pebble.appinfo.json': '{ half edited',
    });
    const unreadable: string[] = [];

    const result = allFaces(findUnits(root), unreadable).map((entry) => entry.face.name);

    expect(result).toEqual(['gridlock']);
    expect(unreadable).toEqual([expect.stringMatching(/^watchfaces\/sketchbook: /)]);
  });
});
