/**
 * paf status and doctor: reading where each unit stands without changing anything.
 */
import fs from 'node:fs';
import path from 'node:path';
import { listTags, mirrorOf } from '../framework/mirror.ts';
import { compareTags } from '../framework/tags.ts';
import { frameworkEngines, wrongNode } from '../framework/engines.ts';
import { compareVersions, parsePebbleVersion, parseToolchain, type Toolchain } from '../framework/toolchain.ts';
import { fillableTags, latestTag, pinnedTag } from '../unit/config.ts';
import { unitFaces, type Unit } from '../repo/units.ts';
import type { Context } from '../shared/context.ts';
import { installState, lockHash, readInstallStamp } from '../unit/install.ts';
import { messageOf } from '../shared/errors.ts';
import { FRAMEWORK_DIR, frameworkPackageHash, holdsPlugins, readStamp, unitFramework } from '../unit/framework.ts';
import { unitsOf } from './sync.ts';

/**
 * The tag a unit pins, or ? when its paf.config.json cannot be read, which its state column then
 * explains. A pin this paf cannot fill is still shown, since it is the one the unit has to move off.
 */
function tagOf(unit: Unit): string {
  return pinnedTag(unit.dir) ?? '?';
}

/**
 * The toolchain each framework in the units' paf/ folders records, keyed by what paf/ holds: the tag
 * it was filled from, or the local clone it was copied from. A unit whose paf.config.json was pulled
 * to a new tag before a sync still holds the old one, so the stamp says which, not the pin. A unit
 * whose paf/ has no toolchain to read is left out.
 */
function toolchainsByFramework(units: Unit[], toolchains: Map<Unit, Toolchain | Error | null>): Map<string, { toolchain: Toolchain; units: string[] }> {
  const found = new Map<string, { toolchain: Toolchain; units: string[] }>();

  for (const unit of units) {
    const toolchain = toolchains.get(unit);

    if (!toolchain || toolchain instanceof Error) {
      continue;
    }

    const stamp = readStamp(unit.dir);
    const key = stamp?.local ? `the local framework at ${stamp.local}` : stamp?.tag ?? tagOf(unit);

    found.set(key, { toolchain, units: [...(found.get(key)?.units ?? []), unit.name] });
  }

  return found;
}

/** A unit's face names, or ? when an appinfo cannot be read. */
function facesOf(unit: Unit): string {
  try {
    return unitFaces(unit.dir).map((face) => face.name).join(', ');
  } catch {
    return '?';
  }
}

/**
 * Where one unit stands: ready, on a local framework, needing a sync, or a problem reading it. A unit
 * that cannot be read is reported rather than thrown, so one bad unit never hides the rest.
 *
 * @param ctx The command context.
 * @param unit The unit.
 * @return A short state for the status table.
 */
export function unitState(ctx: Context, unit: Unit): string {
  try {
    return stateOf(ctx, unit);
  } catch (error) {
    return `problem: ${messageOf(error)}`;
  }
}

function stateOf(ctx: Context, unit: Unit): string {
  // a unit on a local framework builds from its clone whatever it pins, the way sync and build treat it.
  // its file is still read, so a broken one shows here rather than at the next paf pin
  const read = unitFramework(unit.dir);

  if (read.local) {
    return `local, ${read.stamp.local}`;
  }

  const { stamp, config } = read;

  if (!stamp || !config.commit || stamp.commit !== config.commit || !holdsPlugins(stamp, read.plugins)) {
    return 'needs paf sync';
  }

  const install = readInstallStamp(unit.dir);
  const state = installState(fs.existsSync(path.join(unit.dir, 'node_modules')), install, ctx.platform, lockHash(unit.dir), frameworkPackageHash(unit.dir));

  if (state === 'other-system') {
    return `node_modules from ${install?.platform}`;
  }

  return state === 'current' ? 'ready' : 'needs paf sync';
}

/** Pads each column to its widest cell. */
function table(rows: string[][]): string[] {
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)));

  return rows.map((row) => row.map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column]))).join('  '));
}

/** The toolchain a unit's paf/ records, null when paf/ has none, or the error that stopped the read. */
function toolchainOf(unit: Unit): Toolchain | Error | null {
  const file = path.join(unit.dir, FRAMEWORK_DIR, 'toolchain.json');

  try {
    return fs.existsSync(file) ? parseToolchain(fs.readFileSync(file, 'utf8')) : null;
  } catch (error) {
    return new Error(`${unit.rel}/${FRAMEWORK_DIR}/toolchain.json: ${messageOf(error)}`);
  }
}

