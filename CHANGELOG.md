# Changelog

All notable changes to paf are recorded here, following [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Changed

- **Breaking:** A unit's file is `paf.config.json` rather than `paf.json`. It holds `framework` and `commit` as before, plus `plugins`, a map of the framework plugins the unit lists with each one's settings, and `gen`, a map of the unit's own generators. Rename the file by hand, and add `plugins` for each plugin the unit uses, such as `"plugins": { "icons": { "sources": "../../vendor" }, "thumbnails": {} }`. A repo with a `paf.json` left in any unit stops every command until it is moved.
- **Breaking:** `paf 2.0.0` reads only the framework 4 layout. `paf pin` refuses a framework 3 tag, and a tag from a later framework, which a later paf fills. `paf sync`, `paf build`, `paf gen`, `paf run`, `paf test`, `paf lint`, and `paf typecheck` stop on a unit still pinned to one, or to a tag that is not a framework version, unless it is on a local framework through `paf use <unit> local`. `paf use <unit> pinned` always stops on one. `paf status` shows such a unit as a problem. Move it with `paf pin <unit> <tag>` to a framework 4 tag. A unit staying on framework 3 keeps `paf 1.0.0`.
- **Breaking:** A unit's framework folder is `paf/` rather than `lib/`, and the swap folders are `paf.paf-new/` and `paf.paf-old/`. The stamp inside it is `.paf.json`. Change the `.gitignore` lines for `lib/` and `lib.paf-*/`, the `workspaces` entry, and every import and tsconfig path that names `lib/`. The framework's `[4.0.0]` entry lists the rest of that move.
- **Breaking:** `paf sync` copies the framework's `src/` folder from the tag, leaving out every `*.spec.ts`, `*.spec.c`, and `fixtures/` folder, and every plugin under `src/plugins/` the unit's `paf.config.json` does not list. A plugin the unit lists that the tag does not have stops the sync with the tag's plugins named. Changing the plugins a unit lists fills `paf/` again on the next sync, and the next build starts clean. `paf use <unit> local` copies the same set from the clone's working tree.
- **Breaking:** A unit lists both `paf` and `paf/plugins/*` in its `workspaces`, and `paf sync`, `paf pin`, `paf use`, and every command that readies a unit refuse one that lists only one. The install now runs again whenever `paf/package.json` or any listed plugin's `package.json` changes, so listing or dropping a plugin installs its dependencies or removes them.
- `paf pin <unit> latest` and the LATEST column of `paf status` only take a framework 4 tag. While framework 4 has no release, that is its newest candidate.
- `paf use <unit> local` checks the clone by its `src/package.json`, since the framework's root `package.json` is the repo it is developed in.
- `paf pin` reads the changelog from `src/CHANGELOG.md` at the tag, and `paf status` and `paf doctor` read the toolchain from `paf/toolchain.json`.

### Removed

- Removed reading the framework's `package.json` `files` list, which framework 4 does not have. What a unit gets is the framework's `src/` folder, as the Changed entry above says.

## [1.0.0] - 2026-09-27

- Initial release of the Pebble App Framework CLI.

[Unreleased]: https://github.com/AKlitbo/pebble-app-framework-cli/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/AKlitbo/pebble-app-framework-cli/commits/v1.0.0
