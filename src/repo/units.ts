/**
 * Finding the units in a face repo, and the faces in each.
 *
 * A unit is a folder with a paf.json: the repo root, for a repo that is one face or one family, or a
 * folder straight under watchfaces/ or watchapps/, for a family or a face of its own. The two folders
 * only sort faces from apps, and a unit in either is laid out the same. Each one keeps its own framework in lib/, its
 * own package.json, and its own node_modules, so it works like a small repo.
 *
 * Inside a unit a face sits in one of two places. A unit that is a face has its appinfo at its own
 * root. A unit that is a family has a core/ and one folder per face beside it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { messageOf } from '../shared/errors.ts';

/** Where a face keeps its appinfo, relative to the face's own folder. */
export const APPINFO_REL = path.join('config', 'pebble.appinfo.json');

/**
 * One unit: its folder, that folder relative to the repo root, the name commands call it by, and how
 * messages refer to it, which for the repo root is its name rather than a lone dot.
 */
export type Unit = {
  dir: string;
  rel: string;
  name: string;
  where: string;
};

/** One face: its name, and its folder relative to its unit (`.` for a unit that is the face). */
export type Face = {
  name: string;
  rel: string;
};

/**
 * Every unit in a repo, the root first and then the folders under watchfaces/ and watchapps/ by name.
 *
 * Commands take a unit by its folder's name, so two units with one name, one in each folder, are
 * refused rather than leaving a pin or a sync to pick one of them.
 *
 * @param root The repo root.
 * @return The units.
 */
export function findUnits(root: string): Unit[] {
  const units: Unit[] = [];

  if (fs.existsSync(path.join(root, 'paf.json'))) {
    const name = path.basename(path.resolve(root));

    units.push({ dir: root, rel: '.', name, where: name });
  }

  for (const folder of ['watchfaces', 'watchapps']) {
    const dir = path.join(root, folder);
    const entries = fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : [];

    for (const entry of entries.filter((item) => item.isDirectory()).sort((first, second) => first.name.localeCompare(second.name))) {
      if (!fs.existsSync(path.join(dir, entry.name, 'paf.json'))) {
        continue;
      }

      const rel = `${folder}/${entry.name}`;
      const clash = units.find((unit) => unit.name === entry.name);

      if (clash) {
        throw new Error(`two units are named ${entry.name}, at ${clash.where} and ${rel}. Rename one of the folders`);
      }

      units.push({ dir: path.join(dir, entry.name), rel, name: entry.name, where: rel });
    }
  }

  return units;
}

/**
 * The faces in a unit, by name.
 *
 * @param dir The unit's folder.
 * @return The faces, ordered by name.
 */
export function unitFaces(dir: string): Face[] {
  if (fs.existsSync(path.join(dir, APPINFO_REL))) {
    const appinfo = JSON.parse(fs.readFileSync(path.join(dir, APPINFO_REL), 'utf8'));

    if (!appinfo.name) {
      throw new Error(`the face at ${dir} needs a name in its ${APPINFO_REL.split(path.sep).join('/')}`);
    }

    return [{ name: appinfo.name, rel: '.' }];
  }

  if (!fs.existsSync(path.join(dir, 'core'))) {
    return [];
  }

  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(dir, entry.name, APPINFO_REL)))
    .map((entry) => ({ name: entry.name, rel: entry.name }))
    .sort((first, second) => first.name.localeCompare(second.name));
}

/** A face and the unit holding it. */
export type Located = {
  unit: Unit;
  face: Face;
};

/**
 * Every face in the repo, each with its unit. Two faces with one name are refused, since a face's name
 * is its build folder and its release tag.
 *
 * @param units The repo's units.
 * @param unreadable Collects a line for each unit whose faces could not be read.
 * @return The faces, in unit order.
 */
export function allFaces(units: Unit[], unreadable: string[] = []): Located[] {
  // a unit whose appinfo cannot be read is left out and named, so one half-edited file never stops
  // work on every other unit
  const found = units.flatMap((unit) => {
    try {
      return unitFaces(unit.dir).map((face) => ({ unit, face }));
    } catch (error) {
      unreadable.push(`${unit.rel}: ${messageOf(error)}`);
      return [];
    }
  });
  const seen = new Map<string, string>();

  for (const { unit, face } of found) {
    const first = seen.get(face.name);

    if (first) {
      throw new Error(`two faces are named ${face.name}, in ${first} and ${unit.rel}. A face's name has to be unique in the repo`);
    }

    seen.set(face.name, unit.rel);
  }

  return found;
}

/**
 * The face with a name, and its unit.
 *
 * @param units The repo's units.
 * @param name The face's name.
 * @return The face and its unit.
 */
export function findFace(units: Unit[], name: string): Located {
  const unreadable: string[] = [];
  const match = allFaces(units, unreadable).find((entry) => entry.face.name === name);

  if (!match) {
    throw new Error(`no face called ${name}. Run paf status for the faces here${unreadable.length ? `. These could not be read: ${unreadable.join('. ')}` : ''}`);
  }

  return match;
}

/**
 * The unit a name means: a unit by its own name, or the unit holding a face by that name.
 *
 * @param units The repo's units.
 * @param name A unit's or a face's name.
 * @return The unit.
 */
export function findUnit(units: Unit[], name: string): Unit {
  const byName = units.find((unit) => unit.name === name);

  if (byName) {
    return byName;
  }

  const unreadable: string[] = [];
  const byFace = allFaces(units, unreadable).find((entry) => entry.face.name === name);

  if (!byFace) {
    throw new Error(`no unit or face called ${name}. Run paf status for the units here${unreadable.length ? `. These could not be read: ${unreadable.join('. ')}` : ''}`);
  }

  return byFace.unit;
}
