#!/usr/bin/env bash
# Prototype only. No release inputs or installed system packages are changed.
set -euo pipefail

repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
patch_file="$repo/native/openocd/0001-emberprobe-read-scatter.patch"
cache=$(realpath -m -- "${EMBERPROBE_OPENOCD_BUILD_DIR:-$HOME/.cache/emberprobe-openocd}")
output="$repo/test-results/openocd-scatter"
case "$cache/" in "$repo/"*) echo "Build cache must be outside the repository" >&2; exit 1;; esac
[[ $cache =~ ^[a-zA-Z0-9_./-]+$ ]] || { echo 'xPack cache path must not contain spaces or shell metacharacters' >&2; exit 1; }
[[ $(uname -sm) == 'Linux x86_64' ]] || { echo 'Run inside x86_64 WSL Ubuntu' >&2; exit 1; }
for tool in git node npm make gcc autoconf automake pkg-config patch sha256sum apt-get dpkg-deb flock; do
    command -v "$tool" >/dev/null || { echo "Missing prerequisite: $tool" >&2; exit 1; }
done
[[ $(realpath -m "$output") == "$output" ]] || { echo 'Output path must not traverse symlinks' >&2; exit 1; }
mkdir -p "$cache" "$output"
exec 9>"$cache/build.lock"
flock 9
patch_sha=$(sha256sum "$patch_file" | cut -d ' ' -f 1)
script_sha=$(sha256sum "${BASH_SOURCE[0]}" | cut -d ' ' -f 1)
# Keyed by the patch only, so script fixes reuse finished builds.
work="$cache/work-${patch_sha:0:16}"
export npm_config_cache="$cache/npm-cache"
export XPACKS_STORE_FOLDER="$cache/xpacks-store"
export XPACKS_CACHE_FOLDER="$cache/xpacks-cache"
export XDG_CACHE_HOME="$cache/xdg-cache"
export XDG_CONFIG_HOME="$cache/xdg-config"
export WINEPREFIX="$cache/wine"
export TMPDIR="$cache/tmp"
export XBB_DOWNLOAD_FOLDER_PATH="$cache/downloads"
export WORK_FOLDER_PATH="$work/work"
export XBB_RELEASE_VERSION=0.12.0-7
mkdir -p "$work" "$TMPDIR" "$XBB_DOWNLOAD_FOLDER_PATH"
npm install --prefix "$cache/xpm-0.20.5" --no-audit --no-fund xpm@0.20.5
xpm="$cache/xpm-0.20.5/node_modules/.bin/xpm"
xpack="$work/openocd-xpack"
if [[ ! -d "$xpack/.git" ]]; then
    git clone --branch v0.12.0-7 --depth 1 https://github.com/xpack-dev-tools/openocd-xpack.git "$xpack"
fi
[[ $(git -C "$xpack" rev-parse HEAD) == 10eb7ea34d422bc3405d1b322952ef4a68c84cc4 ]]
assets="$xpack/build-assets"
mkdir -p "$assets/patches"
cp "$patch_file" "$assets/patches/emberprobe-scatter.git.patch"

# Ubuntu development files without apt install/sudo. Keep the selected package
# versions and hashes with the build; these follow this Ubuntu's apt sources.
sdk="$cache/ubuntu-udev"
if [[ ! -f "$sdk/ready" ]]; then
    mkdir -p "$sdk/debs" "$sdk/root"
    (cd "$sdk/debs"; apt-get download libudev-dev libudev1)
    for deb in "$sdk/debs/"*.deb; do dpkg-deb -x "$deb" "$sdk/root"; done
    sed -i -e "s|^prefix=.*|prefix=$sdk/root/usr|" \
        -e 's|^libdir=.*|libdir=${prefix}/lib/x86_64-linux-gnu|' \
        -e 's|^includedir=.*|includedir=${prefix}/include|' \
        "$sdk/root/usr/lib/x86_64-linux-gnu/pkgconfig/libudev.pc"
    touch "$sdk/ready"
fi

cd "$assets"
npm ci --no-audit --no-fund
"$xpm" install

# Changes below are confined to the cached xPack checkout/store. The upstream
# OpenOCD downloader has no patch hook; insert one immediately after download,
# before bootstrap. The helper's conventional patch directory is build-assets/patches.
node - "$assets" "$sdk" <<'NODE'
const fs = require('fs');
const path = require('path');
const [assets, sdk] = process.argv.slice(2);
const pkg = path.join(assets, 'package.json');
const data = JSON.parse(fs.readFileSync(pkg, 'utf8'));
if (!data.xpack.properties.commandBashBuild.includes('--disable-tests'))
    data.xpack.properties.commandBashBuild += ' --disable-tests';
