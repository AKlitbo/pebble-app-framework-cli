/**
 * paf pin: moving one unit to another framework tag, with the changelog between the two shown first.
 */
import { breakingEntries, sectionsBetween } from '../framework/changelog.ts';
import { listFolders, listTags, mirrorOf, resolveRef, showFile, updateMirror } from '../framework/mirror.ts';
import { PLUGINS_DIR, SHIP_ROOT, shipPathspecs } from '../framework/ship.ts';
import { compareTags, isVersionTag } from '../framework/tags.ts';
import { FRAMEWORK_MAJOR, fillableTags, latestTag, readConfigIfSet, readListed, unfillable, writePin } from '../unit/config.ts';
import { findUnit, unitFaces } from '../repo/units.ts';
import type { Context } from '../shared/context.ts';
import { readStamp } from '../unit/framework.ts';
import { checkUnit, short, syncUnit, unitsOf } from './sync.ts';

/**
 * paf pin <unit> <tag|latest>
 *
 * Moves one unit and nothing else. A face in a family moves with its family, so naming the face moves
 * the family. Pinning the tag a unit is already on takes a tag that moved since it was recorded.
 *
 * @param ctx The command context.
 * @param target The unit, or a face in it.
 * @param wanted A tag, or latest.
 * @return The exit code.
 */
export function pin(ctx: Context, target: string | undefined, wanted: string | undefined): number {
  if (!target || !wanted) {
    throw new Error('usage: paf pin <unit> <tag|latest>');
  }

  const unit = findUnit(unitsOf(ctx), target);
  const mirror = mirrorOf(ctx);

  updateMirror(ctx.run, mirror, ctx.repo);

  const tags = listTags(ctx.run, mirror);
  const tag = wanted === 'latest' ? latestTag(tags) : wanted;

  if (!tag) {
    throw new Error(`the framework has no framework ${FRAMEWORK_MAJOR} tag for latest yet`);
  }

  // the hint only offers tags this paf can pin
  const recent = fillableTags(tags).sort(compareTags).reverse().slice(0, 5).join(', ') || 'none yet';
  // a pin has to be a framework 4 version tag, since the changelog it prints, latest, and the tag order
  // all read it as one. it is checked before the mirror is asked for its commit, and before anything is
  // printed or written
  const why = unfillable(tag);

  if (why) {
    throw new Error(`cannot pin ${why}. This paf pins framework ${FRAMEWORK_MAJOR} tags. Recent ones: ${recent}`);
  }

  const commit = resolveRef(ctx.run, mirror, tag);

  if (!commit) {
    throw new Error(`the framework has no tag ${tag}. Recent framework ${FRAMEWORK_MAJOR} tags: ${recent}`);
  }

  // a unit whose paf.config.json names no framework yet is taking its first pin
  const old = readConfigIfSet(unit.dir);

  // a unit already past latest, such as one on a newer candidate, stays rather than moving back to an
  // older framework. one past it on a framework this paf cannot fill, or on a tag this mirror lacks, such
  // as a candidate cut in a local clone, moves back to latest instead, since staying would leave it on a
  // pin the sync straight after refuses
  const stays = old !== null && wanted === 'latest' && unfillable(old.framework) === null && compareTags(tag, old.framework) < 0;
  // a unit on a local framework builds from its clone whatever it pins, so it is described by the clone
  const local = readStamp(unit.dir)?.local;

  // a unit on its clone moves onto a tag with every pin, since a pin says which framework paf/ holds.
  // it is said once the sync has done it, so a sync that fails leaves no line saying it moved
  const movedOff = (onto: string) => {
    if (local) {
      ctx.print(`${unit.name} moved off the local framework at ${local} onto ${onto}`);
    }
  };

  const oldCommit = old && stays ? resolveRef(ctx.run, mirror, old.framework) : null;

  if (old && stays && oldCommit) {
    // the sync straight after fills from the tag the unit stays on, so it has to have every plugin the
    // unit lists, checked before anything is printed, as a move below does
    shipPathspecs(readListed(unit.dir).plugins, listFolders(ctx.run, mirror, oldCommit, PLUGINS_DIR), old.framework);

    checkUnit(ctx, unit, { locked: false, force: false });
    ctx.print(local
      ? `${unit.name} pins ${old.framework}, which is newer than latest, ${tag}, so it stays on ${old.framework}`
      : `${unit.name} is on ${old.framework}, which is newer than latest, ${tag}, so it stays`);
    syncUnit(ctx, unit, { locked: false, force: false, repin: true });
    movedOff(old.framework);
    return 0;
  }

  // the tag has to have every plugin the unit lists, checked before anything is printed or written, since
  // the sync after the pin would refuse it with paf.config.json already naming the tag
  shipPathspecs(readListed(unit.dir).plugins, listFolders(ctx.run, mirror, commit, PLUGINS_DIR), tag);

  // the pin is only written once the sync can go ahead, so a refusal leaves paf.config.json and paf/
  // agreeing
  checkUnit(ctx, unit, { locked: false, force: false });

  if (old && old.framework === tag) {
    // a unit already on the tag still syncs, so a paf/ that is missing or behind gets filled
    if (old.commit === commit) {
      ctx.print(local ? `${unit.name} is already pinned to ${tag}` : `${unit.name} is already on ${tag}`);
      syncUnit(ctx, unit, { locked: false, force: false, repin: true });
      movedOff(tag);
      return 0;
    }

    ctx.print(`${tag} moved from ${old.commit ? short(old.commit) : 'an unrecorded commit'} to ${short(commit)}`);
  } else {
    // only a version tag can be newer, so a move off a pin that is not one reads as a move forward
    const back = old !== null && isVersionTag(old.framework) && compareTags(tag, old.framework) < 0;
    const newer = back && old ? old.framework : tag;
    const sections = sectionsBetween(showFile(ctx.run, mirror, newer, `${SHIP_ROOT}/CHANGELOG.md`) ?? '', old?.framework ?? null, tag);
    const breaking = breakingEntries(sections);
    const entries = sections.split('\n').filter((line) => line.startsWith('- ')).length;

    ctx.print(old ? `${unit.name}: ${old.framework} to ${tag}` : `${unit.name}: first pin, ${tag}`);

    if (breaking.length) {
      ctx.print('Breaking');

      for (const line of breaking) {
        ctx.print(`  ${line}`);
      }
    }

    // moving back, the entries being left are in the paf/ there now, which the move replaces
    ctx.print(back
      ? `${entries - breaking.length} other changelog entries being left behind. The full list is in paf/CHANGELOG.md until the pin moves`
      : `${entries - breaking.length} other changelog entries. The full list is in paf/CHANGELOG.md once the pin moves`);

    // the face names are only for the hint, so an appinfo that cannot be read leaves the hint out
    // rather than stopping the pin after its changelog has printed
    try {
      ctx.print(`then run paf gen <face> all for ${unitFaces(unit.dir).map((face) => face.name).join(', ')}`);
    } catch {
      ctx.print('then run paf gen <face> all for each face in the unit');
    }
  }

  writePin(unit.dir, { framework: tag, commit });
  syncUnit(ctx, unit, { locked: false, force: false, repin: true });
  movedOff(tag);

  return 0;
}
