#!/usr/bin/env bash
# Installs the system packages listed in .github/apt-packages (one per line, # for comments), for
# CI and the release build. Ubuntu's package mirror is sometimes very slow (ffmpeg is 66 MB of
# packages: at 142 kB/s, 8 minutes), so the downloaded packages are kept in $APT_ARCHIVES, which
# the workflows cache between runs: most runs then download nothing. apt checks every cached
# package against the signed package lists before installing it.
set -euo pipefail
list="${1:-.github/apt-packages}"
archives="${APT_ARCHIVES:-$HOME/.cache/apt-archives}"
mapfile -t packages < <(grep -Ev '^[[:space:]]*(#|$)' "$list" | tr -d '[:space:]' | grep -v '^$' || true)
if [ "${#packages[@]}" -eq 0 ]; then
  echo "No packages listed in $list"
  exit 0
fi
mkdir -p "$archives/partial"
# Rebuilding the manual-page index after installing is slow on the runners and not needed here.
echo 'man-db man-db/auto-update boolean false' | sudo debconf-set-selections
sudo rm -f /var/lib/man-db/auto-update
# A download that receives nothing for 30 s is dropped and tried again (a slow one is left to
# finish); the runner's own apt jobs, which hold the lock at start-up, are waited for up to 2 min.
opts=(-o Acquire::Retries=3 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 -o DPkg::Lock::Timeout=120
  -o "Dir::Cache::Archives=$archives" -o APT::Keep-Downloaded-Packages=true)
apt() { sudo env DEBIAN_FRONTEND=noninteractive apt-get "${opts[@]}" "$@"; }
before=$(find "$archives" -maxdepth 1 -name '*.deb' | wc -l)
echo "Packages already downloaded (cache): $before"
ok=false
for attempt in 1 2 3; do
  echo "::group::apt attempt $attempt: ${packages[*]}"
  # After a failed attempt: finish whatever it left half-installed.
  sudo dpkg --configure -a || true
  if timeout 300 sudo env DEBIAN_FRONTEND=noninteractive apt-get "${opts[@]}" update -q &&
    apt install -y -q --no-install-recommends "${packages[@]}"; then
    ok=true
  fi
  echo "::endgroup::"
  $ok && break
  echo "::warning::Installing ${packages[*]} failed (attempt $attempt of 3); trying again"
  sleep 10
done
if ! $ok; then
  echo "::error::Could not install ${packages[*]} after 3 attempts"
  exit 1
fi
after=$(find "$archives" -maxdepth 1 -name '*.deb' | wc -l)
echo "Packages downloaded this time: $((after - before))"
# Tells the workflow to save the cache only when something new was downloaded.
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "downloaded=$([ "$after" -gt "$before" ] && echo true || echo false)" >> "$GITHUB_OUTPUT"
fi