/** What `pebble --version` reports, or null when there is no pebble here. */
function activePebble(ctx: Context): { tool: string | null; sdk: string | null } | null {
  const result = ctx.run('pebble', ['--version'], { cwd: ctx.root, capture: true });

  return result.code === 0 ? parsePebbleVersion(`${result.stdout}\n${result.stderr}`) : null;
}

/**
 * The SDK verdict for one framework tag: ok, behind, or a note that the SDK is newer. Being newer never
 * fails, or a unit left on an old tag would nag forever once the SDK moved on.
 *
 * @param active The active SDK.
 * @param built The SDK the tag was built with.
 * @return The verdict's word and whether it is a problem.
 */
export function sdkVerdict(active: string, built: string): { word: string; problem: boolean } {
  const difference = compareVersions(active, built);

  if (difference < 0) {
    return { word: 'behind', problem: true };
  }

  return { word: difference > 0 ? 'note' : 'ok', problem: false };
}

/**
 * paf status
 *
 * @param ctx The command context.
 * @return The exit code.
 */
export function status(ctx: Context): number {
  const units = unitsOf(ctx);
  const known = fs.existsSync(path.join(mirrorOf(ctx), 'HEAD')) ? listTags(ctx.run, mirrorOf(ctx)) : [];
  // the same tag paf pin <unit> latest takes, never a framework 3 release it would refuse
  const latest = latestTag(known) ?? '?';
  const rows = [['UNIT', 'FACES', 'TAG', 'LATEST', 'STATE']];

  for (const unit of units) {
    rows.push([unit.where, facesOf(unit), tagOf(unit), latest, unitState(ctx, unit)]);
  }

  for (const line of table(rows)) {
    ctx.print(line);
  }

  ctx.print('LATEST is the newest framework 4 tag as of the last fetch, a release when there is one, and paf sync fetches again.');

  const pebble = activePebble(ctx);
  const built = [...toolchainsByFramework(units, new Map(units.map((unit) => [unit, toolchainOf(unit)]))).entries()].map(([framework, { toolchain }]) => `${framework} was built with ${toolchain.sdk}`);

  ctx.print('');
  ctx.print(`toolchain: ${pebble?.sdk ? `SDK ${pebble.sdk} active` : 'no pebble here'}${built.length ? `. ${built.join(', ')}` : ''}`);

  return 0;
}

/**
 * The framework action tags a repo's workflows load, such as v3.0.0 from
 * `pebble-app-framework/.github/actions/setup-pebble@v3.0.0`.
 *
 * @param text A workflow file's text.
 * @return Each tag, in the order the file loads them.
 */
export function workflowActionTags(text: string): string[] {
  return [...text.matchAll(/pebble-app-framework\/\.github\/actions\/[\w-]+@(v[0-9A-Za-z.-]+)/g)].map((match) => match[1]);
}

/**
 * paf doctor
 *
 * @param ctx The command context.
 * @return The exit code, 1 when there is a problem.
 */
