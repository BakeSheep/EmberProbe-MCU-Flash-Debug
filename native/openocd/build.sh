#!/usr/bin/env bash
# Produce reviewed build inputs without modifying resources/ or installed runtimes.
set -euo pipefail
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
cache=$(realpath -m -- "${EMBERPROBE_OPENOCD_BUILD_DIR:-$HOME/.cache/emberprobe-openocd-release}")
output="$repo/test-results/openocd-scatter-release"
image=$(node -p "require(process.argv[1]).image" "$repo/native/openocd/build-lock.json")
[[ $cache =~ ^[a-zA-Z0-9_./-]+$ ]] || { echo 'Cache must not contain spaces or shell metacharacters' >&2; exit 1; }
case "$cache/" in "$repo/"*) echo 'Build cache must be outside repository' >&2; exit 1;; esac
mkdir -p "$cache" "$output"
if [[ ${1:-} != --inside ]]; then
    exec docker run --rm --platform linux/amd64 \
        --env EMBERPROBE_XBB_IMAGE="$image" --env EMBERPROBE_OPENOCD_BUILD_DIR="$cache" \
        --volume "$repo:$repo" --volume "$cache:$cache" --workdir "$repo" \
        "$image" bash native/openocd/build.sh --inside
fi
[[ ${EMBERPROBE_XBB_IMAGE:-} == "$image" && $(uname -sm) == 'Linux x86_64' ]] || { echo 'Use the locked XBB image' >&2; exit 1; }
grep -qx 'VERSION_ID="10"' /etc/os-release || { echo 'Debian 10 build baseline required' >&2; exit 1; }
exec 9>"$cache/build.lock"
flock 9
key=$(cat "$repo/native/openocd/build-lock.json" "$repo/native/openocd/build.sh" "$repo/native/openocd/prepare-build.js" "$repo"/native/openocd/0*.patch | sha256sum | cut -c1-20)
work="$cache/work-$key"
export npm_config_cache="$cache/npm-cache" XPACKS_STORE_FOLDER="$cache/xpacks-store" XPACKS_CACHE_FOLDER="$cache/xpacks-cache"
export XDG_CACHE_HOME="$cache/xdg-cache" XDG_CONFIG_HOME="$cache/xdg-config" WINEPREFIX="$cache/wine" TMPDIR="$cache/tmp"
export XBB_DOWNLOAD_FOLDER_PATH="$cache/downloads" WORK_FOLDER_PATH="$work/work" XBB_RELEASE_VERSION=0.12.0-7
mkdir -p "$work" "$TMPDIR" "$XBB_DOWNLOAD_FOLDER_PATH"
npm install --prefix "$cache/xpm-0.20.5" --no-audit --no-fund xpm@0.20.5
xpm="$cache/xpm-0.20.5/node_modules/.bin/xpm"
xpack="$work/openocd-xpack"
if [[ ! -d "$xpack/.git" ]]; then
    git clone --branch v0.12.0-7 --depth 1 https://github.com/xpack-dev-tools/openocd-xpack.git "$xpack"
fi
assets="$xpack/build-assets"
cd "$assets"
npm ci --no-audit --no-fund
"$xpm" install
for platform in win32-x64 linux-x64; do
    "$xpm" install --config "$platform"
done
mkdir -p patches
cp "$repo/native/openocd/0001-emberprobe-read-scatter.patch" patches/emberprobe-scatter.git.patch
cp "$repo/native/openocd/0002-stldr-flash-driver.patch" patches/emberprobe-stldr.git.patch
cp "$repo/native/openocd/0003-stm32c5x-target.patch" patches/emberprobe-stm32c5x.git.patch
cp "$repo/native/openocd/0004-emberprobe-c5-local-loaders.patch" patches/emberprobe-c5-loaders.git.patch
node "$repo/native/openocd/prepare-build.js" prepare "$assets" "$cache"
for platform in win32-x64 linux-x64; do
    "$xpm" run build --config "$platform"
done
node -e 'const l=require(process.argv[1]);for(const [n,d] of Object.entries(l.downloads))if(d.url)console.log(d.sha256+" "+n+" "+d.url)' "$repo/native/openocd/build-lock.json" |
while read -r digest name url; do
    if [[ ! -f "$XBB_DOWNLOAD_FOLDER_PATH/$name" ]]; then
        curl --fail --location --retry 3 "$url" --output "$XBB_DOWNLOAD_FOLDER_PATH/$name"
    fi
    echo "$digest  $XBB_DOWNLOAD_FOLDER_PATH/$name" | sha256sum --check
done
node "$repo/native/openocd/prepare-build.js" finish "$assets" "$cache" "$output"
echo "Build inputs ready: $output"
