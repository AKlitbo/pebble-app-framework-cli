/**
 * Specs for reading the toolchain a framework tag records and the one pebble reports.
 *
 * The SDK check compares the two, so a compare that reads 4.9 as newer than 4.17 tells someone on an
 * old SDK that all is well.
 */
import { describe, expect, test } from 'vitest';
import { compareVersions, parsePebbleVersion, parseToolchain } from './toolchain.ts';

describe('compareVersions', () => {
  /** Version parts compare as numbers, so 4.9 is older than 4.17. */
  test('compares each part as a number', () => {
    const result = compareVersions('4.9', '4.17');

    expect(result).toBeLessThan(0);
  });
});

describe('parsePebbleVersion', () => {
  /** This is the line pebble --version prints, and both versions come from it. */
  test('reads the tool and the active SDK', () => {
    const result = parsePebbleVersion('Pebble Tool v5.0.40 (active SDK: v4.33.1)');

    expect(result).toEqual({ tool: '5.0.40', sdk: '4.33.1' });
  });
});

describe('parseToolchain', () => {
  /** A unit can stay on an old tag for years, and an older paf guessing at a newer format would read it wrong. */
  test('refuses a format it does not know', () => {
    const result = () => parseToolchain('{ "format": 99, "sdk": "4.33.1", "pebbleTool": "5.0.40", "node": 24 }');

    expect(result).toThrow(/Update paf/);
  });
});
