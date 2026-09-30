/**
 * Reading the JSON files paf checks by hand: paf.config.json and the paf keys in the framework's
 * package.json files.
 */

/**
 * Whether a value is a plain JSON object rather than an array, null, or a single value.
 *
 * @param value The value.
 * @return Whether it is an object.
 */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether a script path is one paf runs. Every script goes to node, so a shell script would only fail
 * inside node with an error about its own syntax.
 *
 * @param script The script's path.
 * @return Whether it ends in .ts.
 */
export function isScript(script: unknown): script is string {
  return typeof script === 'string' && script.endsWith('.ts');
}
