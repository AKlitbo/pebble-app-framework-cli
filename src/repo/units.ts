/**
 * Finding the units in a face repo, and the faces in each.
 *
 * A unit is a folder with a paf.config.json: the repo root, for a repo that is one face or one family,
 * or a folder straight under watchfaces/ or watchapps/, for a family or a face of its own. The two
 * folders only sort faces from apps, and a unit in either is laid out the same. Each one keeps its own
 * copy of the framework, its own package.json, and its own node_modules, so it works like a small repo.
 *
 * Inside a unit a face sits in one of two places. A unit that is a face has its appinfo at its own
 * root. A unit that is a family has a core/ and one folder per face beside it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { messageOf } from '../shared/errors.ts';
import { inSentence } from '../shared/words.ts';
import { CONFIG_FILE } from '../unit/config.ts';

/** The unit file paf 1.0.0 reads, which a unit moving to this paf renames by hand. */
const OLD_CONFIG_FILE = 'paf.json';

/** The appinfo that makes a folder a face, which sits at the face's own root. */
export const APPINFO_REL = 'pebble.appinfo.json';

/** Where framework 3 keeps a face's appinfo, which a unit moving to framework 4 moves up a folder. */
const OLD_APPINFO_REL = 'config/pebble.appinfo.json';

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
 * refused rather than leaving a pin or a sync to pick one of them. A paf.json anywhere a unit can sit
 * stops every command and names each one, since a repo half on paf 1.0.0's file would sync some units
 * and not others. A folder holding both files is named too, so a half-moved unit is caught.
 *
 * @param root The repo root.
 * @return The units.
 */
export function findUnits(root: string): Unit[] {
  const units: Unit[] = [];
  const unmoved: string[] = [];
  let clash: string | null = null;
  const rootName = path.basename(path.resolve(root));

  if (fs.existsSync(path.join(root, OLD_CONFIG_FILE))) {
    unmoved.push(rootName);
  }

  if (fs.existsSync(path.join(root, CONFIG_FILE))) {
    units.push({ dir: root, rel: '.', name: rootName, where: rootName });
  }

  for (const folder of ['watchfaces', 'watchapps']) {
    const dir = path.join(root, folder);
    const entries = fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : [];

    for (const entry of entries.filter((item) => item.isDirectory()).sort((first, second) => first.name.localeCompare(second.name))) {
      const rel = `${folder}/${entry.name}`;

      if (fs.existsSync(path.join(dir, entry.name, OLD_CONFIG_FILE))) {
        unmoved.push(rel);
      }

      if (!fs.existsSync(path.join(dir, entry.name, CONFIG_FILE))) {
        continue;
      }

      const other = units.find((unit) => unit.name === entry.name);

      // a clash is only reported once the walk is done, so a leftover paf.json is named first
      if (other && !clash) {
        clash = `two units are named ${entry.name}, at ${other.where} and ${rel}. Rename one of the folders`;
      }

      units.push({ dir: path.join(dir, entry.name), rel, name: entry.name, where: rel });
    }
  }

  if (unmoved.length) {
    throw new Error(`${inSentence(unmoved)} still ${unmoved.length === 1 ? 'has' : 'have'} a paf.json, which paf 1.0.0 reads. This paf reads paf.config.json. Move each unit by hand, then delete its paf.json`);
  }

  if (clash) {
    throw new Error(clash);
  }

  return units;
}

/**
 * The folders a family's faces can sit in, which are the ones beside its core/. A unit with no core/ is
 * not a family and has none.
 */
function familyFolders(dir: string): string[] {
  if (!fs.existsSync(path.join(dir, 'core'))) {
    return [];
  }

  return fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

/**
 * Names any face in a unit that still keeps its appinfo in config/. Left alone such a face would not
 * count as one, so its unit would read as holding none, and sync, check, and test would pass without it.
 *
 * @param dir The unit's folder.
 * @param from The folder each file is named from, for a message that does not name the unit already.
 * @param folders The folders beside a family's core/, when the caller has them already.
 * @return What to move, or null when every face's appinfo is at its own root.
 */
export function oldAppinfoProblem(dir: string, from = '', folders: string[] = familyFolders(dir)): string | null {
  const left = [OLD_APPINFO_REL, ...folders.map((name) => `${name}/${OLD_APPINFO_REL}`)]
    .filter((rel) => fs.existsSync(path.join(dir, rel)))
    .map((rel) => path.posix.join(from, rel))
    .sort();

  if (left.length === 0) {
    return null;
  }

  return `${inSentence(left)} ${left.length === 1 ? 'is' : 'are'} where framework 3 keeps an appinfo. Move each up a folder, beside the face's src/, since framework 4 finds a face by the ${APPINFO_REL} at its own root`;
}

/**
 * The faces in a unit, by name.
 *
 * @param dir The unit's folder.
 * @return The faces, ordered by name.
 */
export function unitFaces(dir: string): Face[] {
  const folders = familyFolders(dir);
  const old = oldAppinfoProblem(dir, '', folders);

  if (old) {
    throw new Error(old);
  }

  if (fs.existsSync(path.join(dir, APPINFO_REL))) {
    const appinfo = JSON.parse(fs.readFileSync(path.join(dir, APPINFO_REL), 'utf8'));

    if (!appinfo.name) {
      throw new Error(`the face at ${dir} needs a name in its ${APPINFO_REL}`);
    }

    return [{ name: appinfo.name, rel: '.' }];
  }

  return folders
    .filter((name) => fs.existsSync(path.join(dir, name, APPINFO_REL)))
    .map((name) => ({ name, rel: name }))
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
