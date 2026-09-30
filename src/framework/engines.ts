/**
 * The Node the framework asks for, from engines.node in its package.json.
 *
 * paf runs on Nodes the framework does not take. Outside the ones it names a tool can stop partway, or on
 * a Node with no import.meta.main, stop before it starts. So paf compares the two before it runs any
 * script a unit's keys or gen name.
 */
import fs from 'node:fs';
import path from 'node:path';
import { FRAMEWORK_DIR } from '../unit/framework.ts';
import { messageOf } from '../shared/errors.ts';
import { isObject } from '../shared/json.ts';
import { compareVersions } from './toolchain.ts';

/** One part of a range of the forms the framework writes, >= or ^ and a version of one to three parts. */
const PART = /^(>=|\^)\s*(\d+(?:\.\d+){0,2})$/;

/**
 * Whether a Node version is inside a range of the forms the framework writes: parts joined by ||, each
 * >= a version or ^ a version. Any other form is refused rather than guessed at, since a range read as
 * nothing would let every script run anyway.
 *
 * @param range The range, such as ^22.18.0 || >=24.2.0.
 * @param version The Node version, such as 23.11.0 or 24.2.0-rc.1.
 * @return Whether the version is inside the range.
 */
export function nodeSatisfies(range: string, version: string): boolean {
  const parts = range.split('||').map((part) => PART.exec(part.trim()));

  if (parts.some((part) => part === null)) {
    throw new Error(`the Node range ${range} is not one paf reads. paf reads parts such as ^22.18.0 and >=24.2.0, joined by ||`);
  }

  // a prerelease sits just below its release, the way npm reads it, so 24.2.0-rc.1 is not >=24.2.0
  const [release, prerelease] = version.split('-', 2);

  return parts.some((part) => {
    const [, kind, floor] = part as RegExpExecArray;
    const above = prerelease === undefined ? compareVersions(release, floor) >= 0 : compareVersions(release, floor) > 0;

    // ^ keeps to the floor's major, the way npm reads it for any major above 0
    return above && (kind === '>=' || release.split('.')[0] === floor.split('.')[0]);
  });
}

/** The Node range a framework package.json asks for, or null when it names none. */
function rangeOf(text: string, file: string): string | null {
  let data: unknown;

  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`${file} could not be read. ${messageOf(error)}`, { cause: error });
  }

  const engines = isObject(data) ? data.engines : undefined;
  const node = isObject(engines) ? engines.node : undefined;

  if (node !== undefined && typeof node !== 'string') {
    throw new Error(`${file} gives engines.node as something other than text`);
  }

  return node ?? null;
}

/**
 * The Node range the framework in a unit's paf/ asks for.
 *
 * @param unitDir The unit's folder.
 * @return engines.node from paf/package.json, or null when it names none or there is no paf/ yet.
 */
export function frameworkEngines(unitDir: string): string | null {
  const file = path.join(unitDir, FRAMEWORK_DIR, 'package.json');
  let text: string;

  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }

    throw new Error(`${file} could not be read. ${messageOf(error)}`, { cause: error });
  }

  return rangeOf(text, file);
}

/**
 * Why a unit's scripts cannot run under this Node, or null when they can.
 *
 * @param range The range the framework asks for, or null for none.
 * @param version The Node paf is running on.
 * @param asker What asks for the range, for the message, such as paf/package.json.
 * @return The reason, naming the range and the version, or null.
 */
export function wrongNode(range: string | null, version: string, asker: string): string | null {
  if (range === null || nodeSatisfies(range, version)) {
    return null;
  }

  return `${asker} asks for Node ${range}, and this is ${version}. Outside it a tool can stop partway, or stop before it starts, so run paf from a Node inside it`;
}
