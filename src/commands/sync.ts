/**
 * paf sync and paf use: putting the right framework in each unit's lib/, and its node_modules beside it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { mirrorOf, resolveRef, updateMirror } from '../framework/mirror.ts';
import { readPin, writePin } from '../repo/pin.ts';
import { findUnit, findUnits, type Unit } from '../repo/units.ts';
import type { Context } from '../shared/context.ts';
import { must } from '../shared/runner.ts';
import { installState, listsLibWorkspace, lockHash, readInstallStamp, writeInstallStamp } from '../unit/install.ts';
import { fillFromClone, fillFromTag, foreignLib, frameworkPackageHash, readStamp, writeStamp } from '../unit/lib.ts';
import { messageOf } from '../shared/errors.ts';

export type SyncOptions = {
  locked: boolean;
  force: boolean;
  /** Put a unit on a local framework back on its tag, which a plain sync leaves where it is. */
  repin?: boolean;
};

/**
 * Every unit in the repo, or an error saying how to make one.
 *
 * @param ctx The command context.
 * @return The units.
 */
export function unitsOf(ctx: Context): Unit[] {
  const units = findUnits(ctx.root);

  if (units.length === 0) {
    throw new Error('no units here. A unit is a folder with a paf.json holding { "framework": "<tag>" }, at the repo root or under watchfaces/ or watchapps/');
  }

  return units;
}

/**
 * A commit hash cut down for printing.
 *
 * @param commit The full hash.
 * @return Its first seven characters.
 */
export function short(commit: string): string {
  return commit.slice(0, 7);
}

/**
 * Stops before a command changes a unit it should not, so a refusal leaves the unit as it was rather
 * than with a new framework and the old install. sync, use, and pin all run it before they write.
 *
 * A node_modules installed from the other system stops it unless --force says to replace it, and so
 * does a lib/ paf did not fill, a unit with no package.json or none listing lib as a workspace, and a
 * --locked run with no lock.
 *
 * @param ctx The command context.
 * @param unit The unit.
 * @param options Whether to reinstall over another system's install.
 */
export function checkUnit(ctx: Context, unit: Unit, options: SyncOptions): void {
  const stamp = readInstallStamp(unit.dir);

  if (installState(fs.existsSync(path.join(unit.dir, 'node_modules')), stamp, ctx.platform, null) === 'other-system' && !options.force) {
    throw new Error(`${unit.rel}/node_modules was installed from ${stamp?.platform}, and its native packages only run there. Run paf sync --force to reinstall it for ${ctx.platform}, which breaks it for the other one`);
  }

  const foreign = foreignLib(unit.dir);

  if (foreign) {
    throw foreign;
  }

  // npm looks for the nearest folder holding a package.json, so in a unit with none it climbs to the
  // repo root and writes that folder's lock and node_modules
  if (!fs.existsSync(path.join(unit.dir, 'package.json'))) {
    throw new Error(`${unit.rel} has no package.json, so npm would install into the folder above it. Give it one with "workspaces": ["lib"]`);
  }

  // without lib in its workspaces npm never installs the framework's packages, and the lock can never
  // record lib, so every sync would call it behind
  if (!listsLibWorkspace(unit.dir)) {
    throw new Error(`${unit.rel}/package.json does not list lib in its workspaces, so npm never installs the framework's packages. Add "workspaces": ["lib"]`);
  }

  if (options.locked && !lockHash(unit.dir)) {
    throw new Error(`${unit.rel} has no package-lock.json, and --locked writes none`);
  }
}

/**
 * Installs a unit's node_modules from its lock when the lock, the system, or the framework's
 * package.json in lib/ changed since the last install. npm reads nothing else in lib/, so an edit to a
 * local framework's code never costs an install.
 *
 * Outside CI it runs npm install, which installs what the lock records and only changes the lock when
 * a package.json asks for something it lacks, such as a framework that moved. A --locked run uses npm
 * ci, which never writes the lock and stops with npm's own message when the lock is out of step, so a
 * lock nobody updated fails CI rather than being rewritten there. The caller runs checkUnit first.
 *
 * @param ctx The command context.
 * @param unit The unit.
 * @param options Whether this is a CI run that must write nothing.
 */
