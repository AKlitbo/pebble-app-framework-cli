/**
 * paf gen, check, and tool: the commands that run what the framework and a unit's listed plugins offer
 * through their paf keys, each against the unit's own paf/.
 */
import fs from 'node:fs';
import path from 'node:path';
import { applies, clashMessage, genPlan, notOffered, parseKey, readKeys, type Keyed } from '../framework/keys.ts';
import { listFolders, mirrorOf, showFile } from '../framework/mirror.ts';
import { PLUGINS_DIR } from '../framework/ship.ts';
import { findFace, findUnit } from '../repo/units.ts';
import type { Context } from '../shared/context.ts';
import { messageOf } from '../shared/errors.ts';
import { readStamp, type UnitFramework } from '../unit/framework.ts';
import { runFrameworkScript } from '../unit/scripts.ts';
import { readyForScripts, scriptArgs, tryReady } from './run.ts';
import { unitsOf } from './sync.ts';

/**
 * The keys of the plugins the unit's framework has and the unit does not list, read from the tag in the
 * mirror or from the local clone, since paf/ only holds the listed ones. Only a message about a name
 * nobody listed reads them, so a plugin that cannot be read is skipped, a list that cannot be read gives
 * null, and the message says less rather than stopping.
 *
 * The commit is read from paf/ as the sync just left it, since what the command read before the sync
 * may be the tag the unit was on before a teammate moved it, or nothing on a first sync.
 */
function unlistedKeys(ctx: Context, unitDir: string, read: UnitFramework): Keyed[] | null {
  const keyed = (name: string, dir: string, text: () => string | null): Keyed[] => {
    try {
      const content = text();

      return content === null ? [] : [{ plugin: name, owner: `the ${name} plugin`, dir, key: parseKey(content, `${dir}/package.json`) }];
    } catch {
      return [];
    }
  };

  try {
    if (read.local) {
      const plugins = path.join(read.stamp.local, PLUGINS_DIR);

      return fs.readdirSync(plugins, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !read.plugins.includes(entry.name))
        .flatMap((entry) => keyed(entry.name, path.join(plugins, entry.name), () => fs.readFileSync(path.join(plugins, entry.name, 'package.json'), 'utf8')));
    }

    const commit = readStamp(unitDir)?.commit;

    if (!commit) {
      return null;
    }

    const mirror = mirrorOf(ctx);

    return listFolders(ctx.run, mirror, commit, PLUGINS_DIR)
      .filter((name) => !read.plugins.includes(name))
      .flatMap((name) => keyed(name, `${PLUGINS_DIR}/${name}`, () => showFile(ctx.run, mirror, commit, `${PLUGINS_DIR}/${name}/package.json`)));
  } catch {
    return null;
  }
}

/**
 * paf gen <face> <kind|all>
 *
 * all runs every generator the face holds the inputs for, in the order genPlan gives, each with its
 * allArgs, and stops at the first that fails. A single kind runs whether or not the face holds its
 * inputs, since the generator's own error names what is missing, and takes the arguments typed after it
 * rather than its allArgs, so a background run for one theme bakes that theme.
 *
 * @param ctx The command context.
 * @param face The face.
 * @param kind A generator, such as clay or background, or all.
 * @param args More arguments for a single generator.
 * @return The exit code, the failing generator's own when one fails.
 */
