# Changelog

## [0.13.0](https://github.com/casaper/hangar/compare/v0.12.0...v0.13.0) (2026-09-05)

### Bug Fixes

* **editor:** Let a hangar whose editor is not VS Code actually be one ([b287c81](https://github.com/casaper/hangar/commit/b287c816dda58958b501f183e5598805d30eb36e))
* **status:** Ask the config before blaming a branch for having no issue key ([e4632e1](https://github.com/casaper/hangar/commit/e4632e1dfe3c5e615fc9b5b99b8babd4e51d3bff))

## [0.12.0](https://github.com/casaper/hangar/compare/v0.11.0...v0.12.0) (2026-09-05)

### Bug Fixes

* **config:** Hold a clone's whole derived settings half, and read the tracker keys nothing read ([06fa595](https://github.com/casaper/hangar/commit/06fa59598660d12e58eb1dfedd608691901dcf3d))
* **config:** Make a copied config reach a working fleet, and let doctor say what is not ([63cadc6](https://github.com/casaper/hangar/commit/63cadc6d3fd937832bd8967a395037a2de3f5bd7))
* **doctor:** Wire the tracker hook only where a tracker is declared ([1516233](https://github.com/casaper/hangar/commit/151623310ad218c9a22fc0f81a07278e0e7af1da))
* **golden:** Make the gated baseline somebody else's too, and stop writing this repo into every hangar ([3b27ae9](https://github.com/casaper/hangar/commit/3b27ae96c91168271f43968959b3668a6afaf9d1))
* **setup:** Close the gaps a colleague's first day would find, and check two of them from now on ([b2dea40](https://github.com/casaper/hangar/commit/b2dea40df015ca09d563d04bbd367e4192ef96ba))

## [0.11.0](https://github.com/casaper/hangar/compare/v0.10.0...v0.11.0) (2026-09-05)

### Documentation

* **test:** Say the suite exists, and say exactly what it does not cover ([decb6f2](https://github.com/casaper/hangar/commit/decb6f2c5d614286d80af0eb175af445c3395e9f))

### Tests

* Put pnpm test in the developer-mode gate, and make two weak assertions real ([3a8fd59](https://github.com/casaper/hangar/commit/3a8fd595b94a07a5726a2127fdfd69ccc5a79d5c))
* Seed a node:test suite, and let it find one thing on the way in ([cdf5b63](https://github.com/casaper/hangar/commit/cdf5b637f832424a45fa16175ff262dd5b705709))

### Chores

* Keep an untracked plugin buffer out of prettier's way ([5a36444](https://github.com/casaper/hangar/commit/5a36444588f6ff084a6a86e195e0e90cf34fda94))

## [0.10.0](https://github.com/casaper/hangar/compare/v0.9.0...v0.10.0) (2026-09-05)

### Features

* **platform:** Add the platform seam, and stop assuming macOS in five places ([ad6983e](https://github.com/casaper/hangar/commit/ad6983eb1020dd66e7b423c090fbe1380c236ac4))
* **terminal:** Add the tmux terminal driver, verified against a live server ([0d60c80](https://github.com/casaper/hangar/commit/0d60c80f30c46a04d9a54cf66362961b73414e36))

### Bug Fixes

* **terminal:** Require an attached tmux client, not just a running server ([f9d4f96](https://github.com/casaper/hangar/commit/f9d4f96d1c18f2085778f8ad69d6e87be6f406e9))

### Documentation

* **platform:** Document the platform seam, the two detectors, and what stays unverified ([16f5638](https://github.com/casaper/hangar/commit/16f56388706188f23988f38bc121e510086fe44a))
* **terminal:** Document tmux, and shrink the README's Linux punch list to what is still open ([78f9dae](https://github.com/casaper/hangar/commit/78f9dae146087a4b90a2255bb3ee4edd9a6a5a44))

## [0.9.0](https://github.com/casaper/hangar/compare/v0.8.0...v0.9.0) (2026-09-04)

### Features

* **add-clone:** Let `add-clone` make the first clone, and delete the last four literals ([7c2357a](https://github.com/casaper/hangar/commit/7c2357a327d03388ff410a597dae24e50495ca07)), closes [#1](https://github.com/casaper/hangar/issues/1)
* **install:** Run the install steps the repo declares, not `npm ci` in `angular/` ([ffe520b](https://github.com/casaper/hangar/commit/ffe520bdd6f6818ea1a214f1709897d862b1dec8))
* **setup:** Generate the hangar's own Claude Code settings; report the modes', never fix ([4ae71ec](https://github.com/casaper/hangar/commit/4ae71ec71b5d5853bbc7ded914a1c554a1eef6c9))

### Bug Fixes

* **config:** Finish the genericisation the F10 grep found still open ([bab2464](https://github.com/casaper/hangar/commit/bab24647f94f1917c968b87661c174fec806838e))
* **ide:** Derive the two patterns `ide vscode sync` reads backwards ([7b16e61](https://github.com/casaper/hangar/commit/7b16e6174372a0a9d64eacf45e61e3360a26a210))
* **setup:** Make `setup` emit only what it observed, or admit it did not ([f63399c](https://github.com/casaper/hangar/commit/f63399c1efbd458b3ce22de1e5732e883f8469a8))

### Documentation

* Split the fleet map into how a hangar works and which hangar this is ([d4a44cf](https://github.com/casaper/hangar/commit/d4a44cf578f1c183a79825bca969cee39ec40fd0))

### Chores

* Untrack what a `hangar` command rewrites, and move the one file it does not ([1027ae9](https://github.com/casaper/hangar/commit/1027ae9476e957af512add2b71a35392ca0eb26a))

## [0.8.0](https://github.com/casaper/hangar/compare/v0.7.0...v0.8.0) (2026-09-04)

### Features

* **config:** Open the port-role table so a hangar can serve something else ([5317ed1](https://github.com/casaper/hangar/commit/5317ed1a701e40edf226ec36e13b9fdf30ad8de9))
* **config:** Render the config's templates, and read the keys nothing was reading ([51e7744](https://github.com/casaper/hangar/commit/51e77449f9c686be996b1f5630207411070138a0)), closes [#1](https://github.com/casaper/hangar/issues/1)
* **golden:** Give a fresh clone a way in, and a regression net to refactor behind ([83ff07f](https://github.com/casaper/hangar/commit/83ff07fa67c10630baadb397a368875d3c40aff8))

### Bug Fixes

* **colours:** Name everything a hangar writes outside its own root after the hangar ([ce11488](https://github.com/casaper/hangar/commit/ce11488ab3dca5c3b20e87a280be2387a098477f))

### Refactoring

* **cli:** Split the user's paths out of the hangar's ([f056a66](https://github.com/casaper/hangar/commit/f056a66bf904987442ed994978eb81a15739cd70))
* **cli:** Thread the hangar instead of guessing it from the CLI's own location ([9c1d140](https://github.com/casaper/hangar/commit/9c1d1405d2a75cbc9d446af62bb675ee92ac8a20))
* **config:** Report the discovery source from the threaded hangar, not a second lookup ([bb3a10c](https://github.com/casaper/hangar/commit/bb3a10c7bb04024e5fa73ac57eff545f9311896a))

## [0.7.0](https://github.com/casaper/hangar/compare/v0.6.0...v0.7.0) (2026-09-04)

### Features

* **modes:** Give the hangar root two launch modes, and a badge that says which ([ff8ea02](https://github.com/casaper/hangar/commit/ff8ea0234a0e1a986552c2d9f5a2f2a14574b08d))

### Documentation

* Add a skill for driving the fleet rather than building it ([99a0531](https://github.com/casaper/hangar/commit/99a0531d88b087c84a4a06cfec9b3d77697f2425))
* Cut the fleet map back to what a clone session can act on ([36ef3f2](https://github.com/casaper/hangar/commit/36ef3f261038c6392ff31a15aba44519aa87c984))
* Fix the eleven defects the doc restructuring left behind ([bea8f31](https://github.com/casaper/hangar/commit/bea8f31bc452690545668ee6ffd7b6bfc675d17e))
* Give the CLI its own `CLAUDE.md`, one directory down ([655db1f](https://github.com/casaper/hangar/commit/655db1f7703d1eff1c319dce735a6ad3bbd74986))
* Make `app/CLAUDE.md` own the hangar root files this package generates ([137041a](https://github.com/casaper/hangar/commit/137041ab79a0239b2bc4d9c535bda5036f519105))
* Split the internals skill into an index and six references ([d5036eb](https://github.com/casaper/hangar/commit/d5036eb5ada45d5f212a272ba52e4ffb6a0d74fe))

## [0.6.0](https://github.com/casaper/hangar/compare/v0.5.0...v0.6.0) (2026-09-04)

### Features

* **config:** Ask git which branch is the default once, then remember it ([6b6288b](https://github.com/casaper/hangar/commit/6b6288bfa9370610fdd23ba2034e3d5d5d3d632c))
* **config:** Split the config in two, and refuse to run without the live half ([8b946f9](https://github.com/casaper/hangar/commit/8b946f92cc26834ec4fc2f56f7949e91a68b3829))
* **open:** Add `checkout-default`, and make `open` land each clone on it ([7ebe45c](https://github.com/casaper/hangar/commit/7ebe45cc38d6fe2b315786b5f60598ba378e5f93))
* **sync:** Give `sync` two more names, and let the name pick the strategy ([f36836a](https://github.com/casaper/hangar/commit/f36836aaff3d064c531efdcd20b489f0a0331427))

### Bug Fixes

* **cli:** Delete the shim that forwards to a command nobody registers ([bbc6c5b](https://github.com/casaper/hangar/commit/bbc6c5b064205f06138b6651287549ba027af447))

## [0.5.0](https://github.com/casaper/hangar/compare/v0.4.0...v0.5.0) (2026-09-03)

### Features

* **editor:** Make the editor a seam too, and fill it ([cedb5ff](https://github.com/casaper/hangar/commit/cedb5ff5f7ef20b9c94f5ba32c3a9d3f55205828))
* **editor:** Say so when the editors came from a default nobody wrote ([c993072](https://github.com/casaper/hangar/commit/c99307267578705644eb40071f22e9a30de729fb))
* **terminal:** Become Hangar, and drive terminals other than iTerm2 ([dcd7be6](https://github.com/casaper/hangar/commit/dcd7be6e13afe3723432b05e9bfcf031c8d36701))

### Bug Fixes

* **colours:** Stop the rename leaving a dead hook, and a hue behind the text ([a5a731a](https://github.com/casaper/hangar/commit/a5a731abed509a1e611753169bd0fc386d503cdb))
* **editor:** Rank VS Code above the editors it stands beside ([341b3e8](https://github.com/casaper/hangar/commit/341b3e89b41469a9e6acefc198466fad24376fbd))
* **ide:** Stop `<kind> sync` blaming the developer for a file it could not read ([6fd78d7](https://github.com/casaper/hangar/commit/6fd78d77686c83bb36ea5785be02c3a13a074b46))

### Documentation

* Move the CLI's rationale out of the ancestor walk ([8f59e6e](https://github.com/casaper/hangar/commit/8f59e6e9032324e6face6dfaad0dd70f95b3197f))

## [0.4.0](https://github.com/casaper/hangar/compare/v0.3.0...v0.4.0) (2026-09-03)

### Features

* **doctor:** Tell each clone what is true of ITS session, and check that it still says it ([b005991](https://github.com/casaper/hangar/commit/b00599138ac7b48baf6b142e8844f766aebfe258))

### Bug Fixes

* **fleet:** Render every clone's identity file from the clone alone ([e2549c1](https://github.com/casaper/hangar/commit/e2549c167761fa6d8fa0bbd4a492ef141d3011b8))
* **sync:** Always tell a paused session how the sync ended ([23a3c4b](https://github.com/casaper/hangar/commit/23a3c4bc55759b133d6d485ea2c9fad8f2af7cab))
* **sync:** Do not tell an up-to-date clone its branch moved ([8f31408](https://github.com/casaper/hangar/commit/8f3140895599eee2650d109dc31a7761c1e334a4))

### Documentation

* Generalise the two rules the identity file taught ([aef5d64](https://github.com/casaper/hangar/commit/aef5d648fc7235fe4b2b4cd05db6209e45d8b95f))
* Say "every clone" where the fleet map still said three ([6792d9b](https://github.com/casaper/hangar/commit/6792d9bff377dcfa1e60ec87c1e0b72b1ae4f75d))
* Stop the fleet map from carrying a clone count ([266ec2c](https://github.com/casaper/hangar/commit/266ec2ca77cd05c845489feff312748db0652c5c))
* Write down the two CLI conventions this session leaned on ([e3270cd](https://github.com/casaper/hangar/commit/e3270cdb22b928642d18eb6e18930238fee107bb))

### Chores

* **colours:** clone_04 is red, and the assignment file it needs now exists ([1049882](https://github.com/casaper/hangar/commit/1049882a2eaa4c07c617e975eca62677133968bb))

## [0.3.0](https://github.com/casaper/hangar/compare/v0.2.0...v0.3.0) (2026-09-02)

### Features

* **colours:** Let a clone be re-coloured, and give the palette four more hues ([6768dc3](https://github.com/casaper/hangar/commit/6768dc3400142581cf5bedbe9a62f81b90493e6f))
* **jira:** Give every Jira ticket one record, and stop re-fetching a fresh one ([e8d3858](https://github.com/casaper/hangar/commit/e8d3858f09320615f4306be7371ccaccc7933adc))
* **sync:** Sync onto the branch the pull request targets, not onto master ([e374c7d](https://github.com/casaper/hangar/commit/e374c7db696ae4298f5800d80856412a72bdc990)), closes [#838](https://github.com/casaper/hangar/issues/838)
* **tmp:** Merge each clone's new cache entries when its session ends ([396d738](https://github.com/casaper/hangar/commit/396d73845f48013fe9c88891b91bd8a46ee3f79e))

### Bug Fixes

* **doctor:** Allow every .envrc, and set checkout.defaultRemote in every clone ([6fa4aa0](https://github.com/casaper/hangar/commit/6fa4aa0c32f7da17a71061ea6fa7f5a9fcbfc7b8))
* **jira:** Never let the ticket hook hand back a copy older than the clone's own ([fd0115f](https://github.com/casaper/hangar/commit/fd0115f7cf7db3fd8e757f308b7bb717b9c223b7))
* **sync:** Fix two ways a target could be wrong without saying so ([504433a](https://github.com/casaper/hangar/commit/504433a98fe22debfa7c54f0e69d437d6677dcfd))

### Chores

* **fleet:** add clone 4 ([115be5e](https://github.com/casaper/hangar/commit/115be5e730a83ae1c21e5e3a28ad488c3c9e4498))

## [0.2.0](https://github.com/casaper/hangar/compare/v0.1.0...v0.2.0) (2026-09-02)

### Features

* **ide:** Add `orch-util vscode sync`, and repair the stale tool paths it found ([e34eb41](https://github.com/casaper/hangar/commit/e34eb41c6651b0356d0ccc97276a4792574d81da))
* **open:** Open every clone into one iTerm2 window, and stop duplicating its VS Code window ([4b0c3a5](https://github.com/casaper/hangar/commit/4b0c3a5f58296c7c2f2a5e2d1cf6e2a63f3cd6cf))
* **resume:** Add `orch-util resume`, a picker for a clone's past Claude Code sessions ([ced4b32](https://github.com/casaper/hangar/commit/ced4b329b2ee0a5b64098e8f8afdca4e7716fd97))
* **sync:** Stream the headless conflict resolver, and refuse to sync onto a half-applied rebase ([86c24e1](https://github.com/casaper/hangar/commit/86c24e1bb772f8768a7269452763280d3f50fbc4))
* **tmp:** Share the tmp/ cache per entry, and let every clone keep its own tmp/ ([9d11047](https://github.com/casaper/hangar/commit/9d11047660d3302f5cc09588e12122c17c6996fc))

### Bug Fixes

* **jira:** Collapse a ticket's duplicate cache files, and fix the key regex that hid them ([5a86d15](https://github.com/casaper/hangar/commit/5a86d15c547a90f1a5bf1bb5f76fbfb3afe39bc2))
* **tmp:** Skip a busy clone in `tmp merge` instead of refusing the fleet ([f04f832](https://github.com/casaper/hangar/commit/f04f83212755976647733ad4b52096bc4ec4be33))
* **tmp:** Stop `tmp merge` carrying PID files into the shared tmp/ ([c3ba350](https://github.com/casaper/hangar/commit/c3ba3503a76be9f0ad9b77e75a11e6ce88960500))

## [0.1.0](https://github.com/casaper/hangar/compare/v0.0.1...v0.1.0) (2026-09-01)

### Features

* **cli:** Make the clone fleet dynamic and orchestrate it from orch-util ([2e19bdf](https://github.com/casaper/hangar/commit/2e19bdf9049704721c205c874a3924b1b7869200))
* **plans:** Collect plans on SessionEnd, and stop copying plansDirectory per clone ([23707c5](https://github.com/casaper/hangar/commit/23707c5d983b3d2f41ebc5eebf90af16a5517cb9))
* **plans:** Share plans and tmp across the fleet, and print clones by index ([087d1d2](https://github.com/casaper/hangar/commit/087d1d20f408397ccf04f15fc91b3853d1af9511))
* **tmp:** Share the per-ticket Jira cache across the three clones ([7e5275f](https://github.com/casaper/hangar/commit/7e5275fd0cef98d901fec366b381f1409d907190))

### Bug Fixes

* **cli:** Move the CLI package into orch/, out of every clone's ancestor path ([0285bc8](https://github.com/casaper/hangar/commit/0285bc805800310f20df99aff200868da97a8695))
* **plans:** ensure plans and temp dir exist ([9e3b161](https://github.com/casaper/hangar/commit/9e3b161b6a1c7ecb4ea5d735e2a39a6a227ec81d))

### Documentation

* Correct the fleet map: the parent root is itself a git repo ([97fb561](https://github.com/casaper/hangar/commit/97fb5613436a5dea96821930b0589368f80b9c24))
* **plans:** Record that plansDirectory takes an absolute path despite the stale schema ([27f7412](https://github.com/casaper/hangar/commit/27f741294c290b90b78786b92d95607d88bae979))

## [0.0.1](https://github.com/casaper/hangar/compare/f590189910aa103c6f533a654f7b9031f8039bbc...v0.0.1) (2026-08-31)

### Features

* Set up the dvb_gn clone fleet: shared map, colour identity, shared secrets ([f590189](https://github.com/casaper/hangar/commit/f590189910aa103c6f533a654f7b9031f8039bbc))
