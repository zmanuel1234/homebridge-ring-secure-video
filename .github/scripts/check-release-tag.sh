#!/usr/bin/env bash
# Refuses to publish unless the release tag is "v" + the version in package.json, and the
# GitHub release's "pre-release" box matches the version: ticked for a version with a "-"
# (2.2.0-beta.1, published to npm's beta tag), unticked for a stable one (published as latest).
set -euo pipefail
tag="${1:?release tag}"
prerelease="${2:-}"
version="$(node -p "require('./package.json').version")"
expected="v$version"
if [ "$tag" != "$expected" ]; then
  echo "::error::Release tag $tag does not match package.json ($expected). Merge the version PR first, then create the release with tag $expected."
  exit 1
fi
if [ -n "$prerelease" ]; then
  case "$version" in
    *-*) want=true ;;
    *) want=false ;;
  esac
  if [ "$prerelease" != "$want" ]; then
    if [ "$want" = true ]; then
      echo "::error::$version is a pre-release version: tick \"Set as a pre-release\" on the GitHub release (it would otherwise go to npm's latest tag)."
    else
      echo "::error::$version is a stable version: untick \"Set as a pre-release\" on the GitHub release (it would otherwise go to npm's beta tag)."
    fi
    exit 1
  fi
fi
echo "Release tag $tag matches package.json${prerelease:+, and the pre-release box matches the version}."
