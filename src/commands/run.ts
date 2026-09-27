/**
 * paf build, gen, run, test, lint, and typecheck: the commands that run the framework's own tools
 * inside a unit, against that unit's lib/.
 */
import fs from 'node:fs';
import path from 'node:path';
import { mirrorOf, resolveRef, updateMirror } from '../framework/mirror.ts';
import { readPin } from '../repo/pin.ts';
import { allFaces, findFace, findUnit, APPINFO_REL, type Located, type Unit } from '../repo/units.ts';
import type { Context } from '../shared/context.ts';
import { lockHash } from '../unit/install.ts';
import { configureIdentity, readStamp } from '../unit/lib.ts';
import { syncUnit, unitsOf } from './sync.ts';
import { messageOf } from '../shared/errors.ts';
import { sha256 } from '../shared/hash.ts';

// the mirrors this command has fetched. paf runs one command and exits, so this lasts one command
const fetched = new Set<string>();

/**
 * Makes sure a unit's lib/ and node_modules match its pin before running anything in it. The mirror is
 * only fetched when there is none yet, or it lacks the pinned tag or has it at another commit, such as
 * after a teammate pinned and pushed, so a build works offline once a sync has run.
 *
 * @param ctx The command context.
 * @param unit The unit.
 */
export function ready(ctx: Context, unit: Unit): void {
  // a local lib/ comes from its clone, so a build on it works offline and whatever the tag does
  if (!readStamp(unit.dir)?.local) {
    const mirror = mirrorOf(ctx);
    const pin = readPin(unit.dir);
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

  syncUnit(ctx, unit, { locked: false, force: false });
}

/** Readies a unit and says whether it could be, printing why not, so a run over many units carries on past it. */
function tryReady(ctx: Context, unit: Unit): boolean {
  try {
    ready(ctx, unit);
    return true;
  } catch (error) {
    ctx.print(`${unit.where}: ${messageOf(error)}`);
    return false;
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
 * lib/, and a build only reads them at configure time, so a different framework there starts clean
 * too. What a build was made from is only recorded
 * when it passes, and a failed one leaves its build folder behind, so with no record the build starts
 * clean too.
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
    return 'the framework in lib/ changed since the last build here';
  }

  return null;
}

/** What a face is built from now: its message keys, the unit's lock, and what its lib/ holds. */
function inputsOf(unit: Unit, located: Located): BuildInputs {
  const appinfo = JSON.parse(fs.readFileSync(path.join(unit.dir, located.face.rel, APPINFO_REL), 'utf8'));
  const keys = sha256(JSON.stringify(appinfo.messageKeys ?? []));

  return { keys, lock: lockHash(unit.dir) ?? '', framework: configureIdentity(unit.dir) };
}

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

/** Runs a program in a unit and says whether it passed. */
function runIn(ctx: Context, unit: Unit, command: string, args: string[]): boolean {
  return ctx.run(command, args, { cwd: unit.dir }).code === 0;
}

/**
 * paf build <face|all> [--clean]
 *
 * @param ctx The command context.
 * @param target A face, or all.
 * @param args Arguments for the framework's build.sh. --clean forces a clean build.
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
  const readied = new Map<string, boolean>();
  let failed = unreadable.length;

  for (const line of unreadable) {
    ctx.print(line);
  }

  for (const located of faces) {
    const { unit } = located;

    if (!readied.has(unit.dir)) {
      readied.set(unit.dir, tryReady(ctx, unit));
    }

    if (!readied.get(unit.dir)) {
      failed++;
      continue;
    }

    const { [located.face.name]: last, ...others } = readBuildState(unit);
    let now: BuildInputs;

    // one face's appinfo that cannot be read fails that face and leaves the rest of build all to go on
    try {
      now = inputsOf(unit, located);
    } catch (error) {
      ctx.print(`${located.face.name}: ${messageOf(error)}`);
      failed++;
      continue;
    }

    const reason = args.includes('--clean') ? null : cleanReason(last, now);
    const buildArgs = reason ? [...args, '--clean'] : args;

    if (reason) {
      ctx.print(`== ${located.face.name}: ${reason}, so this one is clean ==`);
    }

    // a build that fails partway has already set up its sandbox from the new inputs, so the old record
    // goes first, and a failure leaves none, which makes the next build clean
    if (last) {
      fs.writeFileSync(buildStateFile(unit), JSON.stringify(others, null, 2) + '\n');
    }

    if (!runIn(ctx, unit, 'bash', ['lib/build.sh', located.face.name, ...buildArgs])) {
      failed++;
      continue;
    }

    fs.mkdirSync(path.dirname(buildStateFile(unit)), { recursive: true });
    fs.writeFileSync(buildStateFile(unit), JSON.stringify({ ...others, [located.face.name]: now }, null, 2) + '\n');
  }

  return failed ? 1 : 0;
}

/**
 * What `paf gen <face> all` runs: the unit's own gen:<face> script when it has one, since that already
 * knows the face's steps, and otherwise each framework generator the face has inputs for.
 *
 * @param scripts The unit's package.json scripts.
 * @param face The face's name.
 * @param has Whether the face (or its family core) holds a path, relative to the face.
 * @return The npm scripts to run, each with its arguments.
 */
export function genAllSteps(scripts: Record<string, string>, face: string, has: (rel: string) => boolean): string[][] {
  if (scripts[`gen:${face}`]) {
    return [[`gen:${face}`]];
  }

  const steps: string[][] = [];

  if (has('resources/icons.json')) {
    steps.push(['gen:icons', '--', face]);
  }

  if (has('frame/frame.config.json')) {
    steps.push(['gen:frame', '--', face, '--theme', 'all']);
  }

  if (has('src/pkjs/clay/builder')) {
    steps.push(['gen:clay', '--', face]);
  }

  if (has('resources/thumbnails')) {
    steps.push(['gen:thumbnails', '--', face]);
  }

  return steps;
}

/** The unit's package.json scripts. */
function scriptsOf(unit: Unit): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(path.join(unit.dir, 'package.json'), 'utf8')).scripts ?? {};
  } catch {
    return {};
  }
}

/**
 * paf gen <face> <kind|all>
 *
 * @param ctx The command context.
 * @param face The face.
 * @param kind A generator, such as clay or frame, or all.
 * @param args More arguments for a single generator.
 * @return The exit code.
 */
export function gen(ctx: Context, face: string | undefined, kind: string | undefined, args: string[]): number {
  if (!face || !kind) {
    throw new Error('usage: paf gen <face> <kind|all>');
  }

  const located = findFace(unitsOf(ctx), face);
  const { unit } = located;
  const faceDir = path.join(unit.dir, located.face.rel);
  const has = (rel: string) => fs.existsSync(path.join(faceDir, rel)) || (rel.startsWith('src/pkjs/') && fs.existsSync(path.join(unit.dir, 'core', rel.slice(4))));
  const steps = kind === 'all' ? genAllSteps(scriptsOf(unit), face, has) : [[`gen:${kind}`, '--', face, ...scriptArgs(args)]];

  ready(ctx, unit);

  if (steps.length === 0) {
    ctx.print(`${face} has nothing to generate`);
    return 0;
  }

  for (const step of steps) {
    if (!runIn(ctx, unit, 'npm', ['run', ...step])) {
      return 1;
    }
  }

  return 0;
}

/** The arguments for a script, with a -- the user typed out of habit dropped, since paf adds npm's own. */
function scriptArgs(args: string[]): string[] {
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
export function check(ctx: Context, script: string, target: string | undefined): number {
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
