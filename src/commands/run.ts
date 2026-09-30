/**
 * paf build, run, test, lint, and typecheck: the commands that run a unit's own npm scripts or the
 * framework's build inside a unit, against that unit's paf/.
 */
import fs from 'node:fs';
import path from 'node:path';
import { mirrorOf, resolveRef, updateMirror } from '../framework/mirror.ts';
import { allFaces, findFace, findUnit, APPINFO_REL, type Located, type Unit } from '../repo/units.ts';
import type { Context } from '../shared/context.ts';
import { lockHash } from '../unit/install.ts';
import { configureIdentity, unitFramework, type UnitFramework } from '../unit/framework.ts';
import { refuseNonScript, runFrameworkScript } from '../unit/scripts.ts';
import { frameworkEngines, wrongNode } from '../framework/engines.ts';
import { readKeys } from '../framework/keys.ts';
import { checkUnit, syncUnit, unitsOf } from './sync.ts';
import { messageOf } from '../shared/errors.ts';
import { sha256 } from '../shared/hash.ts';

// the mirrors this command has fetched. paf runs one command and exits, so this lasts one command
const fetched = new Set<string>();

/**
 * Makes sure a unit's paf/ and node_modules match its pin before running anything in it. The mirror is
 * only fetched when there is none yet, or it lacks the pinned tag or has it at another commit, such as
 * after a teammate pinned and pushed, so a build works offline once a sync has run.
 *
 * @param ctx The command context.
 * @param unit The unit.
 * @return What the unit builds from, read before the sync, which leaves its pin and plugins as they were.
 */
export function ready(ctx: Context, unit: Unit): UnitFramework {
  // a pin this paf cannot fill stops here, before the mirror is asked
  const read = unitFramework(unit.dir);

  // so does a unit the sync would refuse, since offline a fetch error would come first and hide what
  // to fix
  checkUnit(ctx, unit, { locked: false, force: false });

  // a local paf/ comes from its clone, so a build on it works offline and whatever the tag does
  if (!read.local) {
    const mirror = mirrorOf(ctx);
    const pin = read.config;
    const commit = resolveRef(ctx.run, mirror, pin.framework);

    // a commit other than the recorded one is usually a mirror fetched before a teammate took a moved
    // tag, so the mirror is fetched before the sync calls it a move. with no commit recorded yet, the
    // sync is about to record one, so it takes the tag from a fresh fetch. one fetch serves every unit
    // a command readies
    if ((!commit || !pin.commit || commit !== pin.commit) && !fetched.has(mirror)) {
      updateMirror(ctx.run, mirror, ctx.repo);
      fetched.add(mirror);
    }
  }

  syncUnit(ctx, unit, { locked: false, force: false }, read);

  return read;
}

/**
 * Readies a unit for a command that runs the scripts its keys or gen name, then refuses a Node outside
 * the range its framework asks for. The range is read once the sync is done, from the framework the unit
 * builds on now, since the paf/ before it may be a stale copy the sync replaces with one that takes this
 * Node.
 *
 * @param ctx The command context.
 * @param unit The unit.
 * @param named Whether the refusal names the unit, for a command that does not name it already. tryReady
 * puts the unit in front of whatever it prints.
 * @return What the unit builds from.
 */
export function readyForScripts(ctx: Context, unit: Unit, named = false): UnitFramework {
  const read = ready(ctx, unit);
  const wrong = wrongNode(frameworkEngines(unit.dir), ctx.node, named ? `${unit.rel === '.' ? '' : `${unit.rel}/`}paf/package.json` : 'paf/package.json');

  if (wrong) {
    throw new Error(wrong);
  }

  return read;
}

/**
 * Readies a unit and gives what it builds from, or null after printing why it could not be readied, so
 * a run over many units carries on past it.
 *
 * @param ctx The command context.
 * @param unit The unit.
 * @param get How to ready it, ready or readyForScripts.
 * @return What the unit builds from, or null.
 */
export function tryReady(ctx: Context, unit: Unit, get: (ctx: Context, unit: Unit) => UnitFramework = ready): UnitFramework | null {
  try {
    return get(ctx, unit);
  } catch (error) {
    ctx.print(`${unit.where}: ${messageOf(error)}`);
    return null;
  }
}

