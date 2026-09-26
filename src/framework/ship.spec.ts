/**
 * Specs for turning the framework's files list into git pathspecs.
 *
 * The list decides everything a unit's lib/ holds. A pathspec that matches nothing stops git restore
 * outright, and a leftover exclude ships the C host specs into every unit.
 */
import { describe, expect, test } from 'vitest';
import { shipPathspecs } from './ship.ts';

const PRESENT = ['package.json', 'build.sh', 'c/core/a.c', 'c/core/a.spec.c', 'ts/pkjs/app.ts'];

describe('shipPathspecs', () => {
  /** The unit installs the framework as a workspace from its package.json, so it ships whatever the list says. */
  test('always takes package.json', () => {
    const result = shipPathspecs(['build.sh'], PRESENT);

    expect(result).toContain('package.json');
  });

  /** A later framework can list a file an older tag never had, and git refuses a pathspec that matches nothing. */
  test('drops an entry the commit does not hold', () => {
    const result = shipPathspecs(['build.sh', 'features.json', 'c/core'], PRESENT);

    expect(result).toEqual(['package.json', 'build.sh', 'c/core']);
  });

  /** The C host specs never run in a face repo, so the list leaves them out with a negated glob. */
  test('turns a negated entry into an exclude', () => {
    const result = shipPathspecs(['c/core', '!**/*.spec.c'], PRESENT);

    expect(result).toContain(':(exclude,glob)**/*.spec.c');
  });

  /** npm reads a glob or a ./ path in the files list, and dropping either quietly left files out of lib/ with nothing saying why. */
  test('keeps a glob entry and a ./ path that match files', () => {
    const result = shipPathspecs(['c/**/*.h', './build.sh'], [...PRESENT, 'c/core/clock.h']);

    expect(result).toEqual(['package.json', ':(glob)c/**/*.h', 'build.sh']);
  });

  /** npm reads /build.sh from the package's own folder, and one written that way never matched a file and was dropped. */
  test('keeps an entry written from the root', () => {
    const result = shipPathspecs(['/build.sh'], PRESENT);

    expect(result).toEqual(['package.json', 'build.sh']);
  });

  /** git ls-files takes a pathspec that matches nothing, so a local clone keeps every entry rather than needing a listing to check first. */
  test('keeps every entry when there is no file list to check against', () => {
    const result = shipPathspecs(['build.sh', 'features.json', '!**/*.spec.c'], null);

    expect(result).toEqual(['package.json', 'build.sh', 'features.json', ':(exclude,glob)**/*.spec.c']);
  });
});
