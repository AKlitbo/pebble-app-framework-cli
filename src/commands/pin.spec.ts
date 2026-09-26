/**
 * Specs for what paf pin refuses before it moves a unit.
 *
 * A pin is what a finished face is held to, so the cases worth pinning are a ref that would never move
 * again, and a refusal that has to leave paf.json and lib/ agreeing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { fakeRunner, makeContext, makeTree } from '../testing/tree.ts';
import { pin } from './pin.ts';

const COMMIT = 'a'.repeat(40);
const PIN = JSON.stringify({ framework: 'v3.0.0', commit: COMMIT });

/** A repo with one unit pinned to v3.0.0, and the files given on top. */
function repoWith(files: Record<string, string> = {}): string {
  return makeTree({
    'watchfaces/mosaic/paf.json': PIN,
    'watchfaces/mosaic/package.json': '{ "workspaces": ["lib"] }',
    'watchfaces/mosaic/gridlock/config/pebble.appinfo.json': '{ "name": "gridlock" }',
    ...files,
  });
}

/** A runner whose sync after a pin completes: a fill that writes nothing, and npm making node_modules. */
function syncingRun(root: string) {
  return fakeRunner((command, args) => {
    if (command === 'npm') {
      fs.mkdirSync(path.join(root, 'watchfaces', 'mosaic', 'node_modules'), { recursive: true });
    }

    return args.includes('rev-parse') ? { stdout: `${COMMIT}\n` } : undefined;
  }).run;
}

/** A runner whose mirror has v3.1.0 at a commit, and a branch called main. */
const tagged = fakeRunner((command, args) => (args.includes('rev-parse') ? { stdout: `${COMMIT}\n` } : undefined));

