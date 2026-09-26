/**
 * Turning whatever was thrown into a line to print.
 */

/**
 * The message of whatever was thrown, so a command can print it after a unit's name.
 *
 * @param error What was thrown.
 * @return Its message, or the value as text when it is not an Error.
 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
