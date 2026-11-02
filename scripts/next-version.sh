#!/bin/sh
# Works out the image version and prints key=value lines for $GITHUB_OUTPUT.
#   next-version.sh <event> <ref_type> <ref_name> <sha>
# - release tag v1.2.3        -> 1.2.3
# - push to main              -> next patch after the highest vMAJOR.MINOR.* tag, where MAJOR.MINOR come from package.json
#                                (bump the minor or major by editing package.json; the patch number is automatic)
# - anything else (PR, manual) -> dev-<sha>, never published as a release
set -eu
event=$1 ref_type=$2 ref_name=$3 sha=$4
release=false
if [ "$ref_type" = tag ]; then
  v=${ref_name#v}
elif [ "$event" = push ]; then
  base=$(sed -n 's/.*"version": *"\([0-9][0-9]*\.[0-9][0-9]*\)\..*/\1/p' package.json | head -1)
  [ -n "$base" ] || { echo "cannot read MAJOR.MINOR from package.json" >&2; exit 1; }
  last=$(git tag --list "v$base.*" | grep -E "^v$(echo "$base" | sed 's/\./\\./g')\.[0-9]+\$" | sort -V | tail -1 || true)
  if [ -z "$last" ]; then v="$base.0"; else v="$base.$(( ${last##*.} + 1 ))"; fi
  release=true
else
  v="dev-$(echo "$sha" | cut -c1-7)"
fi
case "$v" in
  dev-*) stable=false ;;
  *-*) stable=false ;;                 # pre-release such as 1.2.3-rc.1: only its own tag
  *) stable=true ;;
esac
echo "version=$v"
echo "minor=${v%.*}"
echo "major=${v%%.*}"
echo "stable=$stable"
echo "release=$release"
