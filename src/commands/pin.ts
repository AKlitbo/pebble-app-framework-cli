/**
 * paf pin: moving one unit to another framework tag, with the changelog between the two shown first.
 */
import { breakingEntries, sectionsBetween } from '../framework/changelog.ts';
import { listTags, mirrorOf, resolveRef, showFile, updateMirror } from '../framework/mirror.ts';
import { compareTags, isVersionTag, newestTag } from '../framework/tags.ts';
import { readPinIfSet, writePin } from '../repo/pin.ts';
import { findUnit, unitFaces } from '../repo/units.ts';
import type { Context } from '../shared/context.ts';
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
  const tag = wanted === 'latest' ? newestTag(tags) : wanted;
  // a pin has to be a version tag, since the changelog it prints, latest, and the tag order all read it as one
  const commit = tag && isVersionTag(tag) ? resolveRef(ctx.run, mirror, tag) : null;

  if (!tag || !commit) {
    const recent = tags.filter(isVersionTag).sort(compareTags).reverse().slice(0, 5).join(', ') || 'none';

    throw new Error(`the framework has no version tag ${wanted}. Recent tags: ${recent}`);
  }

  // a unit whose paf.json names no framework yet is taking its first pin
  const old = readPinIfSet(unit.dir);

  // latest is the newest release, and a unit already past it, such as one on a newer candidate, stays
  // rather than moving back to an older framework
  if (old && wanted === 'latest' && isVersionTag(old.framework) && compareTags(tag, old.framework) < 0) {
    ctx.print(`${unit.name} is on ${old.framework}, which is newer than the latest release ${tag}, so it stays`);
    syncUnit(ctx, unit, { locked: false, force: false });
    return 0;
  }

  // the pin is only written once the sync can go ahead, so a refusal leaves paf.json and lib/ agreeing.
  // a unit on a local framework moves onto the tag with it, since a pin says which framework lib/ holds
  checkUnit(ctx, unit, { locked: false, force: false });

  if (old && old.framework === tag) {
    // a unit already on the tag still syncs, so a lib/ that is missing or behind gets filled
    if (old.commit === commit) {
      ctx.print(`${unit.name} is already on ${tag}`);
      syncUnit(ctx, unit, { locked: false, force: false, repin: true });
      return 0;
    }

    ctx.print(`${tag} moved from ${old.commit ? short(old.commit) : 'an unrecorded commit'} to ${short(commit)}`);
  } else {
    const back = old !== null && compareTags(tag, old.framework) < 0;
    const newer = back && old ? old.framework : tag;
    const sections = sectionsBetween(showFile(ctx.run, mirror, newer, 'CHANGELOG.md') ?? '', old?.framework ?? null, tag);
    const breaking = breakingEntries(sections);
    const entries = sections.split('\n').filter((line) => line.startsWith('- ')).length;

    ctx.print(old ? `${unit.name}: ${old.framework} to ${tag}` : `${unit.name}: first pin, ${tag}`);

    if (breaking.length) {
      ctx.print('Breaking');

      for (const line of breaking) {
        ctx.print(`  ${line}`);
      }
    }

    // moving back, the entries being left are in the lib/ there now, which the move replaces
    ctx.print(back
      ? `${entries - breaking.length} other changelog entries being left behind. The full list is in lib/CHANGELOG.md until the pin moves`
      : `${entries - breaking.length} other changelog entries. The full list is in lib/CHANGELOG.md once the pin moves`);

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

  return 0;
}