fs.writeFileSync(pkg, JSON.stringify(data, null, 2) + '\n');
const recipe = path.join(assets, 'scripts/dependencies/openocd.sh');
let text = fs.readFileSync(recipe, 'utf8').replace(/\r\n/g, '\n');
if (!text.includes('# EmberProbe scatter hook')) {
    const anchor = '      openocd_download\n';
    if (!text.includes(anchor)) throw new Error('xPack download hook changed');
    text = text.replace(anchor, anchor + `
      # EmberProbe scatter hook
      if ! grep -q 'int mem_ap_read_scatter(' "\${XBB_SOURCES_FOLDER_PATH}/\${openocd_src_folder_name}/src/target/arm_adi_v5.c"; then
        (cd "\${XBB_SOURCES_FOLDER_PATH}/\${openocd_src_folder_name}";
          test "$(git rev-parse HEAD)" = e5888bda38f4952e2ae92f7dc5b25fc9a2d1c2b3
          git apply --check "\${XBB_BUILD_ROOT_PATH}/patches/emberprobe-scatter.git.patch"
          patch -p1 < "\${XBB_BUILD_ROOT_PATH}/patches/emberprobe-scatter.git.patch")
      fi
`);
    fs.writeFileSync(recipe, text);
}
// The xPack self-test runs openocd.exe through Wine; binaries are checked on their own host instead.
const selfTest = '  tests_add "openocd_test" "${XBB_EXECUTABLES_INSTALL_FOLDER_PATH}/bin"\n';
if (text.includes(selfTest))
    fs.writeFileSync(recipe, text.replace(selfTest, '  # EmberProbe: binaries are checked on their own host after the build.\n'));
const helper = path.join(assets, 'xpacks/@xpack-dev-tools/xbb-helper/build-scripts');
const common = path.join(helper, 'build-common.sh');
fs.chmodSync(common, 0o644);
fs.writeFileSync(common, fs.readFileSync(common, 'utf8').replace(/\r\n/g, '\n').replace(
    '  tests_prime_wine\n', '  # EmberProbe: no Wine priming in this build-only prototype.\n'));
const misc = path.join(helper, 'miscellaneous.sh');
fs.chmodSync(misc, 0o644);
text = fs.readFileSync(misc, 'utf8').replace(/\r\n/g, '\n');
if (!text.includes('# EmberProbe user-local udev')) {
    text += `
# EmberProbe user-local udev (override the host /usr copy helper).
function copy_libudev() {
  mkdir -p "\${XBB_LIBRARIES_INSTALL_FOLDER_PATH}/include" "\${XBB_LIBRARIES_INSTALL_FOLDER_PATH}/lib/pkgconfig"
  cp "${sdk}/root/usr/include/libudev.h" "\${XBB_LIBRARIES_INSTALL_FOLDER_PATH}/include/"
  cp -L "${sdk}/root/usr/lib/x86_64-linux-gnu/libudev.so.1" "\${XBB_LIBRARIES_INSTALL_FOLDER_PATH}/lib/"
  ln -sf libudev.so.1 "\${XBB_LIBRARIES_INSTALL_FOLDER_PATH}/lib/libudev.so"
  sed -e "s|^prefix=.*|prefix=\${XBB_LIBRARIES_INSTALL_FOLDER_PATH}|" -e 's|^libdir=.*|libdir=\${prefix}/lib|' "${sdk}/root/usr/lib/x86_64-linux-gnu/pkgconfig/libudev.pc" > "\${XBB_LIBRARIES_INSTALL_FOLDER_PATH}/lib/pkgconfig/libudev.pc"
}
`;
    fs.writeFileSync(misc, text);
}
NODE

# Primary Windows cross build first. xpm injects each configuration's pinned GCC,
# MinGW, autotools helpers, CMake and Ninja into PATH; no Docker action is invoked.
for platform in win32-x64 linux-x64; do
    "$xpm" install --config "$platform"
    if [[ $platform == linux-x64 ]]; then
        export PKG_CONFIG_PATH="$sdk/root/usr/lib/x86_64-linux-gnu/pkgconfig"
        # libusb's configure probes libudev.h with plain compiler checks, not pkg-config.
        export CPATH="$sdk/root/usr/include"
        export LIBRARY_PATH="$sdk/root/usr/lib/x86_64-linux-gnu"
    else
        export PKG_CONFIG_PATH=''
        unset CPATH LIBRARY_PATH
    fi
    "$xpm" run build --config "$platform"
    application="$assets/build/$platform/application"
    exe=openocd
    [[ $platform != win32-x64 ]] || exe=openocd.exe
    test -f "$application/bin/$exe"
    test -d "$application/openocd/scripts"
    # Replace only this script's designated output tree, after a successful build.
    [[ $(realpath -m "$output/$platform") == "$output/$platform" ]] || { echo 'Output platform must not be a symlink' >&2; exit 1; }
    mkdir -p "$output/$platform"
    find "$output/$platform" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
    cp -a "$application/." "$output/$platform/"
    sources=$(find "$assets/build/$platform/sources" -maxdepth 1 -type d -name "openocd*" | head -1)
    {
        printf 'Prototype xPack OpenOCD 0.12.0-7 + EmberProbe scatter\nPlatform: %s\n' "$platform"
        printf 'xPack source: https://github.com/xpack-dev-tools/openocd-xpack\nxPack revision: %s\n' "$(git -C "$xpack" rev-parse HEAD)"
        printf 'OpenOCD source: https://github.com/openocd-org/openocd\nOpenOCD revision: %s\n' "$(git -C "$sources" rev-parse HEAD)"
        printf 'Patch SHA256: %s\nBuild script SHA256: %s\nBuilt UTC: %s\n' "$patch_sha" "$script_sha" "$(date -u +%FT%TZ)"
        printf 'Route: native xpm build --config %s; no Docker; tests/Wine priming disabled\n' "$platform"
        printf 'Host: %s\n' "$(uname -a)"
        git -C "$sources" submodule status --recursive
        sha256sum "$sdk/debs/"*.deb
        cat "$assets/package.json"
    } > "$output/$platform/BUILD-INFO.txt"
done
