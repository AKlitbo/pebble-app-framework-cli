/**
 * Specs for reading a unit's paf.config.json.
 *
 * The file carries the unit's plugins and its own generators as well as its pin, and a shape paf cannot
 * use has to stop with the file named, rather than fail later inside a command that reads it.
 */
import { describe, expect, test } from 'vitest';
import { makeTree } from '../testing/tree.ts';
import { readConfig, readConfigIfSet } from './config.ts';

describe('readConfig', () => {
  /** A generator with nothing to run would only fail inside paf gen <face> all, as a run of node with no file. */
  test('refuses a gen entry with no script, naming the file', () => {
    const root = makeTree({ 'paf.config.json': JSON.stringify({ framework: 'v4.1.0', gen: { vibrant: { after: 'clay' } } }) });

    const result = () => readConfig(root);

    expect(result).toThrow(/paf\.config\.json gives the vibrant generator no script/);
  });

  /** Plugins listed as an array lose their settings and their order means nothing, so the file is refused rather than read. */
  test('refuses plugins that are not a map of names to settings', () => {
    const root = makeTree({ 'paf.config.json': JSON.stringify({ framework: 'v4.1.0', plugins: ['icons'] }) });

    const result = () => readConfig(root);

    expect(result).toThrow(/paf\.config\.json has a plugins that is not a map/);
  });

  /** A pin to a tag that is not a version would pass a check on the major alone and copy whatever that tag holds. */
  test('refuses a pin that is not a framework version tag', () => {
    const root = makeTree({ 'paf.config.json': JSON.stringify({ framework: 'framework-3-final' }) });

    const result = () => readConfig(root);

    expect(result).toThrow(/pins framework-3-final, which is not a framework version tag/);
  });

  /** JSON puts a key made only of digits first, so a plugin named 2 would run before the ones listed above it. */
  test('refuses a plugin name made only of digits', () => {
    const root = makeTree({ 'paf.config.json': JSON.stringify({ framework: 'v4.1.0', plugins: { icons: {}, 2: {} } }) });

    const result = () => readConfig(root);

    expect(result).toThrow(/names a plugin 2\. A name made only of digits loses its place in the order/);
  });

  /** A generator named __proto__ became the map's prototype, so it vanished from the list with no error. */
  test('refuses a generator named __proto__', () => {
    const root = makeTree({ 'paf.config.json': '{ "framework": "v4.1.0", "gen": { "__proto__": { "script": "core/x.ts" } } }' });

    const result = () => readConfig(root);

    expect(result).toThrow(/names a generator __proto__/);
  });

  /** The order the file lists plugins in is the order their generators run, so it has to survive the read. */
  test('keeps the plugins in the order the file lists them', () => {
    const root = makeTree({ 'paf.config.json': JSON.stringify({ framework: 'v4.1.0', plugins: { thumbnails: {}, icons: { sources: 'vendor' } } }) });

    const result = Object.keys(readConfig(root).plugins);

    expect(result).toEqual(['thumbnails', 'icons']);
  });
});

describe('readConfigIfSet', () => {
  /** paf pin is how a unit renamed from paf.json moves off framework 3, so reading its old pin for the move must not refuse it. */
  test('reads a framework 3 pin for a pin to move it', () => {
    const root = makeTree({ 'paf.config.json': JSON.stringify({ framework: 'v3.0.0' }) });

    const result = readConfigIfSet(root)?.framework;

    expect(result).toBe('v3.0.0');
  });
});
