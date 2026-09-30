/**
 * Reading framework tags as versions: v3.0.0, v3.1.0-rc.2, and so on.
 */

type Parsed = {
  parts: number[];
  pre: string | null;
};

function parse(tag: string): Parsed | null {
  const match = /^v(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(tag);

  return match ? { parts: match.slice(1, 4).map(Number), pre: match[4] ?? null } : null;
}

/**
 * Whether a tag names a framework version.
 *
 * @param tag The tag.
 * @return True for vX.Y.Z and vX.Y.Z-label.
 */
export function isVersionTag(tag: string): boolean {
  return parse(tag) !== null;
}

/**
 * The major version a tag names, the first of its three numbers.
 *
 * @param tag The tag, such as v4.0.0 or v4.0.0-rc.1.
 * @return The major version, or null for a tag that is not a version.
 */
export function majorOf(tag: string): number | null {
  return parse(tag)?.parts[0] ?? null;
}

/** Compares two pre-release labels the way semver does, number parts as numbers. */
function comparePre(first: string, second: string): number {
  const left = first.split('.');
  const right = second.split('.');

  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    if (left[index] === undefined) {
      return -1;
    }

    if (right[index] === undefined) {
      return 1;
    }

    const numbers = /^\d+$/.test(left[index]) && /^\d+$/.test(right[index]);
    const difference = numbers ? Number(left[index]) - Number(right[index]) : left[index].localeCompare(right[index]);

    if (difference !== 0) {
      return difference;
    }
  }

  return 0;
}

/**
 * The release a version belongs to, as a tag with any pre-release label dropped. `v2.1.1`, `2.1.1`, and
 * `v2.1.1-rc.2` all give `v2.1.1`.
 *
 * @param text A tag, or the version a changelog heading names.
 * @return The release's tag, or null when the text is not a version.
 */
export function releaseOf(text: string): string | null {
  const trimmed = text.trim();
  const parsed = parse(trimmed.startsWith('v') ? trimmed : `v${trimmed}`);

  return parsed ? `v${parsed.parts.join('.')}` : null;
}

/**
 * Orders two version tags, with a release after every one of its pre-releases.
 *
 * @param first One tag.
 * @param second The other.
 * @return Below 0 when the first is older, above 0 when it is newer.
 */
export function compareTags(first: string, second: string): number {
  const left = parse(first);
  const right = parse(second);

  if (!left || !right) {
    return first.localeCompare(second);
  }

  for (let index = 0; index < 3; index++) {
    if (left.parts[index] !== right.parts[index]) {
      return left.parts[index] - right.parts[index];
    }
  }

  if (left.pre === right.pre) {
    return 0;
  }

  if (left.pre === null) {
    return 1;
  }

  if (right.pre === null) {
    return -1;
  }

  return comparePre(left.pre, right.pre);
}

/**
 * The newest version tag. Pre-releases only count when there is no release at all, so `latest` never
 * moves a unit onto a release candidate while a release exists.
 *
 * @param tags Every tag.
 * @return The newest, or null when none is a version.
 */
export function newestTag(tags: string[]): string | null {
  const versions = tags.filter(isVersionTag);
  const releases = versions.filter((tag) => !tag.includes('-'));
  const pool = releases.length ? releases : versions;

  return pool.sort(compareTags).at(-1) ?? null;
}