export function doctor(ctx: Context): number {
  const units = unitsOf(ctx);
  let problems = 0;
  const say = (word: string, text: string) => {
    ctx.print(`${word.padEnd(8)} ${text}`);

    if (word === 'problem' || word === 'behind') {
      problems++;
    }
  };

  const git = ctx.run('git', ['--version'], { cwd: ctx.root, capture: true });

  say(git.code === 0 ? 'ok' : 'problem', git.code === 0 ? git.stdout.trim() : 'git is not on the PATH');
  say('ok', `node ${ctx.node}`);

  // one git check-ignore for every folder, which prints back the ones that are ignored. git quotes a
  // path holding a backslash, or one outside ASCII unless core.quotePath is off, so the paths are
  // relative to the repo with forward slashes and quoting is turned off. the trailing slash tells git
  // each is a folder, so a pattern matches before paf first makes it
  const folder = (unit: Unit, name: string) => `${unit.rel}/${name}/`;
  const folders = units.flatMap((unit) => [FRAMEWORK_DIR, 'targets', `${FRAMEWORK_DIR}.paf-new`, `${FRAMEWORK_DIR}.paf-old`].map((name) => folder(unit, name)));
  const ignored = new Set(ctx.run('git', ['-c', 'core.quotePath=false', 'check-ignore', ...folders], { cwd: ctx.root, capture: true }).stdout.split(/\r?\n/).filter(Boolean));

  for (const unit of units) {
    if (!ignored.has(folder(unit, FRAMEWORK_DIR))) {
      say('problem', `${unit.rel}/${FRAMEWORK_DIR} is not gitignored, so the framework copy could be committed`);
    }

    if (!ignored.has(folder(unit, `${FRAMEWORK_DIR}.paf-new`)) || !ignored.has(folder(unit, `${FRAMEWORK_DIR}.paf-old`))) {
      say('problem', `${unit.rel}/${FRAMEWORK_DIR}.paf-*/ is not gitignored, so a framework copy a stopped swap leaves could be committed`);
    }

    if (!ignored.has(folder(unit, 'targets'))) {
      say('problem', `${unit.rel}/targets is not gitignored, so build output and paf's build record could be committed`);
    }

    // a swap that stopped partway, such as a delete an open file on Windows held up, leaves one of these.
    // it only holds a framework copy and its install, which the next sync fills again
    for (const left of fs.readdirSync(unit.dir).filter((name) => name === `${FRAMEWORK_DIR}.paf-new` || name === `${FRAMEWORK_DIR}.paf-old`)) {
      say('problem', `${unit.rel}/${left} is left from a paf/ swap that stopped partway. Delete it, or paf sync ${unit.name} clears it`);
    }
  }

  // a unit on a local framework is the paf use local loop working as meant, so it is a note, not a problem
  const states = units.map((unit) => ({ unit, state: unitState(ctx, unit) }));
  const local = states.filter(({ state }) => state.startsWith('local, '));
  const unready = states.filter(({ state }) => state !== 'ready' && !state.startsWith('local, '));

  say(unready.length ? 'problem' : 'ok', unready.length ? `${unready.map(({ unit }) => unit.rel).join(', ')} need attention, see paf status` : 'every unit on a tag matches its pin');

  if (local.length) {
    say('note', `${local.map(({ unit }) => unit.rel).join(', ')} on a local framework, which paf use <unit> pinned puts back on its tag`);
  }

  // paf build, gen, check, and tool refuse a unit's scripts under a Node outside its framework's range.
  // paf/ is read as it is, so a unit whose pin moved since its last sync is sent to paf sync as well
  for (const unit of units) {
    try {
      const wrong = wrongNode(frameworkEngines(unit.dir), ctx.node, 'paf/package.json');

      if (wrong) {
        say('problem', `${unit.where}: ${wrong}, or run paf sync if its pin moved since the last one`);
      }
    } catch (error) {
      say('problem', `${unit.where}: ${messageOf(error)}`);
    }
  }

  // a toolchain paf cannot read is a problem whether or not there is a pebble to compare it with
  const toolchains = new Map(units.map((unit) => [unit, toolchainOf(unit)]));

  for (const toolchain of toolchains.values()) {
    if (toolchain instanceof Error) {
      say('problem', toolchain.message);
    }
  }

  const pebble = activePebble(ctx);

  if (!pebble) {
    say('skipped', 'no pebble on the PATH, which on Windows outside WSL is expected');
  } else {
    say('ok', `pebble-tool ${pebble.tool ?? 'of an unknown version'}`);

    for (const [tag, { toolchain, units: names }] of toolchainsByFramework(units, toolchains)) {
      if (!pebble.sdk) {
        continue;
      }

      const verdict = sdkVerdict(pebble.sdk, toolchain.sdk);
      const detail = verdict.word === 'ok' ? `is what ${tag} was built with` : `is ${verdict.word === 'behind' ? 'older' : 'newer'} than ${toolchain.sdk}, which ${tag} was built with`;

      say(verdict.word, `SDK ${pebble.sdk} ${detail} (${names.join(', ')})`);
    }
  }

  const workflows = path.join(ctx.root, '.github', 'workflows');
  // only a tag this paf fills sets which action tag the workflows want, never a leftover framework 3 pin
  const newest = fillableTags(units.map(tagOf)).sort(compareTags).at(-1);

  if (newest && fs.existsSync(workflows)) {
    for (const file of fs.readdirSync(workflows).filter((name) => /\.ya?ml$/.test(name))) {
      const text = fs.readFileSync(path.join(workflows, file), 'utf8');
      const stale = workflowActionTags(text).filter((tag) => compareTags(tag, newest) < 0);

      if (stale.length) {
        say('problem', `.github/workflows/${file} loads the framework's actions at ${stale[0]}, older than ${newest}. Move them to @${newest}`);
      }

      // a paf/ holds only what the framework ships from its src/, which leaves out .github/, so no
      // unit's paf/ has the actions, the repo root's included
      if (text.includes(`./${FRAMEWORK_DIR}/.github/actions/`)) {
        say('problem', `.github/workflows/${file} loads actions from ./${FRAMEWORK_DIR}, which the framework copy there does not have. Load them from AKlitbo/pebble-app-framework at @${newest}`);
      }
    }
  }

  return problems ? 1 : 0;
}
