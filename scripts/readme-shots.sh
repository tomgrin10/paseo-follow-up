#!/bin/sh
# Re-renders the README's images in place (docs/screenshots/): the Home hero and the phone shot on Paseo 0.15 (what the
# floor serves), then Follow-up's sidebar view on Paseo 0.16, which only 0.16 has. Each run takes the machine-wide
# harness slot. Home and the panel read the latest stable version, so an image never shows a beta.
# Needs PLAYWRIGHT_CORE and CHROMIUM (docs/testing.md); HARNESS_SLOT overrides the slot wrapper's path.
set -eu
slot="${HARNESS_SLOT:-$HOME/paseo-harness/tools/harness-slot}"
stable="$(git describe --tags --abbrev=0 --match 'v[0-9]*.[0-9]*.[0-9]*' --exclude '*-*' | sed 's/^v//')"
"$slot" node scripts/screenshots.mjs --only home,phone --as-version "$stable" "$@"
HARNESS_PASEO=0.16 "$slot" node scripts/screenshots.mjs --only sidebar --as-version "$stable" "$@"
