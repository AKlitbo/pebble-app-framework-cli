# Pebble App Framework CLI

The `paf` command gives each family or face in a repo its own [pebble-app-framework](https://github.com/AKlitbo/pebble-app-framework) version, and builds and checks it in place. Moving one family to a new framework never touches a finished face, which can stay on the tag it was finished on for good.

`paf` never wraps `pebble`. Installing, the emulator, logs, screenshots, and SDK installs stay `pebble` commands.

## Units

A unit is a folder with a `paf.json`:

* a family under `watchfaces/` or `watchapps/`, with its `core/` and one folder per face
* a face of its own under `watchfaces/` or `watchapps/`
* the repo root, for a repo that is one face or one family

Each unit works like a small repo of its own.

```
watchfaces/mosaic/
  paf.json            { "framework": "v3.0.0", "commit": "..." }
  package.json        the unit's scripts, with workspaces: ["lib"]
  package-lock.json
  tsconfig.json
  .gitignore          lib/, lib.paf-*/, node_modules/, targets/
  lib/                the framework, filled by paf sync
  node_modules/
  core/
  gridlock/
  sidereel/
```

`lib/` holds only the files the framework's `package.json` `files` list names at the pinned tag, with no git inside it. The editor sees the same `lib/` the build uses, so every face resolves against its own framework. `paf.json` records the commit the tag pointed at when it was pinned, and a tag that later moves stops `paf sync` until `paf pin` takes the move.

## Commands

| Command | What it does |
| :-- | :-- |
| `paf sync [unit] [--locked] [--force]` | Fills each unit's `lib/` from its tag and installs its `node_modules`. `--locked` is for CI and never writes. |
| `paf status` | Each unit's faces, tag, the newest tag, and whether it is ready. |
| `paf pin <unit> <tag\|latest>` | Moves a unit, showing the framework changelog between the tags with the breaking entries first. |
| `paf use <unit> local [path]`, `paf use <unit> pinned` | Points a unit's `lib/` at a local framework clone, builds included, and back. |
| `paf build <face\|all> [--clean]` | Builds a face in its unit, clean when its keys, dependencies, or framework changed. Linux, WSL, or macOS, not Windows itself. |
| `paf gen <face> <kind\|all>` | Runs a framework generator for a face, or every one it has inputs for. |
| `paf run <unit\|face> <script>` | Runs any npm script in a unit. |
| `paf test`, `lint`, `typecheck` `[unit]` | Runs the check in every unit, or one, against its own framework. |
| `paf doctor` | Checks git, Node, the pins, the SDK against each tag's `toolchain.json`, and the workflows. |

## The Framework's Side

`paf` reads what it needs from the framework at each unit's tag.

* `package.json` `files` is the ship list for `lib/`.
* `project/toolchain.json` records the SDK, the pebble-tool, and the Node major the tag was built with.

It carries a `format` number, and `paf` keeps reading every format a supported tag uses, since a unit can stay on an old tag for years.

## Install

The repo is private for now, so install from a local clone. In WSL:

```sh
npm ci
npm pack
npm i -g --prefix ~/.local ./pebble-app-framework-cli-0.3.0.tgz
```

`~/.local/bin` has to be on the `PATH`, which it already is where pebble-tool is installed with uv. The tool needs Node 22.18 or later with the npm it ships with, and `git`, and has no runtime dependencies. On Windows it runs npm through the `npm-cli.js` that every Windows install of Node puts beside `node`, and stops if it is not there.

The sync action in `.github/actions/sync` is for a face repo's CI. A workflow loads it from this repo, so it works once the repo is public, at 1.0.0 alongside the framework's 3.0.0.

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
