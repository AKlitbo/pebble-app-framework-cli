/**
 * Specs for reading the Node the framework asks for.
 *
 * The framework asks for ^22.18.0 || >=24.2.0, which leaves out 23 and 24 before 24.2 though they sit
 * between the two floors. A range read wrong either turns away a Node the tools work on or lets through
 * one where they stop before they start, and a range read as nothing lets every script run.
 */
import { describe, expect, test } from 'vitest';
import { makeTree } from '../testing/tree.ts';
import { frameworkEngines, nodeSatisfies, wrongNode } from './engines.ts';

describe('nodeSatisfies', () => {
  /** The framework's own range, where the Nodes between its two floors are the ones easiest to get wrong. */
  test.each([
    ['22.17.0', false],
    ['22.18.0', true],
    ['22.22.2', true],
    ['23.11.0', false],
    ['24.1.0', false],
    ['24.2.0', true],
    ['25.0.0', true],
  ])('reads %s against ^22.18.0 || >=24.2.0 as %s', (version, expected) => {
    const result = nodeSatisfies('^22.18.0 || >=24.2.0', version);

    expect(result).toBe(expected);
  });

  /** npm keeps a prerelease out of a range, and a 24.2.0 candidate read as 24.2.0 ran scripts the range does not take. */
  test('reads a prerelease as just below its release', () => {
    const result = nodeSatisfies('^22.18.0 || >=24.2.0', '24.2.0-rc.1');

    expect(result).toBe(false);
  });

  /** A ~24 or * read as nothing would run the script anyway, under whatever Node paf is on. */
  test.each(['~24.2', '>24', '24.x', '*'])('refuses %s rather than reading it', (range) => {
    const result = () => nodeSatisfies(range, '22.19.0');

    expect(result).toThrow(/is not one paf reads/);
  });
});

describe('frameworkEngines', () => {
  /** A unit that was never synced has no paf/ yet, and doctor called every such unit a problem. */
  test('gives null when there is no paf/ yet', () => {
    const root = makeTree({ 'paf.config.json': '{}' });

    const result = frameworkEngines(root);

    expect(result).toBeNull();
  });

  /** An engines.node that is not text read as none would let every script run. */
  test('refuses an engines.node that is not text', () => {
    const root = makeTree({ 'paf/package.json': '{ "engines": { "node": 24 } }' });

    const result = () => frameworkEngines(root);

    expect(result).toThrow(/gives engines\.node as something other than text/);
  });
});

describe('wrongNode', () => {
  /** The message is all a person on the wrong Node sees, so it has to name the range and their Node. */
  test('names the range and the Node when the Node is outside it', () => {
    const result = wrongNode('^22.18.0 || >=24.2.0', '23.11.0', 'paf/package.json');

    expect(result).toMatch(/^paf\/package\.json asks for Node \^22\.18\.0 \|\| >=24\.2\.0, and this is 23\.11\.0\./);
  });
});
