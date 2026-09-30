/**
 * Specs for what paf pin refuses before it moves a unit.
 *
 * A pin is what a finished face is held to, so the cases worth pinning are a ref that would never move
 * again, and a refusal that has to leave paf.config.json and paf/ agreeing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { COMMIT, currentUnit, fakeRunner, makeContext, makeTree } from '../testing/tree.ts';
import { pin } from './pin.ts';

const PIN = JSON.stringify({ framework: 'v4.1.0', commit: COMMIT });

/** A repo with one unit pinned to v4.1.0, and the files given on top. */
function repoWith(files: Record<string, string> = {}): string {
  return makeTree({
    'watchfaces/mosaic/paf.config.json': PIN,
    'watchfaces/mosaic/package.json': '{ "workspaces": ["paf", "paf/plugins/*"] }',
    'watchfaces/mosaic/gridlock/config/pebble.appinfo.json': '{ "name": "gridlock" }',
    ...files,
  });
}

/**
 * A runner whose sync after a pin completes: a tag offering the icons and thumbnails plugins, a fill that
 * writes nothing, and npm making node_modules.
 */
function syncingRun(root: string) {
  return fakeRunner((command, args) => {
    if (command === 'npm') {
      fs.mkdirSync(path.join(root, 'watchfaces', 'mosaic', 'node_modules'), { recursive: true });
    }

    if (args.includes('ls-tree')) {
      return { stdout: 'src/plugins/icons\0src/plugins/thumbnails\0' };
    }

    return args.includes('rev-parse') ? { stdout: `${COMMIT}\n` } : undefined;
  }).run;
}

/** A runner whose mirror has v4.2.0 at a commit, and a branch called main. */
const tagged = fakeRunner((command, args) => (args.includes('rev-parse') ? { stdout: `${COMMIT}\n` } : undefined));

