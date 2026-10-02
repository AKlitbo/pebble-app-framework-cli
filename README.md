# Pebble App Framework CLI

The `paf` command gives each family or face in a repo its own [pebble-app-framework](https://github.com/AKlitbo/pebble-app-framework) version, and builds and checks it in place. Moving one family to a new framework never touches a finished face, which can stay on the tag it was finished on for good.

`paf` never wraps `pebble`. Installing, the emulator, logs, screenshots, and SDK installs stay `pebble` commands.

## Units

A unit is a folder with a `paf.config.json`:

* a family under `watchfaces/` or `watchapps/`, with its `core/` and one folder per face
* a face of its own under `watchfaces/` or `watchapps/`
* the repo root, for a repo that is one face or one family

Each unit works like a small repo of its own. A face is a folder holding a `pebble.appinfo.json`, which is the unit itself for a face of its own, or a folder beside `core/` in a family.

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

`paf/` holds what is inside the framework's `src/` folder at the pinned tag, with the specs, their fixtures, and every plugin the unit does not list left out, and no git inside it. The editor sees the same `paf/` the build uses, so every face resolves against its own framework. A tag that later moves from the recorded commit stops `paf sync` until `paf pin` takes the move.

`paf gen <face> all` runs the framework's generators first, then each listed plugin's in the order `paf.config.json` lists them, then the unit's own. A unit generator with an `after` runs right after the generator it names, wherever that one sits, and one without runs last. `when` filters per face once the order is fixed, so a unit generator placed after `clay` still runs on a face `clay` skips, unless it has a `when` of its own. A single kind, as in `paf gen <face> vibrant`, runs whatever `when` says. A unit generator's `script` is a `.ts` file relative to the unit.

## Commands

| Command | What it does |
| :-- | :-- |
| `paf sync [unit] [--locked] [--force]` | Fills each unit's `paf/` from its tag and installs its `node_modules`. `--locked` is for CI and never writes. |
| `paf status` | Each unit's faces, tag, the newest framework 4 tag, and whether it is ready. |
| `paf pin <unit> <tag\|latest>` | Moves a unit, showing the framework changelog between the tags with the breaking entries first. |
| `paf use <unit> local [path]`, `paf use <unit> pinned` | Points a unit's `paf/` at a local framework clone, builds included, and back. |
| `paf build <face\|all> [--clean]` | Builds a face in its unit through the framework's `tools/build.ts`, clean when its keys, dependencies, or framework changed. Linux, WSL, or macOS, not Windows itself. |
| `paf gen <face> <kind\|all> [args]` | Runs one generator the framework, a listed plugin, or the unit offers for a face, or every one the face has inputs for, in order. |
| `paf check [unit]` | Runs every check the framework and the listed plugins ship, in every unit or one. |
| `paf tool <face> <name> [args]` | Runs a tool a listed plugin offers, such as `clay-preview` or `tap-walk`, with every argument after the name as typed. |
| `paf run <unit\|face> <script> [args]` | Runs any npm script in a unit. It is for the unit's own scripts, since the framework's tools run through `paf build`, `gen`, `check`, `tool`, `lint`, and `format`. |
| `paf test`, `typecheck` `[unit]` | Runs the unit's own `test` script, or `tsc` on every tsconfig in the unit outside `paf/` and its swap folders, `targets/`, `node_modules/`, `vendor/`, `coverage/`, and dot folders other than `.github/`, in every unit or one. |
| `paf lint [unit] [--fix]` | Lints a unit with what a listed plugin offers, which is the framework's `code-style` plugin, or with the unit's own `lint` script when no listed plugin does. A unit with neither fails. |
| `paf format [unit] [--check]` | Formats a unit's files the same way. With the `code-style` plugin that is Prettier over its CSS, JSON, and YAML, once the unit turns it on. `--check` says which files would change and writes none. |
| `paf doctor` | Checks git, Node, the pins, the unit layout, the SDK against each tag's `toolchain.json`, and the workflows. |

## The Framework's Side

`paf` reads what it needs from the framework at each unit's tag.

* `src/` is what a unit gets in `paf/`, leaving out every `*.spec.ts`, `*.spec.c`, and `fixtures/` folder, and every plugin under `src/plugins/` the unit does not list.
* The `paf` key in `src/package.json` and in each plugin's `package.json` names the build script, the generators, the checks, the tools, and the lint and format scripts. `paf` runs the scripts the keys name and never learns what any of them does, so a generator, a check, or a tool the framework adds reaches a unit through its key, once the unit is on a tag that has it and lists its plugin.
* `engines.node` in `src/package.json` is the Node range `paf build`, `gen`, `check`, `tool`, `lint`, and `format` refuse to run outside.
* `toolchain.json` at the top of `paf/` records the SDK, the pebble-tool, and the Node major the tag was built with.

The toolchain carries a `format` number, and `paf` keeps reading every format a supported tag uses, since a unit can stay on an old tag for years.

## Install

Each release on GitHub carries the built package. Install it with npm, in WSL and on Windows alike:

```sh
npm i -g https://github.com/AKlitbo/pebble-app-framework-cli/releases/download/v2.0.0/pebble-app-framework-cli-2.0.0.tgz
```

`paf 2.0.0` fills framework 4 only, and stops in a repo where any unit still has a `paf.json`. A repo with a unit staying on framework 3 keeps `paf 1.0.0` until every unit moves.

The tool needs Node 22.18 or later with the npm it ships with, and `git`, and has no runtime dependencies. The framework's own tools take the range its `engines.node` names, which on framework 4 is 22.18 or later on Node 22, or 24.2 or later. On Windows `paf` runs npm through the `npm-cli.js` that every Windows install of Node puts beside `node`, and stops if it is not there.

The sync action in `.github/actions/sync` is for a face repo's CI. A workflow loads it from this repo at a tag, such as `AKlitbo/pebble-app-framework-cli/.github/actions/sync@v2.0.0`.

## The Cache

The framework mirrors live in `~/.cache/paf/` on Linux and WSL, and `%LOCALAPPDATA%\paf\` on Windows. `PAF_HOME` moves them. `PAF_REPO` fetches the framework from another URL or a local path, and a relative path is read from where paf runs. Each source gets its own mirror, so tags that only a local clone has stay put when another shell fetches from GitHub.

A unit's `node_modules` holds native binaries for one system, so `paf sync` from Windows stops on a unit installed from WSL, and the other way round, unless run with `--force`.

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
