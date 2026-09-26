/**
 * Specs for reading framework tags as versions.
 *
 * `paf pin <unit> latest` and the status table's LATEST column both pick the newest tag, and plain
 * string order puts v3.0.0-rc.9 after v3.0.0-rc.10 and a release candidate after its release.
 */
import { describe, expect, test } from 'vitest';
import { compareTags, newestTag, releaseOf } from './tags.ts';

describe('compareTags', () => {
  /** A release is newer than every candidate before it, or latest would move a unit back onto a candidate. */
  test('puts a release after its release candidates', () => {
    const result = compareTags('v3.0.0', 'v3.0.0-rc.27');

    expect(result).toBeGreaterThan(0);
  });

  /** Candidate numbers compare as numbers, so rc.10 comes after rc.9. */
  test('orders release candidates by number', () => {
    const result = compareTags('v3.0.0-rc.10', 'v3.0.0-rc.9');

    expect(result).toBeGreaterThan(0);
  });
});

describe('newestTag', () => {
  /** A newer candidate must not become latest while a release exists, since latest is what a face is told to move to. */
  test('skips candidates when there is a release', () => {
    const result = newestTag(['v3.0.0', 'v3.1.0-rc.1', 'v2.2.0', 'backup-tag']);

    expect(result).toBe('v3.0.0');
  });
});

describe('releaseOf', () => {
  /** A changelog heading carries no v, and a pin moving across it must still find its section. */
  test('reads a changelog heading and a candidate tag as their release', () => {
    const result = [releaseOf('3.0.0'), releaseOf('v3.0.0-rc.2'), releaseOf('Unreleased')];

    expect(result).toEqual(['v3.0.0', 'v3.0.0', null]);
  });
});