export function gen(ctx: Context, face: string | undefined, kind: string | undefined, args: string[]): number {
  if (!face || !kind) {
    throw new Error('usage: paf gen <face> <kind|all> [args]');
  }

  const rest = scriptArgs(args);

  if (kind === 'all' && rest.length) {
    throw new Error(`paf gen <face> all takes nothing after all, since each generator gets its own arguments. Run one kind to pass ${rest.join(' ')}`);
  }

  const { unit, face: found } = findFace(unitsOf(ctx), face);
  const read = readyForScripts(ctx, unit, true);
  const plan = genPlan(readKeys(unit.dir, read.plugins), read.gen, unit.dir);

  if (kind !== 'all') {
    const step = plan.find((each) => each.name === kind);

    if (!step) {
      throw new Error(notOffered('gen', kind, plan.map((each) => each.name), unlistedKeys(ctx, unit.dir, read)));
    }

    return runFrameworkScript(ctx, unit, step.dir, step.script, [found.name, ...rest]);
  }

  const faceDir = path.join(unit.dir, found.rel);
  const steps = plan.filter((step) => applies(step.when, faceDir, unit.dir));

  if (steps.length === 0) {
    ctx.print(`${found.name} has nothing to generate`);
    return 0;
  }

  for (const step of steps) {
    ctx.print(`== gen ${step.name}: ${found.name} ==`);

    const code = runFrameworkScript(ctx, unit, step.dir, step.script, [found.name, ...(step.allArgs ?? [])]);

    if (code !== 0) {
      return code;
    }
  }

  return 0;
}

/**
 * paf check [unit]
 *
 * Runs every check the core and each listed plugin ship, in every unit or one. Every check runs to the
 * end whether or not another failed, so one stale face in the first unit never hides the next unit's.
 *
 * @param ctx The command context.
 * @param target A unit or face, or undefined for every unit.
 * @return The exit code.
 */
export function check(ctx: Context, target: string | undefined): number {
  const units = unitsOf(ctx);
  const failed: string[] = [];

  for (const unit of target ? [findUnit(units, target)] : units) {
    ctx.print(`== check: ${unit.where} ==`);

    const read = tryReady(ctx, unit, readyForScripts);
    let passed = read !== null;

    try {
      for (const { dir, key } of read ? readKeys(unit.dir, read.plugins) : []) {
        for (const script of key.check ?? []) {
          // a check paf refuses to run fails on its own, and the rest still run
          try {
            passed = runFrameworkScript(ctx, unit, dir, script, []) === 0 && passed;
          } catch (error) {
            ctx.print(`${unit.where}: ${messageOf(error)}`);
            passed = false;
          }
        }
      }
    } catch (error) {
      ctx.print(`${unit.where}: ${messageOf(error)}`);
      passed = false;
    }

    if (!passed) {
      failed.push(unit.where);
    }
  }

  if (failed.length) {
    ctx.print(`check failed in ${failed.join(', ')}`);
    return 1;
  }

  return 0;
}

/**
 * paf tool <face> <name> [args]
 *
 * Runs a tool a listed plugin names under tools, with the face first and every argument after the name
 * as typed, -h and -- included. Only a .ts script runs, which keeps shell scripts out of a unit for good.
 *
 * @param ctx The command context.
 * @param face The face.
 * @param name The tool, such as clay-preview or tap-walk.
 * @param args Its arguments.
 * @return The tool's exit code.
 */
export function tool(ctx: Context, face: string | undefined, name: string | undefined, args: string[]): number {
  if (!face || !name) {
    throw new Error('usage: paf tool <face> <name> [args]');
  }

  const { unit, face: found } = findFace(unitsOf(ctx), face);
  const read = readyForScripts(ctx, unit, true);
  const offered = readKeys(unit.dir, read.plugins).flatMap(({ owner, dir, key }) => Object.entries(key.tools ?? {}).map(([toolName, entry]) => ({ name: toolName, owner, dir, script: entry.script })));
  const matches = offered.filter((each) => each.name === name);

  if (matches.length === 0) {
    throw new Error(notOffered('tools', name, offered.map((each) => each.name), unlistedKeys(ctx, unit.dir, read)));
  }

  if (matches.length > 1) {
    throw new Error(clashMessage('tool', name, matches[0].owner, matches[1].owner));
  }

  const [match] = matches;

  return runFrameworkScript(ctx, unit, match.dir, match.script, [found.name, ...args]);
}