describe('pin', () => {
  /** The mirror only fetches tags, so a unit pinned to a branch stayed on the day it was pinned with nothing saying so. */
  test('refuses a ref that is not a version tag', () => {
    const root = repoWith();
    const { ctx } = makeContext(root, tagged.run);

    const result = () => pin(ctx, 'mosaic', 'main');

    expect(result).toThrow(/no version tag main/);
  });

  /** The pin was written before the other system's install stopped the sync, so paf.json named a framework lib/ did not hold. */
  test('leaves paf.json alone when the install came from the other system', () => {
    const root = repoWith({ 'watchfaces/mosaic/node_modules/.paf-install.json': JSON.stringify({ platform: 'win32', lock: 'x' }) });
    const { ctx } = makeContext(root, tagged.run);

    const result = () => pin(ctx, 'mosaic', 'v3.1.0');

    expect(result).toThrow(/installed from win32/);
    expect(fs.readFileSync(path.join(root, 'watchfaces', 'mosaic', 'paf.json'), 'utf8')).toBe(PIN);
  });

  /** A repo still on the submodule had its pin moved and then the sync refused to touch lib/, so the two disagreed. */
  test('leaves paf.json alone when lib/ is a framework paf did not fill', () => {
    const root = repoWith({ 'watchfaces/mosaic/lib/.git': 'gitdir: ../.git/modules/lib\n' });
    const { ctx } = makeContext(root, tagged.run);

    const result = () => pin(ctx, 'mosaic', 'v3.1.0');

    expect(result).toThrow(/paf did not put there/);
    expect(fs.readFileSync(path.join(root, 'watchfaces', 'mosaic', 'paf.json'), 'utf8')).toBe(PIN);
  });

  /**
   * pin refused a unit on a local framework and use pinned refused a moved tag, each pointing at the
   * other, so a local unit whose tag moved could not get back to any tag. A pin now moves it.
   */
  test('moves a unit on a local framework onto the tag', () => {
    const root = repoWith({ 'watchfaces/mosaic/lib/.paf-lib.json': JSON.stringify({ commit: COMMIT, local: '/work/pebble-app-framework' }) });
    const { run } = fakeRunner((command, args) => {
      if (command === 'npm') {
        fs.mkdirSync(path.join(root, 'watchfaces', 'mosaic', 'node_modules'), { recursive: true });
      }

      return args.includes('rev-parse') ? { stdout: `${COMMIT}\n` } : undefined;
    });
    const { ctx } = makeContext(root, run);

    pin(ctx, 'mosaic', 'v3.1.0');

    expect(JSON.parse(fs.readFileSync(path.join(root, 'watchfaces', 'mosaic', 'paf.json'), 'utf8')).framework).toBe('v3.1.0');
    expect(JSON.parse(fs.readFileSync(path.join(root, 'watchfaces', 'mosaic', 'lib', '.paf-lib.json'), 'utf8'))).toEqual({ commit: COMMIT, tag: 'v3.1.0' });
  });

  /**
   * latest prefers a release, and a unit on a newer candidate was moved back to v2.2.0, which ships no files
   * list, so the whole framework repo landed in its lib/.
   */
  test('leaves a unit that is newer than the latest release where it is', () => {
    const candidate = JSON.stringify({ framework: 'v3.0.0-rc.27', commit: COMMIT });
    const root = repoWith({
      'watchfaces/mosaic/paf.json': candidate,
      'watchfaces/mosaic/lib/.paf-lib.json': JSON.stringify({ commit: COMMIT, tag: 'v3.0.0-rc.27' }),
      'watchfaces/mosaic/package-lock.json': '{}',
      'watchfaces/mosaic/node_modules/.paf-install.json': JSON.stringify({
        platform: 'linux',
        lock: '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
        framework: '',
      }),
    });
    const { run } = fakeRunner((command, args) => {
      if (args.includes('tag')) {
        return { stdout: 'v2.2.0\nv3.0.0-rc.27\n' };
      }

      return args.includes('rev-parse') ? { stdout: `${COMMIT}\n` } : undefined;
    });
    const { ctx, printed } = makeContext(root, run);

    pin(ctx, 'mosaic', 'latest');

    expect(fs.readFileSync(path.join(root, 'watchfaces', 'mosaic', 'paf.json'), 'utf8')).toBe(candidate);
    expect(printed).toContain('mosaic is on v3.0.0-rc.27, which is newer than the latest release v2.2.0, so it stays');
  });

  /** paf.json made for a new unit names no framework yet, and the one command meant to choose it refused. */
  test('gives a unit its first pin', () => {
    const root = repoWith({ 'watchfaces/mosaic/paf.json': '{}' });
    const { ctx, printed } = makeContext(root, syncingRun(root));

    pin(ctx, 'mosaic', 'v3.1.0');

    expect(JSON.parse(fs.readFileSync(path.join(root, 'watchfaces', 'mosaic', 'paf.json'), 'utf8')).framework).toBe('v3.1.0');
    expect(printed).toContain('mosaic: first pin, v3.1.0');
  });

  /** A half-edited appinfo stopped the pin after its changelog had printed, though the face names are only for a hint. */
  test('moves the pin when a face in the unit cannot be read', () => {
    // a unit that is one face reads its appinfo for the name, where a family takes names from its folders
    const root = repoWith({ 'watchfaces/mosaic/config/pebble.appinfo.json': '{ half edited' });
    const { ctx } = makeContext(root, syncingRun(root));

    pin(ctx, 'mosaic', 'v3.1.0');

    expect(JSON.parse(fs.readFileSync(path.join(root, 'watchfaces', 'mosaic', 'paf.json'), 'utf8')).framework).toBe('v3.1.0');
  });

  /** Moving back pointed at lib/CHANGELOG.md for the entries being left, and after the move that file no longer has them. */
  test('says where the entries being left behind are when moving back', () => {
    const root = repoWith();
    const { ctx, printed } = makeContext(root, syncingRun(root));

    pin(ctx, 'mosaic', 'v2.2.0');

    expect(printed.find((line) => line.includes('changelog entries'))).toMatch(/being left behind\. The full list is in lib\/CHANGELOG\.md until the pin moves/);
  });

  /** paf.json was rewritten with only framework and commit, so a $schema or a note in it was lost from a tracked file. */
  test('keeps the other keys paf.json holds', () => {
    const root = repoWith({ 'watchfaces/mosaic/paf.json': JSON.stringify({ $schema: 'paf.schema.json', framework: 'v3.0.0', commit: COMMIT, note: 'held for the rc' }) });
    const { ctx } = makeContext(root, syncingRun(root));

    pin(ctx, 'mosaic', 'v3.1.0');

    expect(JSON.parse(fs.readFileSync(path.join(root, 'watchfaces', 'mosaic', 'paf.json'), 'utf8'))).toEqual({ $schema: 'paf.schema.json', framework: 'v3.1.0', commit: COMMIT, note: 'held for the rc' });
  });
});
