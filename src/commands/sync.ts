/**
 * paf sync and paf use: putting the right framework in each unit's paf/, and its node_modules beside it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { mirrorOf, resolveRef, updateMirror } from '../framework/mirror.ts';
import { configName, readPlugins, writePin } from '../unit/config.ts';
import { findUnit, findUnits, type Unit } from '../repo/units.ts';
import type { Context } from '../shared/context.ts';
import { must } from '../shared/runner.ts';
import { WORKSPACES_LINE, installState, lockHash, markInstallStale, missingWorkspaces, readInstallStamp, writeInstallStamp } from '../unit/install.ts';
import { inSentence } from '../shared/words.ts';
import { FRAMEWORK_DIR, clearSwapLeftovers, fillFromClone, fillFromTag, foreignFramework, frameworkPackageHash, hasOldCopy, holdsPlugins, isFrameworkClone, unitFramework, workspaceFolders, writeStamp, type UnitFramework } from '../unit/framework.ts';
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
    throw new Error('no units here. A unit is a folder with a paf.config.json holding { "framework": "<tag>" }, at the repo root or under watchfaces/ or watchapps/');
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
 * does a paf/ paf did not fill, a unit with no package.json or one missing a framework workspace, and a
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

  const foreign = foreignFramework(unit.dir);

  if (foreign) {
    throw foreign;
  }

  // npm looks for the nearest folder holding a package.json, so in a unit with none it climbs to the
  // repo root and writes that folder's lock and node_modules
  if (!fs.existsSync(path.join(unit.dir, 'package.json'))) {
    throw new Error(`${unit.rel} has no package.json, so npm would install into the folder above it. Give it one with ${WORKSPACES_LINE}`);
  }

  // without paf in its workspaces npm never installs the framework's packages, and without paf/plugins/*
  // never a plugin's, and the lock can never record them, so every sync would call it behind
  const missing = missingWorkspaces(unit.dir);

  if (missing.length) {
    const lost = inSentence(missing.map((workspace) => (workspace === 'paf' ? "the framework's packages" : "the plugins' packages")));

    throw new Error(`${unit.rel}/package.json does not list ${inSentence(missing)} in its workspaces, so npm never installs ${lost}. Make it ${WORKSPACES_LINE}`);
  }

  if (options.locked && !lockHash(unit.dir)) {
    throw new Error(`${unit.rel} has no package-lock.json, and --locked writes none`);
  }
}

/**
 * Installs a unit's node_modules from its lock when the lock, the system, or a package.json in paf/, the
 * framework's or a plugin's, changed since the last install. npm reads nothing else in paf/, so an edit
 * to a local framework's code never costs an install, and listing or dropping a plugin does.
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
  // an old copy left beside paf/ by a swap that stopped, or one that could not delete it, may hold nested
  // installs that never arrived, so the install runs again. the leftovers go once nothing holds them
  if (hasOldCopy(unit.dir)) {
    markInstallStale(unit.dir);
  }

  clearSwapLeftovers(unit.dir);

  const lock = lockHash(unit.dir);
  const framework = frameworkPackageHash(unit.dir);
  const stamp = readInstallStamp(unit.dir);
  const state = installState(fs.existsSync(path.join(unit.dir, 'node_modules')), stamp, ctx.platform, lock, framework);

  if (state === 'current') {
    return;
  }

  // npm install keeps packages it finds at the right version, the other system's native builds
  // included. an install from the other system, or one with no stamp to say which system made it, is
  // cleared for a clean install, along with any npm nested in paf/ or in a plugin
  if (state === 'other-system' || (stamp === null && fs.existsSync(path.join(unit.dir, 'node_modules')))) {
    for (const folder of [unit.dir, ...workspaceFolders(unit.dir)]) {
      fs.rmSync(path.join(folder, 'node_modules'), { recursive: true, force: true });
    }
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
 * Puts a unit's paf/ on its pinned tag and installs its node_modules.
 *
 * The mirror has to be fetched first. A pin below framework 4 stops the sync, and so does a tag that
 * points at a different commit from the one paf.config.json recorded, since a framework that changes
 * under a finished face without anyone moving its pin is the thing pins exist to prevent. A unit on a
 * local framework stays on it, copied from its clone again so the build takes the clone's latest edits.
 *
 * @param ctx The command context.
 * @param unit The unit.
 * @param options Whether this is a CI run, and whether to reinstall over another system's install.
 * @param read What the unit builds from, when the caller has read it already.
 */
