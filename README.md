# Pebble App Framework CLI

The `paf` command pins each family or face in a repo to its own [pebble-app-framework](https://github.com/AKlitbo/pebble-app-framework) version, and builds and checks it against that version. Moving one family to a new framework leaves every other unit on the tag it already has.

`paf` never wraps `pebble`. Installing an app, the emulator, logs, screenshots, and SDK installs are all `pebble` commands.

## Install

Each release on GitHub carries the built package. Install it with npm, in WSL and on Windows alike:

```sh
npm i -g https://github.com/AKlitbo/pebble-app-framework-cli/releases/download/v2.0.0/pebble-app-framework-cli-2.0.0.tgz
```

`paf` needs Node 22.18 or later with the npm it ships with, and `git`. It has no runtime dependencies. The framework's tools need the Node range in its `engines.node`, which on framework 4 is 22.18 or later on Node 22, or 24.2 or later.

`paf 2.0.0` fills framework 4 tags only. A unit on framework 3 needs `paf 1.0.0`.

## Units

A unit is a folder with a `paf.config.json`:

* a family under `watchfaces/` or `watchapps/`, with its `core/` and one folder per face
* a face of its own under `watchfaces/` or `watchapps/`
* the repo root, for a repo that is one face or one family

Each unit works like a small repo of its own. A face is any folder holding a `pebble.appinfo.json`. In a face of its own that is the unit's folder. In a family it is each folder beside `core/`.

```
watchfaces/mosaic/
  paf.config.json     the framework tag, its plugins, and the unit's own generators
  package.json        the unit's scripts, with workspaces: ["paf", "paf/plugins/*"]
  package-lock.json
  config/             the unit's own tsconfigs and vitest.config.ts
  tsconfig.json       "files": [] and a reference to each tsconfig in config/, so an editor finds them
  .gitignore          paf/, paf.paf-*/, node_modules/, targets/
  paf/                the framework, filled by paf sync
  node_modules/
  core/               the code the family's faces share
  gridlock/           a face, with its pebble.appinfo.json, src/, and resources/
  sidereel/
```

`paf.config.json` names the tag, the commit it pointed at when it was pinned, the framework plugins the unit lists with each one's settings, and the unit's own generators:

```json
{
  "framework": "v4.0.0",
  "commit": "…",
  "plugins": { "icons": { "sources": "../../vendor" }, "thumbnails": {} },
  "gen": { "vibrant": { "script": "core/tools/vibrant/generate-vibrant.ts", "after": "clay" } }
}
```

`paf/` is a copy of the framework's `src/` folder at the pinned tag, without its specs, their fixtures, or the plugins the unit does not list. It has no `.git`. The editor and the build read the same `paf/`, so each unit checks and builds against its own framework.

If the tag later points at a different commit, `paf sync` stops. Run `paf pin <unit> <tag>` again to accept it.

## Commands

Wherever a command takes `[unit]`, a face name works too and picks the unit that holds it. Leaving it out runs every unit.

| Command | What it does |
| :-- | :-- |
| `paf sync [unit] [--locked] [--force]` | Fills each unit's `paf/` from its tag and installs its `node_modules`. `--locked` is for CI. It installs from the lock with `npm ci` and stops rather than write `paf.config.json` or the lock. `--force` reinstalls a `node_modules` made on the other system. |
| `paf status` | Shows each unit's faces, its tag, the newest framework 4 tag, and whether it is ready. |
| `paf pin <unit> <tag\|latest>` | Moves a unit to another tag and fills its `paf/`. It prints the breaking entries in the framework changelog between the two tags, and counts the rest. |
| `paf use <unit> local [path]`, `paf use <unit> pinned` | Fills a unit's `paf/` from a local framework clone, uncommitted edits included. `pinned` puts it back on its tag. |
| `paf build <face\|all> [--clean]` | Builds a face, or every face, through the framework's `tools/build.ts`. It builds clean when the face's keys, dependencies, or framework changed. It runs on Linux, WSL, or macOS, not on Windows itself. |
| `paf gen <face> <kind\|all> [args]` | Runs one generator for a face and passes it any arguments. `all` runs every generator the face has inputs for, in order, and takes no arguments. |
| `paf check [unit]` | Runs every check the framework and the unit's listed plugins ship. |
| `paf tool <face> <name> [args]` | Runs a tool a listed plugin offers, such as `clay-preview` or `tap-walk`. Every argument after the name reaches the tool as typed. |
| `paf run <unit\|face> <script> [args]` | Runs one of the unit's own npm scripts. |
| `paf test [unit]` | Runs the unit's own `test` script. |
| `paf typecheck [unit]` | Runs `tsc --noEmit` on each of the unit's own tsconfigs. It skips `paf/` and its swap folders, `targets/`, `node_modules/`, `vendor/`, `coverage/`, and dot folders other than `.github/`. |
| `paf lint [unit] [--fix]` | Lints a unit with the listed plugin that offers it, normally the framework's `code-style`. A unit listing none runs its own `lint` script, and one with neither fails. |
| `paf format [unit] [--check]` | Formats a unit the same way. `code-style` runs Prettier over its CSS, JSON, and YAML once the unit sets `"code-style": { "prettier": true }` under `plugins`. `--check` lists the files that would change and writes none. |
| `paf doctor` | Checks git, Node, the pins, the unit layout, the SDK against each tag's `toolchain.json`, and the workflows. |

## Generators

`paf gen <face> all` runs the framework's generators first, then each listed plugin's in the order `paf.config.json` lists them, then the unit's own. A unit generator with `after` runs straight after the generator it names. One without `after` runs last.

A generator only runs on a face that holds the file or folder its `when` names. A unit generator placed after `clay` still runs on a face with no Clay page, unless it has a `when` of its own. For a `when` under `src/pkjs/`, a face in a family also counts its core's matching folder under `core/pkjs/`. `paf gen <face> <kind>` runs that one generator whatever its `when` says.

A unit generator's `script` is a `.ts` file, with its path from the unit.

## CI

The sync action installs `paf 2.0.0` and runs `paf sync --locked` in a face repo's workflow. Load it at the release tag:

```yaml
- uses: AKlitbo/pebble-app-framework-cli/.github/actions/sync@v2.0.0
  with:
    face: gridlock
```

Its `face` input fills only the unit that face builds from, and leaving it empty fills every unit. `node-version` defaults to 24 and has to fall inside the framework's `engines.node`, read from `paf/package.json`.

## The Cache

The framework mirrors live in `~/.cache/paf/` on Linux, WSL, and macOS, or in `$XDG_CACHE_HOME/paf/` when that is set, and in `%LOCALAPPDATA%\paf\` on Windows. `PAF_HOME` moves them.

`PAF_REPO` fetches the framework from another URL or a local path. A relative path is read from the folder `paf` runs in. Each source keeps its own mirror.

## WSL and Windows

A unit's `node_modules` holds native binaries for one system. `paf sync` from Windows stops on a unit installed from WSL, and the other way round. `paf sync --force` reinstalls it for the system you are on, which breaks it for the other.

## What `paf` Reads from the Framework

`paf` reads what it needs from the framework at each unit's tag.

* `src/` is the folder copied into each unit's `paf/`.
* The `paf` key in `src/package.json` and in each plugin's `package.json` names the build script, the generators, the checks, the tools, and the lint and format scripts. `paf` runs whatever the keys name, so a new generator, check, or tool reaches a unit once the unit pins a tag that has it, and lists its plugin when a plugin offers it.
* `engines.node` in `src/package.json` is the Node range `paf build`, `gen`, `check`, `tool`, `lint`, and `format` refuse to run outside.
* `toolchain.json` at the top of `paf/` records the SDK, the pebble-tool, and the Node major the tag was built with, under a `format` number `paf` reads for every framework 4 tag.

## Development

```sh
npm ci
npm test
npm run lint
npm run typecheck
node <this repo>/src/cli.ts status   # run from source, from inside a face repo
```

## Licence

AGPL-3.0-or-later or PolyForm Noncommercial 1.0.0, whichever the licensee picks. See [LICENSE](LICENSE).