/** What a face's last build here was made from, so the next one knows when it has to start clean. */
export type BuildInputs = {
  keys: string;
  lock: string;
  framework: string;
};

/**
 * Why a build has to start clean, or null when an incremental one is safe.
 *
 * The SDK only reads message keys at configure time, so a new key fails an incremental build on an
 * undeclared MESSAGE_KEY_ name. The bundle step does not track node_modules, so a changed dependency
 * ships the old library in a build that reports success. The waf helpers and the wscript come from
 * paf/, and waf does not track their code, so outputs the old helpers made would stay, and a different
 * framework there starts clean too. What a build was made from is only recorded when it passes, and a
 * failed one leaves its build folder behind, so with no record the build starts clean too.
 *
 * @param last What the last passing build here was made from, or undefined for none.
 * @param now What this one is made from.
 * @return The reason, or null.
 */
export function cleanReason(last: BuildInputs | undefined, now: BuildInputs): string | null {
  if (!last) {
    return 'no passing build here to go on from';
  }

  if (last.keys !== now.keys) {
    return 'message keys changed since the last build here';
  }

  if (last.lock !== now.lock) {
    return 'dependencies changed since the last build here';
  }

  if (last.framework !== now.framework) {
    return 'the framework in paf/ changed since the last build here';
  }

  return null;
}

/** What a face is built from now: its message keys, the unit's lock, and what its paf/ holds, worked out once per unit. */
function inputsOf(unit: Unit, located: Located, framework: string): BuildInputs {
  const appinfo = JSON.parse(fs.readFileSync(path.join(unit.dir, located.face.rel, APPINFO_REL), 'utf8'));
  const keys = sha256(JSON.stringify(appinfo.messageKeys ?? []));

  return { keys, lock: lockHash(unit.dir) ?? '', framework };
}

/** What a build runs in a unit: the core's build script and what the unit's paf/ is set up from. */
type UnitBuild = {
  dir: string;
  script: string;
  framework: string;
};

/** Where paf keeps what each face's last build was made from, inside the unit's gitignored targets/. */
function buildStateFile(unit: Unit): string {
  return path.join(unit.dir, 'targets', '.paf-build.json');
}

