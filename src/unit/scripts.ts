/**
 * Running one of the framework's scripts in a unit: a generator, a check, a tool, or a lint or format
 * script a paf key names.
 */
import path from 'node:path';
import type { Unit } from '../repo/units.ts';
import type { Context } from '../shared/context.ts';
import { isScript } from '../shared/json.ts';

/**
 * The flag every framework script runs with. The framework's package.json has no type, so Node reads
 * each .ts script twice to work out it is a module and warns about it on every run.
 */
export const SCRIPT_FLAGS = ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON'];

/**
 * Refuses a script that is not .ts, which node would only fail on with an error about its own syntax.
 *
 * @param dir The folder the script's path is relative to.
 * @param script The script's path from that folder.
 */
export function refuseNonScript(dir: string, script: string): void {
  if (!isScript(script)) {
    throw new Error(`${path.join(dir, script)} is not a .ts script, and paf only runs .ts scripts`);
  }
}

/**
 * Runs a framework script under the Node paf is on, from the unit's folder, and gives its exit code.
 *
 * The output goes straight through and nothing times it out, since clay-preview --watch runs until it is
 * stopped and a tap walk prints each shot as it goes. The exit code is read once the child has ended,
 * since the framework's scripts end through process.exitCode rather than process.exit, and it is passed
 * on as it is, so a wrapper can tell a usage error from a failed run. A script that is not .ts is refused
 * here rather than when its key is read, so one bad entry only stops a run of itself. The Node is checked
 * by each command once its sync is done, through readyForScripts.
 *
 * @param ctx The command context.
 * @param unit The unit, whose folder the script runs from.
 * @param dir The folder the script's path is relative to, paf/, a plugin's folder, or the unit's.
 * @param script The script's path from that folder.
 * @param args Its arguments.
 * @return Its exit code.
 */
export function runFrameworkScript(ctx: Context, unit: Unit, dir: string, script: string, args: string[]): number {
  refuseNonScript(dir, script);

  return ctx.run(process.execPath, [...SCRIPT_FLAGS, path.join(dir, script), ...args], { cwd: unit.dir }).code;
}
