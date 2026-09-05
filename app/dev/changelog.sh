#!/bin/sh
# Regenerate the hangar's CHANGELOG.md from the git tags. Run from `app/`: `pnpm changelog`.
#
# This is a script rather than a one-line `"changelog":` entry for one reason, and it is the
# reason `dev/golden.sh` is a script too: the command has to be REPRODUCIBLE. Running the bare
# `conventional-changelog` invocation regenerates every section and drops the `# Changelog`
# heading, so the next developer to run it would see a one-line diff they did not make and could
# not explain. The heading is put back here, by the same command that removes it.
#
# The heading matters beyond tidiness: `.releaserc.json` sets `changelogTitle: "# Changelog"`, so
# on a release semantic-release prepends UNDER that line. Without it, the next release section
# would land above everything, including the title it then adds.
#
# The preset is `app/changelog.preset.ts`, which reads its section list out of `.releaserc.json` --
# so this command and the CI release cannot disagree about what a section is called.
set -eu

cd "$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd -P)"

app/node_modules/.bin/conventional-changelog \
  -n app/changelog.preset.ts \
  -i CHANGELOG.md -s -r 0 \
  -k app/package.json \
  --tag-prefix v

printf '# Changelog\n\n%s\n' "$(sed '1{/^$/d}' CHANGELOG.md)" > CHANGELOG.md.tmp
mv CHANGELOG.md.tmp CHANGELOG.md
