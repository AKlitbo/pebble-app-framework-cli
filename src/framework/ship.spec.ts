/**
 * Specs for the git pathspecs that decide what a unit's paf/ gets from the framework.
 *
 * The pathspecs take the framework's src/ folder and leave out the specs, their fixtures, and each
 * plugin the unit does not list. A missing exclude ships a plugin, and the packages it installs, into
 * every unit, and one too many drops a plugin the unit asked for.
 */
import { describe, expect, test } from 'vitest';
import { shipPathspecs } from './ship.ts';

const OFFERED = ['dev', 'frame', 'icons', 'thumbnails'];

describe('shipPathspecs', () => {
  /** frame brings Playwright with it, so a unit that did not list it still installing it is the bug this guards. */
  test('leaves out exactly the plugins the unit does not list', () => {
    const result = shipPathspecs(['icons', 'thumbnails'], OFFERED, 'v4.0.0').filter((spec) => spec.includes('plugins'));

    expect(result).toEqual([':(exclude,glob)plugins/dev/**', ':(exclude,glob)plugins/frame/**']);
  });

  /** The specs and their fixtures never run in a unit, so shipping them only adds files a build has to skip. */
  test('takes everything in src/ but the specs and fixtures', () => {
    const result = shipPathspecs([], [], 'v4.0.0');

    expect(result).toEqual(['.', ':(exclude,glob)**/*.spec.ts', ':(exclude,glob)**/*.spec.c', ':(exclude,glob)**/fixtures/**']);
  });

  /**
   * git takes an exclude list without the plugin, so the unit would sync clean and then fail on its first
   * paf gen with nothing saying the plugin was never there.
   */
  test('refuses a plugin the framework does not offer, naming the ones it does', () => {
    const result = () => shipPathspecs(['frames'], OFFERED, 'v4.0.0');

    expect(result).toThrow('the unit lists the plugin frames, which v4.0.0 does not have. It has dev, frame, icons, and thumbnails');
  });
});
