# Changelog

## [0.23.0](https://github.com/casaper/hangar/compare/v0.22.0...v0.23.0) (2026-09-10)

### Features

* **pr:** Open and rewrite a Bitbucket pull request from a clone's branch ([6833bd0](https://github.com/casaper/hangar/commit/6833bd03be4aa12446e2eaab3adb8808653aad2b))

### Bug Fixes

* **modes:** Keep developer mode's plans in the hangar instead of ~/.claude/plans ([e946ed5](https://github.com/casaper/hangar/commit/e946ed5450accee74039c713e577a98c69b667ff))

### Refactoring

* **sync:** Lift the headless Claude Code runner out of the conflict resolver ([7bb3571](https://github.com/casaper/hangar/commit/7bb3571261d66ccc7906f86710e73a75ba4a81af))

### Documentation

* **pr:** Say what the two forge writes refuse, and where the API spec is not the authority ([3d4ed82](https://github.com/casaper/hangar/commit/3d4ed827f07d8045964ccb21c06040dfcffeeb3b))

### Build & Dependencies

* Keep developer mode's plan files out of the format gate ([b1b6055](https://github.com/casaper/hangar/commit/b1b60559414d48ff8c726e0a3a6efce57581be39))

## [0.22.0](https://github.com/casaper/hangar/compare/v0.21.2...v0.22.0) (2026-09-10)

### Features

* **exec:** Run a shell snippet in selected or all clones, in the user's own shell ([aef12ec](https://github.com/casaper/hangar/commit/aef12ecfee92b7d5a9d575b842477a36e1ed6bad))

## [0.21.2](https://github.com/casaper/hangar/compare/v0.21.1...v0.21.2) (2026-09-10)

### Build & Dependencies

* Move eslint and typescript-eslint past the cooldown, not to latest ([f07c679](https://github.com/casaper/hangar/commit/f07c679c6f38a38759102e7313cc2f8c10b927f4))
* Take commander 15, and its extra-typings peer with it ([eadbfd7](https://github.com/casaper/hangar/commit/eadbfd79d60af460f94d050e673fe30f6cda9ac7))

## [0.21.1](https://github.com/casaper/hangar/compare/v0.21.0...v0.21.1) (2026-09-10)

### Documentation

* **mcp:** Give hangar mcp a row in the operator's command reference ([9f7232b](https://github.com/casaper/hangar/commit/9f7232b947af3c0a9570c9ade4530ce9dc3d64a9))
* **modes:** Name the developer tab's window, now that there are three of them ([fb8b96a](https://github.com/casaper/hangar/commit/fb8b96aa1650f66fc39a39c126fc764bced9937b))

### Chores

* **modes:** Pre-approve the other half of developer mode's golden gate ([acb58b7](https://github.com/casaper/hangar/commit/acb58b7b451b17159adc817afbfa82b95a4bd4a4))

### Styles

* **fleet:** Wrap the two skills' prose at the width the rest of it uses ([4319435](https://github.com/casaper/hangar/commit/4319435833568206c7f18753daec23ba4ae939c7))

## [0.21.0](https://github.com/casaper/hangar/compare/v0.20.0...v0.21.0) (2026-09-09)

### Features

* **mcp:** Expose every command and flag a tool can usefully carry ([522d866](https://github.com/casaper/hangar/commit/522d8664acf9c5464673ef0f82e33bfe64ef970a))
* **mcp:** Serve the hangar's own commands to a mode session as tools ([fb10cf5](https://github.com/casaper/hangar/commit/fb10cf5a09b9f2b22a5f4741e75a2cfce0c98f66))
* **modes:** Give both mode sessions the hangar tool server ([7f0de7b](https://github.com/casaper/hangar/commit/7f0de7b0d37929ef7cfd26959e7356c38b74fd6d))

### Documentation

* **cli:** Drop the code map's counts, and give two modules a row ([1fe8827](https://github.com/casaper/hangar/commit/1fe88274bd86ed86a6bb42e1bb087d43910e431d))
* **mcp:** Say what a tool separates that a Bash prefix cannot ([f1c2f95](https://github.com/casaper/hangar/commit/f1c2f9574b28c6b85462882c2e06e379c57d7464))
* **modes:** Correct both modes' instructions for a session that has the tools ([52e6aa7](https://github.com/casaper/hangar/commit/52e6aa79ff09e643ca86075ae5fe507e75cb11e3))
* **modes:** Correct developer mode's tab, its gates and what a tool call is not ([9801eb5](https://github.com/casaper/hangar/commit/9801eb56469fdee80c8dc793ab66e3c26b2f994e))
* **modes:** Say what stops and asks, and what the write deny does not cover ([a4d4994](https://github.com/casaper/hangar/commit/a4d4994ecc9b3ccaa070774668f0d624ba94617d))
* **modes:** Say where the probe's tool count comes from, rather than writing it down ([303e665](https://github.com/casaper/hangar/commit/303e665ff164fe494ded6a3fd33da1ec4bc6a5e3))
* **modes:** Trim operator mode's tool note, and say why developer mode has no rules ([a781cf5](https://github.com/casaper/hangar/commit/a781cf589a6091162822b848c607e46355dfb12a))

### Tests

* **mcp:** Hold every exposed tool to a permission rule of its own ([85a0e82](https://github.com/casaper/hangar/commit/85a0e829f82a8cb1c21b53c33247dc6d67c1419c))

### Chores

* **modes:** Pre-approve the gates developer mode runs after every change ([4c630c0](https://github.com/casaper/hangar/commit/4c630c031a1bcdb62b6c77cfbb9d4e4d534eb925))

## [0.20.0](https://github.com/casaper/hangar/compare/v0.19.0...v0.20.0) (2026-09-09)

### Features

* **cli:** Read a pull request's state, review and build status, not just its number ([2c96537](https://github.com/casaper/hangar/commit/2c9653742e75217785d1126c92594387c75f4334))
* **config:** Give the pull-request cache a refresh interval ([e8a073b](https://github.com/casaper/hangar/commit/e8a073ba124a28d665bb8c2ef823e6aa51040ffb))
* **terminal:** Keep the bar's pull request current without ever blocking a redraw ([7bddda2](https://github.com/casaper/hangar/commit/7bddda2592806f2ca9218b39fbb53bf75faf1e2c)), closes [#26a641](https://github.com/casaper/hangar/issues/26a641)

### Documentation

* **cli:** Say why the bar asks Bitbucket directly rather than through a CLI ([b029fe8](https://github.com/casaper/hangar/commit/b029fe84a63e6a88b106747f19303e0c99847858))

## [0.19.0](https://github.com/casaper/hangar/compare/v0.18.0...v0.19.0) (2026-09-09)

### Features

* **cli:** Add hangar close, and collect the plans a killed session cannot ([6081913](https://github.com/casaper/hangar/commit/6081913446cf38f6c9662e255f5238ff941db5da))
* **cli:** Add hangar reload, the fresh-conf path kill-server was needed for ([bac520b](https://github.com/casaper/hangar/commit/bac520ba9f65c3d624108da30286b61e6fcde26d))
* **cli:** Say what the context costs and which session it is, on the status line ([cdedf5e](https://github.com/casaper/hangar/commit/cdedf5ef94e66b91c7a062f7b737566accd67ddb))
* **editor:** Let a driver close the window one clone is open in ([c122d74](https://github.com/casaper/hangar/commit/c122d74b55712ad256f545e16d19dcb8d3110089))
* **editor:** Put the clone, its branch and its hue in the VS Code window ([7a426d0](https://github.com/casaper/hangar/commit/7a426d072ea8e6564649fdefd5ddf9a64b07e0ca))
* **modes:** Give the hangar-root session a third tab that is just a shell ([de68a7d](https://github.com/casaper/hangar/commit/de68a7d0e675c00d7cd630e1fbcea1cfdef3a3e6))
* **sync:** Cache which pull request a branch has, keyed on the branch ([7646e26](https://github.com/casaper/hangar/commit/7646e26ed6965979d541032572c2f0f924183ab4))
* **terminal:** Give a clone's shells a prompt the footer does not repeat ([dd5cfcc](https://github.com/casaper/hangar/commit/dd5cfcc51ce6bc76a389e0ed703f6a18f827ddd7))
* **terminal:** Name the branch, the ticket and the pull request on the clone bar ([1ffa341](https://github.com/casaper/hangar/commit/1ffa341f160b2957b83c181ab18bdb7f8512b983)), closes [PR#1204](https://github.com/casaper/PR/issues/1204)
* **terminal:** Put the clone, its path and its git state on the pane footer ([332f6c6](https://github.com/casaper/hangar/commit/332f6c688879668b6e41ba59999fefc31c348e71))

### Bug Fixes

* **editor:** Keep a padded workspace folder label padded through a sync ([10838ac](https://github.com/casaper/hangar/commit/10838ace5ed31bd7ffea77a493a9c55bef796e1e))
* **terminal:** Draw the footer on every window, not only the current one ([2120ba0](https://github.com/casaper/hangar/commit/2120ba0033e1f9ec7d0bfd65d35495929ec2b927))
* **terminal:** Make the Accessibility hint a path you can actually paste ([b07b1a6](https://github.com/casaper/hangar/commit/b07b1a6cee112480e4b07c5a2200deb66890770c))
* **terminal:** Name tmux in the Accessibility hint, not just the terminal ([b1cb688](https://github.com/casaper/hangar/commit/b1cb6880e9823f1accc24df9e6e7e8ec09e50c66))

### Build & Dependencies

* **cli:** Keep a plugin's scratch directory out of lint ([331f611](https://github.com/casaper/hangar/commit/331f6114e06ec8b1ee997fab75d5131b11f3a385))

## [0.18.0](https://github.com/casaper/hangar/compare/v0.17.0...v0.18.0) (2026-09-08)

### Features

* **cli:** Let a bare claude in the hangar root open both sessions ([eebbeac](https://github.com/casaper/hangar/commit/eebbeacd6e07342fc8650be24053e0e1c06676ff))
* **cli:** Open both hangar-root sessions in one tmux window ([bd3f09b](https://github.com/casaper/hangar/commit/bd3f09bf72b649b96d4e44c4104e50d5525967f6))
* **modes:** Make one command the only way into a hangar-root session ([d6d7b83](https://github.com/casaper/hangar/commit/d6d7b8305aa14b91d10db1b6d1860b2a033333b2))

### Bug Fixes

* **cli:** Answer hangar claude --help on a machine with no claude installed ([f04b15e](https://github.com/casaper/hangar/commit/f04b15e480fecad3b0302b0891cd1adee492f415))

### Documentation

* **modes:** Name the tmux hop the statusline's PATH argument runs through ([23314bc](https://github.com/casaper/hangar/commit/23314bcee4cb0bd2ddf8922a0d73bc95029b5497))
* **modes:** Say that one command opens both hangar-root sessions ([473dab3](https://github.com/casaper/hangar/commit/473dab378f3d569d9001c64fd8888671a30f7279))

## [0.17.0](https://github.com/casaper/hangar/compare/v0.16.2...v0.17.0) (2026-09-08)

### Features

* **colours:** Apply the status bar to a tmux server that is already running ([52fe00e](https://github.com/casaper/hangar/commit/52fe00ed4c016e846bcc720c6f34d393fbf14c33)), closes [#1c1c1c](https://github.com/casaper/hangar/issues/1c1c1c) [#bbbbbb](https://github.com/casaper/hangar/issues/bbbbbb) [#ffcc00](https://github.com/casaper/hangar/issues/ffcc00) [#000000](https://github.com/casaper/hangar/issues/000000)
* **sync:** Let the operator instruct the conflict resolver while it is still working ([7dcd0f1](https://github.com/casaper/hangar/commit/7dcd0f1b46d296f751f978c7c5c39ffb376279d6))

### Bug Fixes

* **colours:** Choose a readable ink for any clone hue, and derive it from the hue itself ([a40cff8](https://github.com/casaper/hangar/commit/a40cff81a27e6af7114218a8515d7e9882277e1c))
* **sync:** Let no editor open in a rebase, and put anything else that asks on the screen ([833fbc2](https://github.com/casaper/hangar/commit/833fbc238a0992323c6b99d0035d6fef8b0e5c71))
* **terminal:** Give the tmux status bar its own background, so a clone hue is readable on it ([db439d8](https://github.com/casaper/hangar/commit/db439d81fec5c106b5048e92265fd13f21d72469)), closes [#1c1c1c](https://github.com/casaper/hangar/issues/1c1c1c) [#bbbbbb](https://github.com/casaper/hangar/issues/bbbbbb) [#000000](https://github.com/casaper/hangar/issues/000000)
* **terminal:** Leave the clone badge room, now that it carries a background ([50ffc10](https://github.com/casaper/hangar/commit/50ffc10bad5af5d25edb93a6be458c7676b1478a))

### Documentation

* **colours:** Say that the status bar carries the hue as a background, not as text ([d83f1bc](https://github.com/casaper/hangar/commit/d83f1bc394a07beb703f99711946160fe39727cc))

## [0.16.2](https://github.com/casaper/hangar/compare/v0.16.1...v0.16.2) (2026-09-07)

### Bug Fixes

* **jira:** Compare a cached name's link target, not two inodes ([00770ad](https://github.com/casaper/hangar/commit/00770adea41e86a8b6d3edc865358e21556d6b6f))
* **jira:** Find a cached record by its directory, and point it at the store with a symlink ([32ad6f7](https://github.com/casaper/hangar/commit/32ad6f7154fb7e1a2a514184747c4aecca05af8b))
* **jira:** Read a whole frontmatter block, so a record's fetched_at is found ([76e74ce](https://github.com/casaper/hangar/commit/76e74ce373725351e55c0fb423d113ccd010f5b0))
* **tmp:** Link the record store into every clone, and fold a clone's own private one ([06b1f33](https://github.com/casaper/hangar/commit/06b1f331bedbc2b619ff01a8672d5bb71c60fa3d))
* **tmp:** Remove a clone's private record store once nothing is left to decide ([304f515](https://github.com/casaper/hangar/commit/304f5152a86d97fe3bed22a41f974c56900fb93e))

### Refactoring

* **jira:** Let a name that cannot be a symlink stay exactly as it is ([7c6b41e](https://github.com/casaper/hangar/commit/7c6b41efa57b5c05d9068e7d20203fdb049080f6))

### Documentation

* **jira:** Say that a cached record is a symlink into the store ([bbd962d](https://github.com/casaper/hangar/commit/bbd962d640380d211999efa7b258ae4ba422c5d5))

## [0.16.1](https://github.com/casaper/hangar/compare/v0.16.0...v0.16.1) (2026-09-07)

### Documentation

* **doctor:** Say what each doctor row means, not what it once failed to ([f8f8166](https://github.com/casaper/hangar/commit/f8f81668be0d2967c867bd6223977129f6901f0a))
* State what doctor checks, instead of narrating how it learnt to ([115b7b2](https://github.com/casaper/hangar/commit/115b7b2a41e0234b05fda9b78c862d80d73b0144))
* **terminal:** Say what GNOME Terminal cannot do, which is raise a window ([51d0a5e](https://github.com/casaper/hangar/commit/51d0a5e7b81630586ade694e4b31141a2eb3f3eb))

## [0.16.0](https://github.com/casaper/hangar/compare/v0.15.0...v0.16.0) (2026-09-07)

### Features

* **terminal:** Colour a tmux window per clone, from the hook every emulator uses ([68dc3c2](https://github.com/casaper/hangar/commit/68dc3c25b4881af197a07edafc6749d71bdf683a))
* **terminal:** Generate the hangar's own tmux config from colours sync ([4a946d3](https://github.com/casaper/hangar/commit/4a946d3bbcc624843c956eee2098dc2c03712882))
* **terminal:** Give the hangar its own tmux server on a private socket ([24d12b8](https://github.com/casaper/hangar/commit/24d12b8388e3e916c8ead8dab9bfbe604c69ffa1))

### Bug Fixes

* **doctor:** Repeat the warnings in the closing summary, not just their count ([b194b3a](https://github.com/casaper/hangar/commit/b194b3a5c86a2128cfdcecf058f06f1514a9ac78))

### Refactoring

* **colours:** Reach tmux by name in the generated hook, not through the shell's alias ([ad712ef](https://github.com/casaper/hangar/commit/ad712eff3ad33a36eb08b6f421376743ed397ad0))
* **terminal:** One tab per clone, attached to that clone's own tmux session ([b00bb72](https://github.com/casaper/hangar/commit/b00bb725b15593a7872cbb0a759f406f194750a1))

### Documentation

* **terminal:** Say how a clone's window is built, and what tmux owns ([c6b7b8d](https://github.com/casaper/hangar/commit/c6b7b8d2811c35998568623ddd7ec0fa2316844d))

### Chores

* update pnpm to 12 ([66eb87c](https://github.com/casaper/hangar/commit/66eb87c942e6dfe389dcabcee383aa5b449ea6e4))

## [0.15.0](https://github.com/casaper/hangar/compare/v0.14.2...v0.15.0) (2026-09-06)

### Features

* **cli:** Add --yes to hangar dev release, for a run with no terminal ([8ea873e](https://github.com/casaper/hangar/commit/8ea873e27658e485275b058e6d999b7607d6e258))

## [0.14.2](https://github.com/casaper/hangar/compare/v0.14.1...v0.14.2) (2026-09-06)

### Bug Fixes

* **cli:** Point the token hints at where the token now comes from ([4566f7d](https://github.com/casaper/hangar/commit/4566f7d73b72fd39895f7d523073112dd7d1f9ce))

## [0.14.1](https://github.com/casaper/hangar/compare/v0.14.0...v0.14.1) (2026-09-06)

### Bug Fixes

* **cli:** Say what a failed release actually left behind, having watched one ([8132dd5](https://github.com/casaper/hangar/commit/8132dd54786a833d7471530244c8276fa640792c))

### Chores

* make hangar own repo secrets via .env.local available ([67ebf03](https://github.com/casaper/hangar/commit/67ebf038ed60d1aee8e38a3020cec8ba9fcbf1f2))

## [0.14.0](https://github.com/casaper/hangar/compare/v0.13.0...v0.14.0) (2026-09-06)

### Features

* **cli:** Cut releases from a local command instead of a workflow ([c440afe](https://github.com/casaper/hangar/commit/c440afe2c2b95528ee0927d6485dfa3597244a15))
* **test:** Gate the tree against organisation names, machine paths and credentials ([121dc79](https://github.com/casaper/hangar/commit/121dc793244934e3c45415b7eb66beccdaa42e34))

### Bug Fixes

* **cli:** Ask GitHub about the token before running the gates, not after ([59aa982](https://github.com/casaper/hangar/commit/59aa98294dda317398a49e0e281b6ca43e63c64b))
* **cli:** Make `pnpm changelog` reproduce the file it generated ([7d0b75a](https://github.com/casaper/hangar/commit/7d0b75a257edacade27438417591aa84c308afc1))
* **cli:** Read the version from package.json instead of repeating it ([a68cfde](https://github.com/casaper/hangar/commit/a68cfde674f808bbbf49fed8f33afe60212fe910))
* **config:** Keep site-specific values out of the committed example ([01c7f50](https://github.com/casaper/hangar/commit/01c7f50b0b16408e44d91b252188b7e19af01c5a))
* **modes:** Resolve the mode status line on PATH instead of an absolute path ([cd1c9ee](https://github.com/casaper/hangar/commit/cd1c9ee02a0c4f58447b56217d419f8ec4a65520))

### Refactoring

* **cli:** Let semantic-release do the release, behind this repo's gates ([94024fa](https://github.com/casaper/hangar/commit/94024fa66bd849a0c29a18aeb1aa300645290e98))
* **editor:** Name the VS Code template placeholders after the tool ([26f4896](https://github.com/casaper/hangar/commit/26f489699de3f9b09c3aca4e2471a38adf9734f7))

### Documentation

* **cli:** Let the comments and the skills name no fleet in particular ([d0509db](https://github.com/casaper/hangar/commit/d0509dba9b36b60ea20cf6f4de984f4c10b9e509))
* **cli:** Say how a release is cut now, and why the root may hold a package.json ([d293dbf](https://github.com/casaper/hangar/commit/d293dbf8492e2287467e2eac4fd87eea92325a1a))
* Write down the commit convention, the hook, and how a release is cut ([f59d46d](https://github.com/casaper/hangar/commit/f59d46d29273f52632f6559c97d96e65fbd4b468))

### Build & Dependencies

* Adopt Conventional Commits, and make the rules this repo's own ([0406c3c](https://github.com/casaper/hangar/commit/0406c3cb42ef231624cf8b8915a33fcd19fff561))
* **cli:** Drop semantic-release, and let the hangar root run its own scripts ([424961e](https://github.com/casaper/hangar/commit/424961edbd53aa2d474d645364a3f9f3c313dd73))

### Continuous Integration

* Cut releases from main with semantic-release, and lint every pushed commit ([1e9373c](https://github.com/casaper/hangar/commit/1e9373cb6a5d608d875ddf94ed317d081d948c96))
* **release:** Run the hygiene gates, and harden the commitlint range ([6b0b40b](https://github.com/casaper/hangar/commit/6b0b40b9c924b03b6013fd973ae3f18f20fcdefa))

### Chores

* **cli:** Regenerate the changelog ([77381f4](https://github.com/casaper/hangar/commit/77381f43e2e45af206cffea7d9d995cbc8d88665))

## [0.13.0](https://github.com/casaper/hangar/compare/v0.12.0...v0.13.0) (2026-09-05)

### Bug Fixes

* **editor:** Let a hangar whose editor is not VS Code actually be one ([55ec6be](https://github.com/casaper/hangar/commit/55ec6be8265d4c79d10c2f8cc76f543a152b3154))
* **status:** Ask the config before blaming a branch for having no issue key ([0c2aea9](https://github.com/casaper/hangar/commit/0c2aea9f90ebd167011a469c0178223cec9cac75))

## [0.12.0](https://github.com/casaper/hangar/compare/v0.11.0...v0.12.0) (2026-09-05)

### Bug Fixes

* **config:** Hold a clone's whole derived settings half, and read the tracker keys nothing read ([513ce64](https://github.com/casaper/hangar/commit/513ce647a99d04953da6a4055a082d6e0a72c989))
* **config:** Make a copied config reach a working fleet, and let doctor say what is not ([404847d](https://github.com/casaper/hangar/commit/404847d34a862ffc3926d555c99a175d4892c1a1))
* **doctor:** Wire the tracker hook only where a tracker is declared ([123180b](https://github.com/casaper/hangar/commit/123180b28c52e92fc07cac6bc6eb5c86dd406ddb))
* **golden:** Make the gated baseline somebody else's too, and stop writing this repo into every hangar ([2da3365](https://github.com/casaper/hangar/commit/2da336534f8504b6a7e2951aee0cbeaa659c0450))
* **setup:** Close the gaps a colleague's first day would find, and check two of them from now on ([886e17b](https://github.com/casaper/hangar/commit/886e17b635852d06c24eb67089c26218d2fff038))

## [0.11.0](https://github.com/casaper/hangar/compare/v0.10.0...v0.11.0) (2026-09-05)

### Documentation

* **test:** Say the suite exists, and say exactly what it does not cover ([e8673c5](https://github.com/casaper/hangar/commit/e8673c5f7c6b7fe8e7d279d0b886aad7eb4d7d8b))

### Tests

* Put pnpm test in the developer-mode gate, and make two weak assertions real ([fc1adcd](https://github.com/casaper/hangar/commit/fc1adcd1b1eb7cef84a5ad38aca9624535c272a9))
* Seed a node:test suite, and let it find one thing on the way in ([f62b50e](https://github.com/casaper/hangar/commit/f62b50eea02f8a87d1cfc0bec728fe9163ceed30))

### Chores

* Keep an untracked plugin buffer out of prettier's way ([ed8dcb1](https://github.com/casaper/hangar/commit/ed8dcb1a03642c3e2917305afee5044a81168894))

## [0.10.0](https://github.com/casaper/hangar/compare/v0.9.0...v0.10.0) (2026-09-05)

### Features

* **platform:** Add the platform seam, and stop assuming macOS in five places ([753276d](https://github.com/casaper/hangar/commit/753276dddfa31718992c5b640ad7798423376b47))
* **terminal:** Add the tmux terminal driver, verified against a live server ([ac9517e](https://github.com/casaper/hangar/commit/ac9517e73ffd6cd8e25f98f82a6b5fcc63c47517))

### Bug Fixes

* **terminal:** Require an attached tmux client, not just a running server ([e143201](https://github.com/casaper/hangar/commit/e143201c28de7ec6b571e3154226ff690bf50b99))

### Documentation

* **platform:** Document the platform seam, the two detectors, and what stays unverified ([cf58635](https://github.com/casaper/hangar/commit/cf5863544771505da2c2482a78bdba765e4c0558))
* **terminal:** Document tmux, and shrink the README's Linux punch list to what is still open ([62af7fb](https://github.com/casaper/hangar/commit/62af7fbf3f1d590c6e04121cac4b7c6ca22f5be7))

## [0.9.0](https://github.com/casaper/hangar/compare/v0.8.0...v0.9.0) (2026-09-04)

### Features

* **add-clone:** Let `add-clone` make the first clone, and delete the last four literals ([21e6983](https://github.com/casaper/hangar/commit/21e69835d55634cbcb7f83c8248e97318f6bc9d7)), closes [#1](https://github.com/casaper/hangar/issues/1)
* **install:** Run the install steps the repo declares, not `npm ci` in `angular/` ([7ec26f5](https://github.com/casaper/hangar/commit/7ec26f58128c032f17a3186b1a3d19b695ecdccb))
* **setup:** Generate the hangar's own Claude Code settings; report the modes', never fix ([328b32a](https://github.com/casaper/hangar/commit/328b32ab6b3a2031a03eef564a4bf3b5e2e87f71))

### Bug Fixes

* **config:** Finish the genericisation the F10 grep found still open ([6f4c9c6](https://github.com/casaper/hangar/commit/6f4c9c63450f73bd58f800d16a048c40e5bf7883))
* **ide:** Derive the two patterns `ide vscode sync` reads backwards ([2b2a970](https://github.com/casaper/hangar/commit/2b2a97095cb3d4c822012fbe3c0a715fe6e9743d))
* **setup:** Make `setup` emit only what it observed, or admit it did not ([65b6d06](https://github.com/casaper/hangar/commit/65b6d060eb7e7881c2b04793de25c1c52e3a2a25))

### Documentation

* Split the fleet map into how a hangar works and which hangar this is ([8e7e38d](https://github.com/casaper/hangar/commit/8e7e38d85a76a622d0ddf42663d934b17579ebc2))

### Chores

* Untrack what a `hangar` command rewrites, and move the one file it does not ([1aed90b](https://github.com/casaper/hangar/commit/1aed90b505cf16866337b315ae3772ff0509a38a))

## [0.8.0](https://github.com/casaper/hangar/compare/v0.7.0...v0.8.0) (2026-09-04)

### Features

* **config:** Open the port-role table so a hangar can serve something else ([3c3b560](https://github.com/casaper/hangar/commit/3c3b560a2d7b4be351b6ed78d04df29f9d46870b))
* **config:** Render the config's templates, and read the keys nothing was reading ([103f675](https://github.com/casaper/hangar/commit/103f6756c5424e792f2da2dad464c144a421ad43)), closes [#1](https://github.com/casaper/hangar/issues/1)
* **golden:** Give a fresh clone a way in, and a regression net to refactor behind ([cf3d3be](https://github.com/casaper/hangar/commit/cf3d3bea4d17ff4a080fc54008d74e6dfb63d047))

### Bug Fixes

* **colours:** Name everything a hangar writes outside its own root after the hangar ([07afef0](https://github.com/casaper/hangar/commit/07afef004c3d86478b2723ce67bfbc0d2dcb11b0))

### Refactoring

* **cli:** Split the user's paths out of the hangar's ([f8d4932](https://github.com/casaper/hangar/commit/f8d49328529747ad7927dc59bbcec997cd2627d8))
* **cli:** Thread the hangar instead of guessing it from the CLI's own location ([645699e](https://github.com/casaper/hangar/commit/645699ee9f5ee94d86e7da1971b4ad8711e4e2a4))
* **config:** Report the discovery source from the threaded hangar, not a second lookup ([208a223](https://github.com/casaper/hangar/commit/208a2231d36453fab18a366efd06001794364900))

## [0.7.0](https://github.com/casaper/hangar/compare/v0.6.0...v0.7.0) (2026-09-04)

### Features

* **modes:** Give the hangar root two launch modes, and a badge that says which ([bb4af28](https://github.com/casaper/hangar/commit/bb4af28e14ab9c00a46fb380ca7c05435e08621c))

### Documentation

* Add a skill for driving the fleet rather than building it ([26fc7c2](https://github.com/casaper/hangar/commit/26fc7c2e31cb251096361cef3015729765223174))
* Cut the fleet map back to what a clone session can act on ([7c77625](https://github.com/casaper/hangar/commit/7c776254e9b2fc6e00ced5403d99de719f9729b1))
* Fix the eleven defects the doc restructuring left behind ([75d1c43](https://github.com/casaper/hangar/commit/75d1c439e990473d1698237ec54849ab22784dde))
* Give the CLI its own `CLAUDE.md`, one directory down ([19f975d](https://github.com/casaper/hangar/commit/19f975dad8574e4c8a24cce77b5ddb8aa2ff347a))
* Make `app/CLAUDE.md` own the hangar root files this package generates ([ce7ade3](https://github.com/casaper/hangar/commit/ce7ade380cfdf8d39421e552fbc997122f433d0d))
* Split the internals skill into an index and six references ([3ccc2d1](https://github.com/casaper/hangar/commit/3ccc2d1e7f65d3d97952aa32735942674db9fd02))

## [0.6.0](https://github.com/casaper/hangar/compare/v0.5.0...v0.6.0) (2026-09-04)

### Features

* **config:** Ask git which branch is the default once, then remember it ([f188ae8](https://github.com/casaper/hangar/commit/f188ae8f401ac179d0fea5f004d2cfc5c8e2528d))
* **config:** Split the config in two, and refuse to run without the live half ([f6ed0a7](https://github.com/casaper/hangar/commit/f6ed0a7e765ce622b37657fe498425471acae9f1))
* **open:** Add `checkout-default`, and make `open` land each clone on it ([415e742](https://github.com/casaper/hangar/commit/415e742193a984e0a71c3b8304aecf14435bc6cf))
* **sync:** Give `sync` two more names, and let the name pick the strategy ([9359b68](https://github.com/casaper/hangar/commit/9359b68363a6bb39ee23554bba38e9814e0d49c7))

### Bug Fixes

* **cli:** Delete the shim that forwards to a command nobody registers ([59909d9](https://github.com/casaper/hangar/commit/59909d90541f9ed378e9909948d5629d097ae04d))

## [0.5.0](https://github.com/casaper/hangar/compare/v0.4.0...v0.5.0) (2026-09-03)

### Features

* **editor:** Make the editor a seam too, and fill it ([bd8f391](https://github.com/casaper/hangar/commit/bd8f391822b390e23ce096cda7088bbaf616a4f8))
* **editor:** Say so when the editors came from a default nobody wrote ([a214149](https://github.com/casaper/hangar/commit/a214149333c4ab06ff7e1ab84070cde798e85888))
* **terminal:** Become Hangar, and drive terminals other than iTerm2 ([ff4735a](https://github.com/casaper/hangar/commit/ff4735aebfa2574a9cb5239ea685ac9b666863eb))

### Bug Fixes

* **colours:** Stop the rename leaving a dead hook, and a hue behind the text ([638f0ab](https://github.com/casaper/hangar/commit/638f0ab40302344e0bbb0757f0856915b4bf9863))
* **editor:** Rank VS Code above the editors it stands beside ([b1bba8e](https://github.com/casaper/hangar/commit/b1bba8e03154d8ed44ea2c2a16de3bfdb7a71637))
* **ide:** Stop `<kind> sync` blaming the developer for a file it could not read ([ea284f1](https://github.com/casaper/hangar/commit/ea284f127d8241279f9a3f2dbe006869d62b1e4c))

### Documentation

* Move the CLI's rationale out of the ancestor walk ([567b6ac](https://github.com/casaper/hangar/commit/567b6ace085279e52ff7b6f4ef7601f822545d52))

## [0.4.0](https://github.com/casaper/hangar/compare/v0.3.0...v0.4.0) (2026-09-03)

### Features

* **doctor:** Tell each clone what is true of ITS session, and check that it still says it ([872560e](https://github.com/casaper/hangar/commit/872560e3225561f18c6593a125e9012d5799b2ed))

### Bug Fixes

* **fleet:** Render every clone's identity file from the clone alone ([01ff6fe](https://github.com/casaper/hangar/commit/01ff6fe88e3a7c0151c94944487bc75d2f35faca))
* **sync:** Always tell a paused session how the sync ended ([4caf8b7](https://github.com/casaper/hangar/commit/4caf8b7b3a00b2e9fd8c72da5d776ba0c66fa9a6))
* **sync:** Do not tell an up-to-date clone its branch moved ([8eb84f4](https://github.com/casaper/hangar/commit/8eb84f41bf21aba13a49233c71f0296b3acdd2fc))

### Documentation

* Generalise the two rules the identity file taught ([86968f3](https://github.com/casaper/hangar/commit/86968f3b67a7abd4fc100ef0e4af7a3245f56adc))
* Say "every clone" where the fleet map still said three ([ec47f26](https://github.com/casaper/hangar/commit/ec47f26626e6e35b47e2222eb5a6f89e4b73c1e1))
* Stop the fleet map from carrying a clone count ([52eceec](https://github.com/casaper/hangar/commit/52eceec922e451a212b2e3d87c9fda1360e03f3e))
* Write down the two CLI conventions this session leaned on ([98a1be8](https://github.com/casaper/hangar/commit/98a1be837efc0833a6163b5f6c17a141352f3753))

### Chores

* **colours:** clone_04 is red, and the assignment file it needs now exists ([6815824](https://github.com/casaper/hangar/commit/6815824f708fd7397f0c85e04ebc5f465e3d0d3c))

## [0.3.0](https://github.com/casaper/hangar/compare/v0.2.0...v0.3.0) (2026-09-02)

### Features

* **colours:** Let a clone be re-coloured, and give the palette four more hues ([854c8f2](https://github.com/casaper/hangar/commit/854c8f272cb80562d0278a4df97f21dfdef14c6b))
* **jira:** Give every Jira ticket one record, and stop re-fetching a fresh one ([d90d05f](https://github.com/casaper/hangar/commit/d90d05f2156393458a62fb159b984da0a2dbab70))
* **sync:** Sync onto the branch the pull request targets, not onto master ([ceee6b8](https://github.com/casaper/hangar/commit/ceee6b8502ef041c0a745651d8ce0725e7450b69)), closes [#838](https://github.com/casaper/hangar/issues/838)
* **tmp:** Merge each clone's new cache entries when its session ends ([e2b5670](https://github.com/casaper/hangar/commit/e2b56706f47bd7e24a8d539b69d6c8cfcaa3890a))

### Bug Fixes

* **doctor:** Allow every .envrc, and set checkout.defaultRemote in every clone ([5957cf2](https://github.com/casaper/hangar/commit/5957cf2267c21ab931a46703e6ef50ba592e380f))
* **jira:** Never let the ticket hook hand back a copy older than the clone's own ([5b13722](https://github.com/casaper/hangar/commit/5b13722fbc9489b5e9e120429121cf8572840486))
* **sync:** Fix two ways a target could be wrong without saying so ([f425be5](https://github.com/casaper/hangar/commit/f425be51dbecdfeb46148b6cca6c2ad6bb562e72))

### Chores

* **fleet:** add clone 4 ([e689782](https://github.com/casaper/hangar/commit/e689782ed606ef072917a0fe008f0d4d08c4883e))

## [0.2.0](https://github.com/casaper/hangar/compare/v0.1.0...v0.2.0) (2026-09-02)

### Features

* **ide:** Add `orch-util vscode sync`, and repair the stale tool paths it found ([5598ee2](https://github.com/casaper/hangar/commit/5598ee2ea082327f0edd53088da23468b24ec71f))
* **open:** Open every clone into one iTerm2 window, and stop duplicating its VS Code window ([90b7995](https://github.com/casaper/hangar/commit/90b7995b84e9c60b6d218a139b36bc76d4ebc967))
* **resume:** Add `orch-util resume`, a picker for a clone's past Claude Code sessions ([2d923f0](https://github.com/casaper/hangar/commit/2d923f0defea3a1231495e14a3247ae379551e9b))
* **sync:** Stream the headless conflict resolver, and refuse to sync onto a half-applied rebase ([bb4f8e3](https://github.com/casaper/hangar/commit/bb4f8e3b95b707907eb5f49e297e88e99ce82c32))
* **tmp:** Share the tmp/ cache per entry, and let every clone keep its own tmp/ ([27bda3a](https://github.com/casaper/hangar/commit/27bda3a3c5f7a9e6211f0af50f7ac33976aff9b6))

### Bug Fixes

* **jira:** Collapse a ticket's duplicate cache files, and fix the key regex that hid them ([a301389](https://github.com/casaper/hangar/commit/a3013896d2e0b6c7bd1e58fb650034a7eb723c38))
* **tmp:** Skip a busy clone in `tmp merge` instead of refusing the fleet ([4a14e1b](https://github.com/casaper/hangar/commit/4a14e1b1f6794b14c2e19060eb2f1bb0afec8822))
* **tmp:** Stop `tmp merge` carrying PID files into the shared tmp/ ([a41b139](https://github.com/casaper/hangar/commit/a41b139b1eb8524f6201a2db82d403e9af6bcf1a))

## [0.1.0](https://github.com/casaper/hangar/compare/v0.0.1...v0.1.0) (2026-09-01)

### Features

* **cli:** Make the clone fleet dynamic and orchestrate it from orch-util ([cae9490](https://github.com/casaper/hangar/commit/cae9490932b9ad502564b6dabbeaab95dc8a1945))
* **plans:** Collect plans on SessionEnd, and stop copying plansDirectory per clone ([627ea83](https://github.com/casaper/hangar/commit/627ea8302fc6acb71337b8dcf5eda270975bdbf7))
* **plans:** Share plans and tmp across the fleet, and print clones by index ([d13ecc2](https://github.com/casaper/hangar/commit/d13ecc2ccb5bbe18400da45c15782f28a8430fd5))
* **tmp:** Share the per-ticket Jira cache across the three clones ([9fee32a](https://github.com/casaper/hangar/commit/9fee32a77073b2b35be210328d4205e0a88c54fc))

### Bug Fixes

* **cli:** Move the CLI package into orch/, out of every clone's ancestor path ([88ab852](https://github.com/casaper/hangar/commit/88ab852a992fadaa5c0a5f2430958a7a4e689dfb))
* **plans:** ensure plans and temp dir exist ([35b93f4](https://github.com/casaper/hangar/commit/35b93f479c91ff786660e199610b7f1a40d29e53))

### Documentation

* Correct the fleet map: the parent root is itself a git repo ([e99ed4a](https://github.com/casaper/hangar/commit/e99ed4a45551a84bda9532126e61dbd994b70b53))
* **plans:** Record that plansDirectory takes an absolute path despite the stale schema ([4d84097](https://github.com/casaper/hangar/commit/4d840974b54addb6174eb3f2a4aa4bfb76a44cb5))

## [0.0.1](https://github.com/casaper/hangar/compare/f69854f6b90d4a11a8f2230a97d793f6169a22ce...v0.0.1) (2026-08-31)

### Features

* Set up the dvb_gn clone fleet: shared map, colour identity, shared secrets ([f69854f](https://github.com/casaper/hangar/commit/f69854f6b90d4a11a8f2230a97d793f6169a22ce))
