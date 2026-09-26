/**
 * Reading the toolchain.json a framework tag records: the Pebble SDK, the pebble-tool, and the Node
 * major the framework was built and tested with.
 */

/** The toolchain formats this paf reads. A unit left on an old tag keeps its old format, so none is ever dropped. */
export const TOOLCHAIN_FORMATS = [1];

export type Toolchain = {
  sdk: string;
  pebbleTool: string;
  node: number;
};

/**
 * Parses a toolchain.json.
 *
 * @param text The file's contents.
 * @return The toolchain.
 */
export function parseToolchain(text: string): Toolchain {
  const data = JSON.parse(text);

  if (!TOOLCHAIN_FORMATS.includes(data.format)) {
    throw new Error(`toolchain.json is format ${data.format}, which this paf does not read. Update paf`);
  }

  return { sdk: String(data.sdk), pebbleTool: String(data.pebbleTool), node: Number(data.node) };
}

/**
 * Compares two dotted versions, such as 4.17 and 4.33.1, part by part as numbers.
 *
 * @param first One version.
 * @param second The other.
 * @return Below 0 when the first is older, 0 when they match, and above 0 when it is newer.
 */
export function compareVersions(first: string, second: string): number {
  const parse = (text: string) => text.replace(/^v/, '').split('.').map((part) => parseInt(part, 10) || 0);
  const left = parse(first);
  const right = parse(second);

  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);

    if (difference !== 0) {
      return difference;
    }
  }

  return 0;
}

/**
 * Reads the version pebble --version reports for the tool and the active SDK.
 *
 * @param text What `pebble --version` printed, such as "Pebble Tool v5.0.40 (active SDK: v4.33.1)".
 * @return The two versions, or null for either one the text does not carry.
 */
export function parsePebbleVersion(text: string): { tool: string | null; sdk: string | null } {
  const tool = /Pebble Tool v?(\d+(?:\.\d+)*)/i.exec(text);
  const sdk = /active SDK:\s*v?(\d+(?:\.\d+)*)/i.exec(text);

  return { tool: tool ? tool[1] : null, sdk: sdk ? sdk[1] : null };
}