export function installUnit(ctx: Context, unit: Unit, options: SyncOptions): void {
  const lock = lockHash(unit.dir);
  const framework = frameworkPackageHash(unit.dir);
  const stamp = readInstallStamp(unit.dir);
  const state = installState(fs.existsSync(path.join(unit.dir, 'node_modules')), stamp, ctx.platform, lock, framework);

  if (state === 'current') {
    return;
  }

  // npm install keeps packages it finds at the right version, the other system's native builds
  // included. an install from the other system, or one with no stamp to say which system made it, is
  // cleared for a clean install, along with any npm nested in lib/
  if (state === 'other-system' || (stamp === null && fs.existsSync(path.join(unit.dir, 'node_modules')))) {
    fs.rmSync(path.join(unit.dir, 'node_modules'), { recursive: true, force: true });
    fs.rmSync(path.join(unit.dir, 'lib', 'node_modules'), { recursive: true, force: true });
  }

  if (options.locked) {
    ctx.print(`${unit.where}: installing node_modules from package-lock.json`);
    must(ctx.run, 'npm', ['ci', '--no-audit', '--no-fund'], { cwd: unit.dir });
  } else {
    ctx.print(`${unit.where}: installing node_modules, which brings the lock up to date if the framework moved`);
    must(ctx.run, 'npm', ['install', '--no-audit', '--no-fund'], { cwd: unit.dir });
  }

  writeInstallStamp(unit.dir, { platform: ctx.platform, lock: lockHash(unit.dir), framework });
}

/**
 * Puts a unit's lib/ on its pinned tag and installs its node_modules.
 *
 * The mirror has to be fetched first. A tag that points at a different commit from the one paf.json
 * recorded stops the sync, since a framework that changes under a finished face without anyone moving
 * its pin is the thing pins exist to prevent. A unit on a local framework stays on it, copied from its
 * clone again so the build takes the clone's latest edits.
 *
 * @param ctx The command context.
 * @param unit The unit.
 * @param options Whether this is a CI run, and whether to reinstall over another system's install.
 */
export function syncUnit(ctx: Context, unit: Unit, options: SyncOptions): void {
  checkUnit(ctx, unit, options);

  const stamp = readStamp(unit.dir);

  // a local lib/ comes from its clone, so it needs neither the mirror nor the pinned tag
  if (stamp?.local && !options.repin) {
    if (options.locked) {
      throw new Error(`${unit.rel}/lib is on the local framework at ${stamp.local}, not its pinned tag. Run paf use ${unit.name} pinned first`);
    }

    // the clone's path was recorded by whichever system ran paf use, and the other one cannot read it
    if (!fs.existsSync(stamp.local)) {
      throw new Error(`${unit.rel}/lib was copied from ${stamp.local}, which is not there, and may have been recorded from the other system. Run paf use ${unit.name} local <path> with the clone's path here, or paf use ${unit.name} pinned`);
    }

    const copied = fillFromClone(ctx.run, stamp.local, unit.dir);

    ctx.print(`${unit.where}: lib/ stays on the local framework at ${stamp.local}${copied.changed ? ', with its latest edits copied in' : ''}. paf use ${unit.name} pinned puts it back on its tag`);
    installUnit(ctx, unit, options);
    return;
  }

  const pin = readPin(unit.dir);
  const commit = resolveRef(ctx.run, mirrorOf(ctx), pin.framework);

  if (!commit) {
    throw new Error(`${unit.rel}/paf.json pins ${pin.framework}, which the framework has no tag for`);
  }

  if (!pin.commit) {
    if (options.locked) {
      throw new Error(`${unit.rel}/paf.json records no commit for ${pin.framework}, and --locked writes none. Run paf pin ${unit.name} ${pin.framework}`);
    }

    writePin(unit.dir, { framework: pin.framework, commit });
  } else if (pin.commit !== commit) {
    throw new Error(`${pin.framework} now points at ${short(commit)}, but ${unit.rel}/paf.json recorded ${short(pin.commit)}. If the move is expected, run paf pin ${unit.name} ${pin.framework} to take it`);
  }

  if (stamp?.local || stamp?.commit !== commit) {
    const count = fillFromTag(ctx.run, mirrorOf(ctx), unit.dir, pin.framework, commit);

    ctx.print(`${unit.where}: lib/ is on ${pin.framework} (${short(commit)}), ${count} files`);
  } else if (stamp.tag !== pin.framework) {
    // a release cut on its last candidate's commit holds the same files, so only the stamp moves
    writeStamp(path.join(unit.dir, 'lib'), { commit, tag: pin.framework });
    ctx.print(`${unit.where}: lib/ is on ${pin.framework} (${short(commit)}), the same files as ${stamp.tag}`);
  }

  installUnit(ctx, unit, options);
}