export function syncUnit(ctx: Context, unit: Unit, options: SyncOptions, read?: UnitFramework): void {
  checkUnit(ctx, unit, options);

  const framework = read ?? unitFramework(unit.dir, options.repin);

  // a local paf/ comes from its clone, so it needs neither the mirror nor the pinned tag
  if (framework.local) {
    const clone = framework.stamp.local;

    if (options.locked) {
      throw new Error(`${unit.rel}/paf is on the local framework at ${clone}, not its pinned tag. Run paf use ${unit.name} pinned first`);
    }

    // the clone's path was recorded by whichever system ran paf use, and the other one cannot read it
    if (!fs.existsSync(clone)) {
      throw new Error(`${unit.rel}/paf was copied from ${clone}, which is not there, and may have been recorded from the other system. Run paf use ${unit.name} local <path> with the clone's path here, or paf use ${unit.name} pinned`);
    }

    // a clone checked out on a framework 3 branch has no src/ to copy
    if (!isFrameworkClone(clone)) {
      throw new Error(`${unit.rel}/paf was copied from ${clone}, which no longer holds a framework 4 clone, since its src/package.json does not name pebble-app-framework. Check out a framework 4 branch there, or run paf use ${unit.name} pinned`);
    }

    const copied = fillFromClone(ctx.run, clone, unit.dir, framework.plugins);

    ctx.print(`${unit.where}: paf/ stays on the local framework at ${clone}${copied.changed ? ', with its latest edits copied in' : ''}. paf use ${unit.name} pinned puts it back on its tag`);
    installUnit(ctx, unit, options);
    return;
  }

  // a pin this paf cannot fill has already stopped the sync as the file was read, before the mirror was asked
  const { stamp, config: pin, plugins } = framework;
  const commit = resolveRef(ctx.run, mirrorOf(ctx), pin.framework);

  if (!commit) {
    throw new Error(`${configName(unit.dir)} pins ${pin.framework}, which the framework has no tag for`);
  }

  if (!pin.commit) {
    if (options.locked) {
      throw new Error(`${configName(unit.dir)} records no commit for ${pin.framework}, and --locked writes none. Run paf pin ${unit.name} ${pin.framework}`);
    }

    writePin(unit.dir, { framework: pin.framework, commit });
  } else if (pin.commit !== commit) {
    throw new Error(`${pin.framework} now points at ${short(commit)}, but ${configName(unit.dir)} recorded ${short(pin.commit)}. If the move is expected, run paf pin ${unit.name} ${pin.framework} to take it`);
  }

  // a unit that lists another plugin needs filling again at the same tag, which is also when a plugin
  // name the tag does not have is caught
  if (stamp?.local || stamp?.commit !== commit || !holdsPlugins(stamp, plugins)) {
    const count = fillFromTag(ctx.run, mirrorOf(ctx), unit.dir, pin.framework, commit, plugins);

    ctx.print(`${unit.where}: paf/ is on ${pin.framework} (${short(commit)}), ${count} files`);
  } else if (stamp.tag !== pin.framework) {
    // a release cut on its last candidate's commit holds the same files, so only the stamp moves
    writeStamp(path.join(unit.dir, FRAMEWORK_DIR), { commit, tag: pin.framework, plugins: stamp.plugins });
    ctx.print(`${unit.where}: paf/ is on ${pin.framework} (${short(commit)}), the same files as ${stamp.tag}`);
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

  // every unit is tried, so a CI run reports each problem rather than only the first
  const failed: string[] = [];
  const fail = (unit: Unit, error: unknown): void => {
    ctx.print(`${unit.where}: ${messageOf(error)}`);
    failed.push(unit.where);
  };

  // each unit is read and checked once, before the fetch, so a pin this paf cannot fill, or a unit the
  // sync would refuse, is reported even offline, where a fetch error would otherwise stop the run first.
  // a unit on a local framework needs no mirror
  const readable = new Map<Unit, UnitFramework>();

  for (const unit of targets) {
    try {
      const read = unitFramework(unit.dir);

      checkUnit(ctx, unit, options);
      readable.set(unit, read);
    } catch (error) {
      fail(unit, error);
    }
  }

  if ([...readable.values()].some((read) => !read.local)) {
    updateMirror(ctx.run, mirrorOf(ctx), ctx.repo);
  }

  for (const [unit, read] of readable) {
    try {
      syncUnit(ctx, unit, options, read);
    } catch (error) {
      fail(unit, error);
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
 * Points one unit's paf/ at a local framework clone, working tree included, or back at its tag. The
 * build reads the same paf/, and every sync copies the clone again, so fixing the framework and building
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
    // a pin this paf cannot fill stops here, before the fetch it would never use, and so does a unit
    // the sync would refuse
    const read = unitFramework(unit.dir, true);

    checkUnit(ctx, unit, { locked: false, force: false });

    updateMirror(ctx.run, mirrorOf(ctx), ctx.repo);

    // the local paf/ is only swapped out once the sync's checks pass, so a refusal leaves it working
    syncUnit(ctx, unit, { locked: false, force: false, repin: true }, read);
    return 0;
  }

  const source = path.resolve(clone ?? path.join(ctx.root, '..', 'pebble-app-framework'));

  // any other repo with a src/ folder, such as a TypeScript project, would otherwise be mounted as the
  // framework
  if (!isFrameworkClone(source)) {
    throw new Error(`no framework clone at ${source}, since its src/package.json does not name pebble-app-framework. Pass its path: paf use ${unit.name} local <path>`);
  }

  checkUnit(ctx, unit, { locked: false, force: false });

  // the unit's plugins come from its file whatever its pin, since going local is one way to try a
  // framework its pin does not name yet, or to work on a unit before its first pin
  const { commit, count } = fillFromClone(ctx.run, source, unit.dir, readPlugins(unit.dir));

  ctx.print(`${unit.where}: paf/ is on ${short(commit)} from ${source}, working tree included, ${count} files`);
  ctx.print(`paf sync --locked refuses until paf use ${unit.name} pinned`);
  installUnit(ctx, unit, { locked: false, force: false });

  return 0;
}
