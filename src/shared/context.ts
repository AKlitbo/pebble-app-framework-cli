/**
 * What every command is handed: the repo it works on, where the cache is, how to run programs, and
 * where to print.
 */
import type { Runner } from './runner.ts';

export type Context = {
  root: string;
  cache: string;
  repo: string;
  platform: NodeJS.Platform;
  run: Runner;
  print: (line: string) => void;
};
