#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
resource_cache="$repo_root/.cache/ai-resources"
resource_cdn="$resource_cache/cdn"
if [[ -f "$resource_cdn/maps/mp08t2.map" && -f "$resource_cdn/game-res/v2/isotemp.mix" ]]; then
  exit 0
fi
command -v 7z >/dev/null || { echo '7z is required to prepare AI fixtures' >&2; exit 1; }
mkdir -p "$resource_cache/source"
curl --fail --location --retry 3 --output "$resource_cache/full-pack.7z" \
  https://download.ra2web.com/full-pack.7z
printf '%s  %s\n' '541828fa48f31059eb5edb127b07253515c8f92adeaa1f0fd0b84d6ffa6656f3' \
  "$resource_cache/full-pack.7z" | sha256sum --check --strict
7z x -y "-o$resource_cache/source" "$resource_cache/full-pack.7z" >/dev/null
cd "$repo_root/ts-redalert2"
bun deploy/prepare-resources.ts "$resource_cache/source" "$resource_cdn"
