/**
 * A unit's paf.json: the framework tag it builds on, and the commit that tag pointed at when it was
 * pinned. A tag that later points somewhere else is caught against the recorded commit rather than
 * followed quietly.
 */
import fs from 'node:fs';
import path from 'node:path';
import { messageOf } from '../shared/errors.ts';

export type Pin = {
  framework: string;
  commit?: string;
};

/** paf.json as it is on disk, with an error naming the file when it cannot be read. */
function readPinFile(dir: string): Record<string, unknown> {
  const file = path.join(dir, 'paf.json');

  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${file} could not be read. ${messageOf(error)}`, { cause: error });
  }
}

/** The pin in paf.json's data, or null when it names no framework. */
function pinFrom(data: Record<string, unknown>): Pin | null {
  if (typeof data.framework !== 'string' || !data.framework) {
    return null;
  }

  return { framework: data.framework, commit: typeof data.commit === 'string' ? data.commit : undefined };
}

/**
 * Reads a unit's paf.json.
 *
 * @param dir The unit's folder.
 * @return The pin.
 */
export function readPin(dir: string): Pin {
  const pin = pinFrom(readPinFile(dir));

  if (!pin) {
    throw new Error(`${path.join(dir, 'paf.json')} names no framework tag. It holds { "framework": "<tag>" }`);
  }

  return pin;
}

/**
 * Reads a unit's paf.json for a pin, which may be moving it for the first time.
 *
 * @param dir The unit's folder.
 * @return The pin, or null when paf.json names no framework yet.
 */
export function readPinIfSet(dir: string): Pin | null {
  return pinFrom(readPinFile(dir));
}

/**
 * Writes a unit's paf.json.
 *
 * @param dir The unit's folder.
 * @param pin The tag and its commit.
 */
export function writePin(dir: string, pin: Pin): void {
  // any other key the file holds, such as a $schema or a note, is kept
  let kept: Record<string, unknown>;

  try {
    const data = JSON.parse(fs.readFileSync(path.join(dir, 'paf.json'), 'utf8'));

    kept = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    kept = {};
  }

  fs.writeFileSync(path.join(dir, 'paf.json'), JSON.stringify({ ...kept, framework: pin.framework, commit: pin.commit }, null, 2) + '\n');
}
