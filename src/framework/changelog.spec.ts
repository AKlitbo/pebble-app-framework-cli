/**
 * Specs for slicing the framework changelog between two tags.
 *
 * `paf pin` shows this before a unit moves, so a slice that misses a version hides the breaking change
 * that needed an edit, and one that takes too much buries it.
 */
import { describe, expect, test } from 'vitest';
import { breakingEntries, sectionsBetween } from './changelog.ts';

const CHANGELOG = [
  '# Changelog',
  '',
  '## [3.2.0] - 2026-11-01',
  '',
  '- **Breaking:** Renamed `health_store_steps`.',
  '- Added a thing.',
  '',
  '## [3.1.0] - 2026-10-01',
  '',
  '- Fixed a thing.',
  '',
  '## [3.0.0] - 2026-09-30',
  '',
  '- The start.',
  '',
  '[3.2.0]: https://example.com',
].join('\n');

describe('sectionsBetween', () => {
  /** Every version after the old tag up to the new one is what the move brings, and the old tag's own section is not. */
  test('takes the versions after the old tag up to the new one', () => {
    const result = sectionsBetween(CHANGELOG, 'v3.0.0', 'v3.2.0');

    expect(result).toContain('## [3.2.0]');
    expect(result).toContain('## [3.1.0]');
    expect(result).not.toContain('## [3.0.0]');
  });
});

describe('breakingEntries', () => {
  /** A breaking entry is the one that needs an edit in the face, so it is printed before the rest. */
  test('picks out the breaking lines', () => {
    const result = breakingEntries(sectionsBetween(CHANGELOG, 'v3.0.0', 'v3.2.0'));

    expect(result).toEqual(['- **Breaking:** Renamed `health_store_steps`.']);
  });
});
