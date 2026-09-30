/**
 * Putting names into a sentence for a message.
 */

/**
 * Names joined the way a sentence lists them: a, a and b, or a, b, and c.
 *
 * @param names The names, in the order to list them.
 * @return The joined names.
 */
export function inSentence(names: string[]): string {
  if (names.length < 3) {
    return names.join(' and ');
  }

  return `${names.slice(0, -1).join(', ')}, and ${names.at(-1)}`;
}