function readBuildState(unit: Unit): Record<string, BuildInputs> {
  try {
    return JSON.parse(fs.readFileSync(buildStateFile(unit), 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Readies a unit for a build and finds the build script the core names under its paf key, printing why
 * once when either fails, so build all carries on to the next unit. Only the core's key is read, since
 * a build never runs anything a plugin offers, and a plugin's broken key should not stop it.
 */
function unitBuildOf(ctx: Context, unit: Unit): UnitBuild | null {
  if (!tryReady(ctx, unit, readyForScripts)) {
    return null;
  }

  try {
    const [core] = readKeys(unit.dir, []);
    const script = core.key.build?.script;

    if (!script) {
      throw new Error('paf/package.json names no build script under its paf key');
    }

    // checked here, where a refusal is printed once and build all goes on to the next unit. thrown from
    // the face loop, it would stop build all with that face's build record already cleared
    refuseNonScript(core.dir, script);

    return { dir: core.dir, script, framework: configureIdentity(unit.dir) };
  } catch (error) {
    ctx.print(`${unit.where}: ${messageOf(error)}`);
    return null;
  }
}

/** Runs a program in a unit and says whether it passed. */
function runIn(ctx: Context, unit: Unit, command: string, args: string[]): boolean {
  return ctx.run(command, args, { cwd: unit.dir }).code === 0;
}

/**
 * paf build <face|all> [--clean]
 *
 * @param ctx The command context.
 * @param target A face, or all.
 * @param args Arguments for the framework's build script, which passes all but --clean on to pebble
 * build. --clean forces a clean build.
 * @return The exit code.
 */
export function build(ctx: Context, target: string | undefined, args: string[]): number {
  if (!target) {
    throw new Error('usage: paf build <face|all> [--clean]');
  }

  if (ctx.platform === 'win32') {
    throw new Error('paf build runs where the Pebble SDK does, which on Windows means WSL');
  }

  const units = unitsOf(ctx);
  const unreadable: string[] = [];
  const faces = target === 'all' ? allFaces(units, unreadable) : [findFace(units, target)];
  const builds = new Map<string, UnitBuild | null>();
  const rest = scriptArgs(args);
  let failed = unreadable.length;

  for (const line of unreadable) {
    ctx.print(line);
  }

  for (const located of faces) {
    const { unit } = located;

    if (!builds.has(unit.dir)) {
      builds.set(unit.dir, unitBuildOf(ctx, unit));
    }

    const unitBuild = builds.get(unit.dir);

    if (!unitBuild) {
      failed++;
      continue;
    }

    const { [located.face.name]: last, ...others } = readBuildState(unit);
    let now: BuildInputs;

    // one face's appinfo that cannot be read fails that face and leaves the rest of build all to go on
    try {
      now = inputsOf(unit, located, unitBuild.framework);
    } catch (error) {
      ctx.print(`${located.face.name}: ${messageOf(error)}`);
      failed++;
      continue;
    }

    const reason = rest.includes('--clean') ? null : cleanReason(last, now);
    const buildArgs = reason ? [...rest, '--clean'] : rest;

    if (reason) {
      ctx.print(`== ${located.face.name}: ${reason}, so this one is clean ==`);
    }

    // a build that fails partway has already set up its sandbox from the new inputs, so the old record
    // goes first, and a failure leaves none, which makes the next build clean
    if (last) {
      fs.writeFileSync(buildStateFile(unit), JSON.stringify(others, null, 2) + '\n');
    }

    // the face goes first, since the build script refuses anything else there. the output goes straight
    // through, since CI reads the memory report out of the build log
    if (runFrameworkScript(ctx, unit, unitBuild.dir, unitBuild.script, [located.face.name, ...buildArgs]) !== 0) {
      failed++;
      continue;
    }

    fs.mkdirSync(path.dirname(buildStateFile(unit)), { recursive: true });
    fs.writeFileSync(buildStateFile(unit), JSON.stringify({ ...others, [located.face.name]: now }, null, 2) + '\n');
  }

  return failed ? 1 : 0;
}

/**
 * The arguments for a script, with a -- the user typed out of habit dropped. npm run gets its own from
 * paf, and a framework script run through node would read everything after one as a face name.
 *
 * @param args The arguments as typed.
 * @return The arguments to pass on.
 */
export function scriptArgs(args: string[]): string[] {
  return args[0] === '--' ? args.slice(1) : args;
}

/**
 * paf run <unit|face> <script> [args]
 *
 * @param ctx The command context.
 * @param target The unit, or a face in it.
 * @param script The npm script.
 * @param args Its arguments.
 * @return The exit code.
 */
export function runScript(ctx: Context, target: string | undefined, script: string | undefined, args: string[]): number {
  if (!target || !script) {
    throw new Error('usage: paf run <unit|face> <script> [args]');
  }

  const unit = findUnit(unitsOf(ctx), target);

  ready(ctx, unit);

  const rest = scriptArgs(args);

  return runIn(ctx, unit, 'npm', ['run', script, ...(rest.length ? ['--', ...rest] : [])]) ? 0 : 1;
}

/**
 * paf test | lint | typecheck [unit]
 *
 * Every unit runs to the end whether or not another failed, so one failure never hides the rest.
 *
 * @param ctx The command context.
 * @param script test, lint, or typecheck.
 * @param target A unit or face, or undefined for every unit.
 * @return The exit code.
 */
export function unitCheck(ctx: Context, script: string, target: string | undefined): number {
  const units = unitsOf(ctx);
  const failed: string[] = [];

  for (const unit of target ? [findUnit(units, target)] : units) {
    ctx.print(`== ${script}: ${unit.where} ==`);

    if (!tryReady(ctx, unit) || !runIn(ctx, unit, 'npm', ['run', script])) {
      failed.push(unit.where);
    }
  }

  if (failed.length) {
    ctx.print(`${script} failed in ${failed.join(', ')}`);
    return 1;
  }

  return 0;
}
