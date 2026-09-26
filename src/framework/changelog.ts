/**
 * Pulling the framework CHANGELOG.md entries between two tags, so moving a pin shows what moves with it.
 */
import { compareTags, releaseOf } from './tags.ts';

// versions are compared as releases, with any pre-release label dropped. a pin to, from, or between
// release candidates then shows no sections, since a candidate's changes sit under Unreleased and share
// their numbers with the release. candidate tags stay on the machine that made them and are never
// released from, and a pin anyone else sees lands on a release with a heading of its own

/**
 * The changelog sections for every version after `from` up to and including `to`, in the order the
 * file lists them. Moving back to an older tag gives the sections being left behind instead.
 *
 * @param text The framework's CHANGELOG.md, read at the newer of the two tags.
 * @param from The tag the pin moves away from, or null for a new pin.
 * @param to The tag the pin moves to.
 * @return The matching sections, headings included, or an empty string when there are none.
 */
export function sectionsBetween(text: string, from: string | null, to: string): string {
  const target = releaseOf(to);

  if (!target) {
    return '';
  }

  const start = from ? releaseOf(from) : null;
  const [low, high] = start && compareTags(start, target) > 0 ? [target, start] : [start, target];

  // with no starting tag only the target's own section is wanted
  const wanted = (version: string): boolean => compareTags(version, high) <= 0
    && (low ? compareTags(version, low) > 0 : compareTags(version, high) === 0);

  const kept: string[] = [];
  let keeping = false;

  for (const line of text.split(/\r?\n/)) {
    const heading = /^## \[([^\]]+)\]/.exec(line);

    if (heading) {
      const version = releaseOf(heading[1]);

      keeping = version !== null && wanted(version);
    } else if (/^\[[^\]]+\]:\s/.test(line)) {
      // link definitions at the foot of the file end the last section
      keeping = false;
    }

    if (keeping) {
      kept.push(line);
    }
  }

  return kept.join('\n').trim();
}

/**
 * The breaking entries in some changelog sections, each as the one line it is written on.
 *
 * A breaking entry is the one that needs an edit in the face, so it is the part worth reading before
 * anything else.
 *
 * @param sections Changelog text, as sectionsBetween gives it.
 * @return The breaking entries, in file order.
 */
export function breakingEntries(sections: string): string[] {
  return sections.split(/\r?\n/).filter((line) => /^- \*\*Breaking:\*\*/.test(line));
}