describe('pin', () => {
  /** The mirror only fetches tags, so a unit pinned to a branch stayed on the day it was pinned with nothing saying so. */
  test('refuses a ref that is not a version tag', () => {
    const root = repoWith();
    const { ctx } = makeContext(root, tagged.run);

    const result = () => pin(ctx, 'mosaic', 'main');

    expect(result).toThrow(/cannot pin main, which is not a framework version tag/);
  });

  /** The pin was written before the other system's install stopped the sync, so paf.config.json named a framework paf/ did not hold. */
  test('leaves paf.config.json alone when the install came from the other system', () => {
    const root = repoWith({ 'watchfaces/mosaic/node_modules/.paf-install.json': JSON.stringify({ platform: 'win32', lock: 'x' }) });
    const { ctx } = makeContext(root, tagged.run);

    const result = () => pin(ctx, 'mosaic', 'v4.2.0');

    expect(result).toThrow(/installed from win32/);
    expect(fs.readFileSync(path.join(root, 'watchfaces', 'mosaic', 'paf.config.json'), 'utf8')).toBe(PIN);
  });

  /** A repo still on the submodule had its pin moved and then the sync refused to touch paf/, so the two disagreed. */
  test('leaves paf.config.json alone when paf/ is a framework paf did not fill', () => {
    const root = repoWith({ 'watchfaces/mosaic/paf/.git': 'gitdir: ../.git/modules/paf\n' });
    const { ctx } = makeContext(root, tagged.run);

    const result = () => pin(ctx, 'mosaic', 'v4.2.0');

    expect(result).toThrow(/paf did not put there/);
    expect(fs.readFileSync(path.join(root, 'watchfaces', 'mosaic', 'paf.config.json'), 'utf8')).toBe(PIN);
  });

  /**
   * pin refused a unit on a local framework and use pinned refused a moved tag, each pointing at the
   * other, so a local unit whose tag moved could not get back to any tag. A pin now moves it.
   */
  test('moves a unit on a local framework onto the tag', () => {
    const root = repoWith({ 'watchfaces/mosaic/paf/.paf.json': JSON.stringify({ commit: COMMIT, local: '/work/pebble-app-framework' }) });
    const { run } = fakeRunner((command, args) => {
      if (command === 'npm') {
        fs.mkdirSync(path.join(root, 'watchfaces', 'mosaic', 'node_modules'), { recursive: true });
      }

      return args.includes('rev-parse') ? { stdout: `${COMMIT}\n` } : undefined;
    });
    const { ctx, printed } = makeContext(root, run);

    pin(ctx, 'mosaic', 'v4.2.0');

    expect(printed).toContain('mosaic moved off the local framework at /work/pebble-app-framework onto v4.2.0');
    expect(JSON.parse(fs.readFileSync(path.join(root, 'watchfaces', 'mosaic', 'paf.config.json'), 'utf8')).framework).toBe('v4.2.0');
    expect(JSON.parse(fs.readFileSync(path.join(root, 'watchfaces', 'mosaic', 'paf', '.paf.json'), 'utf8'))).toEqual({ commit: COMMIT, tag: 'v4.2.0', plugins: [] });
  });

  /**
   * latest prefers a release, and a unit on a newer candidate was moved back to the older release, onto
   * a framework it had already moved past.
   */
  test('leaves a unit that is newer than the latest release where it is', () => {
    const candidate = JSON.stringify({ framework: 'v4.1.0-rc.27', commit: COMMIT });
    const root = repoWith(currentUnit('mosaic', 'v4.1.0-rc.27'));
    const { run } = fakeRunner((command, args) => {
      if (args.includes('tag')) {
        return { stdout: 'v4.0.0\nv4.1.0-rc.27\n' };
      }

      return args.includes('rev-parse') ? { stdout: `${COMMIT}\n` } : undefined;
    });
    const { ctx, printed } = makeContext(root, run);

    pin(ctx, 'mosaic', 'latest');

    expect(fs.readFileSync(path.join(root, 'watchfaces', 'mosaic', 'paf.config.json'), 'utf8')).toBe(candidate);
    expect(printed).toContain('mosaic is on v4.1.0-rc.27, which is newer than latest, v4.0.0, so it stays');
  });

  /** A unit that listed a plugin its newer tag lacks was told it stays, and then the sync failed on the plugin. */
  test('refuses to stay on a tag without a plugin the unit lists, before saying it stays', () => {
    const root = repoWith({
      ...currentUnit('mosaic', 'v4.1.0-rc.27'),
      'watchfaces/mosaic/paf.config.json': JSON.stringify({ framework: 'v4.1.0-rc.27', commit: COMMIT, plugins: { frame: {} } }),
    });
    const { run } = fakeRunner((command, args) => {
      if (args.includes('tag')) {
        return { stdout: 'v4.0.0\nv4.1.0-rc.27\n' };
      }

      if (args.includes('ls-tree')) {
        return { stdout: 'src/plugins/icons\0' };
      }

      return args.includes('rev-parse') ? { stdout: `${COMMIT}\n` } : undefined;
    });
    const { ctx, printed } = makeContext(root, run);

    const result = () => pin(ctx, 'mosaic', 'latest');

    expect(result).toThrow(/the unit lists the plugin frame, which v4\.1\.0-rc\.27 does not have/);
    expect(printed.filter((line) => line.includes('stays'))).toEqual([]);
  });

  /**
   * A unit on its clone was told it was on its pinned candidate, and paf pin latest left it on the clone
   * though every other pin moves a unit onto its tag.
   */
  test('moves a local unit newer than latest onto the tag it pins', () => {
    const root = repoWith({
      'watchfaces/mosaic/paf.config.json': JSON.stringify({ framework: 'v4.1.0-rc.27', commit: COMMIT }),
      'watchfaces/mosaic/paf/.paf.json': JSON.stringify({ commit: COMMIT, local: '/work/pebble-app-framework' }),
    });
    const { run } = fakeRunner((command, args) => {
      if (command === 'npm') {
        fs.mkdirSync(path.join(root, 'watchfaces', 'mosaic', 'node_modules'), { recursive: true });
      }

      if (args.includes('tag')) {
        return { stdout: 'v4.0.0\nv4.1.0-rc.27\n' };
      }

      return args.includes('rev-parse') ? { stdout: `${COMMIT}\n` } : undefined;
    });
    const { ctx, printed } = makeContext(root, run);

    pin(ctx, 'mosaic', 'latest');

    expect(printed).toContain('mosaic pins v4.1.0-rc.27, which is newer than latest, v4.0.0, so it stays on v4.1.0-rc.27');
    expect(printed).toContain('mosaic moved off the local framework at /work/pebble-app-framework onto v4.1.0-rc.27');
    expect(JSON.parse(fs.readFileSync(path.join(root, 'watchfaces', 'mosaic', 'paf', '.paf.json'), 'utf8')).tag).toBe('v4.1.0-rc.27');
  });

  /** A pin to the tag a local unit already names moved it off its clone, and the only line said it was already on the tag. */
  test('says a local unit pinned again to its own tag moves off the clone', () => {
    const root = repoWith({ 'watchfaces/mosaic/paf/.paf.json': JSON.stringify({ commit: COMMIT, local: '/work/pebble-app-framework' }) });
    const { ctx, printed } = makeContext(root, syncingRun(root));

    pin(ctx, 'mosaic', 'v4.1.0');

    expect(printed).toContain('mosaic is already pinned to v4.1.0');
    expect(printed).toContain('mosaic moved off the local framework at /work/pebble-app-framework onto v4.1.0');
  });

  /** paf.config.json made for a new unit names no framework yet, and the one command meant to choose it refused. */
  test('gives a unit its first pin', () => {
    const root = repoWith({ 'watchfaces/mosaic/paf.config.json': '{}' });
    const { ctx, printed } = makeContext(root, syncingRun(root));

    pin(ctx, 'mosaic', 'v4.2.0');

    expect(JSON.parse(fs.readFileSync(path.join(root, 'watchfaces', 'mosaic', 'paf.config.json'), 'utf8')).framework).toBe('v4.2.0');
    expect(printed).toContain('mosaic: first pin, v4.2.0');
  });

  /** A half-edited appinfo stopped the pin after its changelog had printed, though the face names are only for a hint. */
  test('moves the pin when a face in the unit cannot be read', () => {
    // a unit that is one face reads its appinfo for the name, where a family takes names from its folders
    const root = repoWith({ 'watchfaces/mosaic/config/pebble.appinfo.json': '{ half edited' });
    const { ctx } = makeContext(root, syncingRun(root));

    pin(ctx, 'mosaic', 'v4.2.0');

    expect(JSON.parse(fs.readFileSync(path.join(root, 'watchfaces', 'mosaic', 'paf.config.json'), 'utf8')).framework).toBe('v4.2.0');
  });

  /** Moving back pointed at paf/CHANGELOG.md for the entries being left, and after the move that file no longer has them. */
  test('says where the entries being left behind are when moving back', () => {
    const root = repoWith();
    const { ctx, printed } = makeContext(root, syncingRun(root));

    pin(ctx, 'mosaic', 'v4.0.0');

    expect(printed.find((line) => line.includes('changelog entries'))).toMatch(/being left behind\. The full list is in paf\/CHANGELOG\.md until the pin moves/);
  });

  /**
   * A pin written before the refusal would name a framework whose layout this paf cannot copy into the
   * unit, and a changelog printed first would read as though the move had gone ahead.
   */
  test('refuses a framework 3 tag before printing or writing anything', () => {
    const root = repoWith();
    const { ctx, printed } = makeContext(root, tagged.run);

    const result = () => pin(ctx, 'mosaic', 'v3.0.0');

    expect(result).toThrow(/^cannot pin v3\.0\.0, which is framework 3 and needs paf 1\.0\.0\. This paf pins framework 4 tags/);
    expect(printed).toEqual([]);
    expect(fs.readFileSync(path.join(root, 'watchfaces', 'mosaic', 'paf.config.json'), 'utf8')).toBe(PIN);
  });

  /**
   * Until framework 4 has a release, the newest release is a framework 3 one. latest read it as the
   * target, so a unit on a framework 4 candidate was refused rather than left where it was.
   */
  test('takes latest from framework 4 tags only', () => {
    const root = repoWith(currentUnit('mosaic', 'v4.1.0-rc.27'));
    const { run } = fakeRunner((command, args) => {
      if (args.includes('tag')) {
        return { stdout: 'v3.1.0\nv4.1.0-rc.27\n' };
      }

      return args.includes('rev-parse') ? { stdout: `${COMMIT}\n` } : undefined;
    });
    const { ctx, printed } = makeContext(root, run);

    pin(ctx, 'mosaic', 'latest');

    expect(printed).toContain('mosaic is already on v4.1.0-rc.27');
  });

  /**
   * paf pin is the one way a unit renamed from paf.json moves off framework 3. A pin that read the old
   * pin strictly would refuse it, and every unit would be stuck on the framework this paf refuses.
   */
  test('moves a unit off a framework 3 pin', () => {
    const root = repoWith({ 'watchfaces/mosaic/paf.config.json': JSON.stringify({ framework: 'v3.1.0', commit: COMMIT }) });
    const { ctx } = makeContext(root, syncingRun(root));

    pin(ctx, 'mosaic', 'v4.2.0');

    expect(JSON.parse(fs.readFileSync(path.join(root, 'watchfaces', 'mosaic', 'paf.config.json'), 'utf8')).framework).toBe('v4.2.0');
  });

  /** A framework 5 is laid out for a later paf, and pinning it here would fill the unit with files this paf cannot run. */
  test('refuses a tag from a later framework', () => {
    const root = repoWith();
    const { ctx } = makeContext(root, tagged.run);

    const result = () => pin(ctx, 'mosaic', 'v5.0.0');

    expect(result).toThrow(/^cannot pin v5\.0\.0, which is framework 5 and needs a newer paf/);
  });

  /** paf 1.0.0 fills framework 3 only, so telling someone on framework 2 to fetch it sent them to a paf that refuses them too. */
  test('names no paf for a framework older than 3', () => {
    const root = repoWith();
    const { ctx } = makeContext(root, tagged.run);

    const result = () => pin(ctx, 'mosaic', 'v2.2.0');

    expect(result).toThrow(/^cannot pin v2\.2\.0, which is framework 2 and older than any paf fills/);
  });

  /** A unit on framework 5 was told it stays on latest, then refused by the sync straight after, with no way off it through latest. */
  test('moves a unit on a later framework back to latest rather than keeping it', () => {
    const root = repoWith({ 'watchfaces/mosaic/paf.config.json': JSON.stringify({ framework: 'v5.0.0', commit: COMMIT }) });
    const run = fakeRunner((command, args) => {
      if (command === 'npm') {
        fs.mkdirSync(path.join(root, 'watchfaces', 'mosaic', 'node_modules'), { recursive: true });
      }

      if (args.includes('tag')) {
        return { stdout: 'v4.2.0\nv5.0.0\n' };
      }

      return args.includes('rev-parse') ? { stdout: `${COMMIT}\n` } : undefined;
    }).run;
    const { ctx } = makeContext(root, run);

    pin(ctx, 'mosaic', 'latest');

    expect(JSON.parse(fs.readFileSync(path.join(root, 'watchfaces', 'mosaic', 'paf.config.json'), 'utf8')).framework).toBe('v4.2.0');
  });

  /**
   * The sync after the pin refused the plugin with paf.config.json already naming the new tag, so the file
   * and paf/ disagreed and every sync failed until the file was put back by hand.
   */
  test('refuses a tag without a plugin the unit lists before writing the pin', () => {
    const root = repoWith({ 'watchfaces/mosaic/paf.config.json': JSON.stringify({ framework: 'v4.1.0', commit: COMMIT, plugins: { frame: {} } }) });
    const { ctx } = makeContext(root, syncingRun(root));

    const result = () => pin(ctx, 'mosaic', 'v4.2.0');

    expect(result).toThrow('the unit lists the plugin frame, which v4.2.0 does not have. It has icons and thumbnails');
    expect(JSON.parse(fs.readFileSync(path.join(root, 'watchfaces', 'mosaic', 'paf.config.json'), 'utf8')).framework).toBe('v4.1.0');
  });

  /** A pin that dropped them would lose a unit's plugins the next time it moved, first seen as a missing Playwright on a paf gen. */
  test('keeps the plugins and gen paf.config.json holds', () => {
    const plugins = { icons: { sources: '../../vendor' }, thumbnails: {} };
    const gen = { vibrant: { script: 'core/tools/vibrant/generate-vibrant.ts', after: 'clay' } };
    const root = repoWith({ 'watchfaces/mosaic/paf.config.json': JSON.stringify({ framework: 'v4.1.0', commit: COMMIT, plugins, gen }) });
    const { ctx } = makeContext(root, syncingRun(root));

    pin(ctx, 'mosaic', 'v4.2.0');

    expect(JSON.parse(fs.readFileSync(path.join(root, 'watchfaces', 'mosaic', 'paf.config.json'), 'utf8'))).toEqual({ framework: 'v4.2.0', commit: COMMIT, plugins, gen });
  });

  /** paf.config.json was rewritten with only framework and commit, so a $schema or a note in it was lost from a tracked file. */
  test('keeps the other keys paf.config.json holds', () => {
    const root = repoWith({ 'watchfaces/mosaic/paf.config.json': JSON.stringify({ $schema: 'paf.schema.json', framework: 'v4.1.0', commit: COMMIT, note: 'held for the rc' }) });
    const { ctx } = makeContext(root, syncingRun(root));

    pin(ctx, 'mosaic', 'v4.2.0');

    expect(JSON.parse(fs.readFileSync(path.join(root, 'watchfaces', 'mosaic', 'paf.config.json'), 'utf8'))).toEqual({ $schema: 'paf.schema.json', framework: 'v4.2.0', commit: COMMIT, note: 'held for the rc' });
  });
});