/**
 * paf sync [unit] [--locked] [--force]
 *
 * @param ctx The command context.
 * @param target A unit or face to sync, or undefined for every unit.
 * @param options Whether this is a CI run, and whether to reinstall over another system's install.
 * @return The exit code.
 */
export function sync(ctx: Context, target: string | undefined, options: SyncOptions): number {
  const units = unitsOf(ctx);

  const targets = target ? [findUnit(units, target)] : units;

  // a unit on a local framework needs no mirror, so a sync of only those skips the fetch
  if (targets.some((unit) => !readStamp(unit.dir)?.local)) {
    updateMirror(ctx.run, mirrorOf(ctx), ctx.repo);
  }

  // every unit is tried, so a CI run reports each problem rather than only the first
  const failed: string[] = [];

  for (const unit of targets) {
    try {
      syncUnit(ctx, unit, options);
    } catch (error) {
      ctx.print(`${unit.where}: ${messageOf(error)}`);
      failed.push(unit.where);
    }
  }

  if (failed.length) {
    ctx.print(`sync failed in ${failed.join(', ')}`);
    return 1;
  }

  return 0;
}

/**
 * paf use <unit> local [path] | paf use <unit> pinned
 *
 * Points one unit's lib/ at a local framework clone, working tree included, or back at its tag. The
 * build reads the same lib/, and every sync copies the clone again, so fixing the framework and building
 * a face against the fix is one loop.
 *
 * @param ctx The command context.
 * @param target The unit or face.
 * @param mode local or pinned.
 * @param clone The clone, for local. Defaults to a pebble-app-framework folder beside the repo.
 * @return The exit code.
 */
export function use(ctx: Context, target: string | undefined, mode: string | undefined, clone: string | undefined): number {
  if (!target || (mode !== 'local' && mode !== 'pinned')) {
    throw new Error('usage: paf use <unit> local [path] | paf use <unit> pinned');
  }

  const unit = findUnit(unitsOf(ctx), target);

  if (mode === 'pinned') {
    updateMirror(ctx.run, mirrorOf(ctx), ctx.repo);

    // the local lib/ is only swapped out once the sync's checks pass, so a refusal leaves it working
    syncUnit(ctx, unit, { locked: false, force: false, repin: true });
    return 0;
  }

  const source = path.resolve(clone ?? path.join(ctx.root, '..', 'pebble-app-framework'));

  // any other folder, the face repo itself included, would be copied into lib/ whole
  let name: unknown;

  try {
    name = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8')).name;
  } catch {
    name = undefined;
  }

  if (name !== 'pebble-app-framework') {
    throw new Error(`no framework clone at ${source}, since its package.json does not name pebble-app-framework. Pass its path: paf use ${unit.name} local <path>`);
  }

  checkUnit(ctx, unit, { locked: false, force: false });

  const { commit, count } = fillFromClone(ctx.run, source, unit.dir);

  ctx.print(`${unit.where}: lib/ is on ${short(commit)} from ${source}, working tree included, ${count} files`);
  ctx.print(`paf sync --locked refuses until paf use ${unit.name} pinned`);
  installUnit(ctx, unit, { locked: false, force: false });

  return 0;
}
