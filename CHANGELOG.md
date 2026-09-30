# Changelog

All notable changes to paf are recorded here, following [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Added `paf check [unit]`, which runs every check the framework and the unit's listed plugins ship, in every unit or one, and fails at the end if any failed. Add it to a face repo's CI beside `paf test`, `paf lint`, and `paf typecheck`.
- Added `paf tool <face> <name> [args]`, which runs a tool a listed plugin names under `tools` in its `paf` key, such as the `dev` plugin's `clay-preview` and `tap-walk`. Every argument after the name reaches the tool as typed, `-h` and `--` included, and paf exits with the tool's own code. For a tool only an unlisted plugin offers, it names the plugin to list.
- Added the unit's own generators, under `gen` in `paf.config.json`: `"gen": { "vibrant": { "script": "core/tools/vibrant/generate-vibrant.ts", "after": "clay" } }`. `script` is a `.ts` file relative to the unit, since paf runs every script with node. `after` names the generator it runs after, and an optional `when` names a file or folder the face has to hold for `paf gen <face> all` to run it.

### Changed

- **Breaking:** A unit's file is `paf.config.json` rather than `paf.json`. It holds `framework` and `commit` as before, plus `plugins`, a map of the framework plugins the unit lists with each one's settings, and `gen`, a map of the unit's own generators. Rename the file by hand, and add `plugins` for each plugin the unit uses, such as `"plugins": { "icons": { "sources": "../../vendor" }, "thumbnails": {} }`. A repo with a `paf.json` left in any unit stops every command until it is moved.
- **Breaking:** `paf 2.0.0` reads only the framework 4 layout. `paf pin` refuses a framework 3 tag, and a tag from a later framework, which a later paf fills. `paf sync`, `paf build`, `paf gen`, `paf check`, `paf tool`, `paf run`, `paf test`, `paf lint`, and `paf typecheck` stop on a unit still pinned to one, or to a tag that is not a framework version, unless it is on a local framework through `paf use <unit> local`. `paf use <unit> pinned` always stops on one. `paf status` shows such a unit as a problem. Move it with `paf pin <unit> <tag>` to a framework 4 tag. A unit staying on framework 3 keeps `paf 1.0.0`.
- **Breaking:** A unit's framework folder is `paf/` rather than `lib/`, and the swap folders are `paf.paf-new/` and `paf.paf-old/`. The stamp inside it is `.paf.json`. Change the `.gitignore` lines for `lib/` and `lib.paf-*/`, the `workspaces` entry, and every import and tsconfig path that names `lib/`. The framework's `[4.0.0]` entry lists the rest of that move.
- **Breaking:** `paf sync` copies the framework's `src/` folder from the tag, leaving out every `*.spec.ts`, `*.spec.c`, and `fixtures/` folder, and every plugin under `src/plugins/` the unit's `paf.config.json` does not list. A plugin the unit lists that the tag does not have stops the sync with the tag's plugins named. Changing the plugins a unit lists fills `paf/` again on the next sync, and the next build starts clean. `paf use <unit> local` copies the same set from the clone's working tree.
- **Breaking:** A unit lists both `paf` and `paf/plugins/*` in its `workspaces`, and `paf sync`, `paf pin`, `paf use`, and every command that readies a unit refuse one that lists only one. The install now runs again whenever `paf/package.json` or any listed plugin's `package.json` changes, so listing or dropping a plugin installs its dependencies or removes them.
- **Breaking:** `paf gen <face> <kind>` and `paf gen <face> all` now find the generators through the `paf` key in `paf/package.json` and in each listed plugin's `package.json`, and run each as `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON <script> <face>` from the unit. `paf gen <face> all` runs the framework's generators, then each listed plugin's in the order listed. A unit generator from `gen` runs straight after the one its `after` names, and one without `after` runs at the end. Each runs only when the face holds what its `when` names. `all` takes no arguments after it, and a failing generator's exit code is passed on.
- **Breaking:** `paf build` now runs the framework's `tools/build.ts` under Node, found through the `build` entry in `paf/package.json`'s `paf` key, rather than `bash lib/build.sh`. A build is still WSL only, since `pebble` is. Under `paf use <unit> local`, an edit to the framework's `waf/` folder now starts the next build clean, and an edit to its `package.json` no longer does.
- `paf build`, `paf gen`, `paf check`, and `paf tool` now refuse to run under a Node outside the `engines` range in `paf/package.json`, naming the range and the Node. The range is read once the sync is done, from the framework the unit builds on. That covers the unit's own generators too. Outside that range a tool can stop partway, and on a Node with no `import.meta.main` it stops before it starts. `paf doctor` shows such a unit as a problem.
- `paf gen <face> <kind>` for a kind that only an unlisted plugin offers now names the plugin to list.
- `paf pin <unit> latest` and the LATEST column of `paf status` only take a framework 4 tag. While framework 4 has no release, that is its newest candidate.
- `paf use <unit> local` checks the clone by its `src/package.json`, since the framework's root `package.json` is the repo it is developed in.
- `paf pin` reads the changelog from `src/CHANGELOG.md` at the tag, and `paf status` and `paf doctor` read the toolchain from `paf/toolchain.json`.

### Removed

- **Breaking:** Removed reading the unit's `gen:*` npm scripts. `paf gen` no longer runs them, and a `gen:<face>` script no longer replaces the `paf gen <face> all` list. Drop them from the unit's `package.json`, and move a face's own steps, such as a colour table made from the Clay output, into `gen` in `paf.config.json`.
- Removed reading the framework's `package.json` `files` list, which framework 4 does not have. What a unit gets is the framework's `src/` folder, as the Changed entry above says.

## [1.0.0] - 2026-09-27

- Initial release of the Pebble App Framework CLI.

[Unreleased]: https://github.com/AKlitbo/pebble-app-framework-cli/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/AKlitbo/pebble-app-framework-cli/commits/v1.0.0
