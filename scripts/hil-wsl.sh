#!/usr/bin/env bash
# WSL half of scripts/hil-matrix.js. Mirrors the Windows checkout into the WSL filesystem (its
# node_modules must hold Linux binaries) and runs the HIL smoke runner there under Xvfb.
#   hil-wsl.sh doctor  <source> <config> [profiles]
#   hil-wsl.sh prepare <source> <work>
#   hil-wsl.sh run     <source> <work> <config> <profile> [repeat]
set -euo pipefail

mode=${1:?mode}
source_dir=${2:?source directory}

# nvm installs are only on PATH for interactive shells.
if [ -s "$HOME/.nvm/nvm.sh" ]; then . "$HOME/.nvm/nvm.sh" >/dev/null; fi

require_linux_node() {
    local tool found
    for tool in node npm; do
        found=$(command -v "$tool" || true)
        case "$found" in
            "" | /mnt/*)
                echo "Install Linux Node.js 20+ inside WSL ($tool: ${found:-none}); Windows tools through interop cannot be used." >&2
                exit 2
                ;;
        esac
    done
}

check_work_dir() {
    case "$1" in
        "$HOME"/?*) ;;
        *)
            echo "WSL work directory must be below \$HOME: $1" >&2
            exit 2
            ;;
    esac
}

case "$mode" in
    doctor)
        config=${3:?config}
        profiles=${4:-}
        status=0
        for tool in node npm rsync xvfb-run lsusb; do
            if command -v "$tool" >/dev/null; then echo "ok   linux tool $tool: $(command -v "$tool")"; else
                echo "MISS linux tool $tool"
                status=1
            fi
        done
        require_linux_node
        node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' ||
            {
                echo "MISS linux node >= 20 (found $(node --version))"
                status=1
            }
        if ls /etc/udev/rules.d/ 2>/dev/null | grep -qi 'openocd\|jlink\|cmsis\|probe'; then
            echo "ok   udev rules present"
        else
            echo "WARN no probe udev rules in /etc/udev/rules.d; non-root OpenOCD may not open the probe"
        fi
        args=(--doctor --config "$config")
        if [ -n "$profiles" ]; then args+=(--profile "$profiles"); fi
        node "$source_dir/test/hil/run-smoke.js" "${args[@]}" || status=1
        exit "$status"
        ;;
    prepare)
        work_dir=${3:?work directory}
        check_work_dir "$work_dir"
        require_linux_node
        mkdir -p "$work_dir"
        # Excluded directories are not deleted at the destination, so Linux node_modules survive.
        rsync -a --delete \
            --exclude .git/ --exclude node_modules/ --exclude dist/ --exclude .vscode-test/ \
            --exclude test-results/ --exclude coverage/ \
            "$source_dir"/ "$work_dir"/
        cd "$work_dir"
        lock=$(sha256sum package-lock.json | cut -d' ' -f1)
        if [ "$(cat node_modules/.emberprobe-lock 2>/dev/null || true)" != "$lock" ]; then
            npm ci
            echo "$lock" >node_modules/.emberprobe-lock
        fi
        npm run bundle
        # WSL's NAT network can be far slower than Windows. A Linux VS Code archive downloaded on Windows
        # into .vscode-test/ seeds the test-electron cache instead of downloading it here.
        for archive in "$source_dir"/.vscode-test/vscode-linux-x64-*.tar.gz; do
            [ -f "$archive" ] || continue
            cache="$work_dir/.vscode-test/$(basename "$archive" .tar.gz)"
            [ -f "$cache/is-complete" ] && continue
            rm -rf "$cache"
            mkdir -p "$cache"
            tar -xzf "$archive" --strip-components=1 -C "$cache"
            : >"$cache/is-complete"
            echo "Seeded $(basename "$cache") from $archive"
        done
        ;;
    run)
        work_dir=${3:?work directory}
        config=${4:?config}
        profile=${5:?profile}
        repeat=${6:-1}
        check_work_dir "$work_dir"
        require_linux_node
        copy_back() {
            mkdir -p "$source_dir/test-results"
            cp -f "$work_dir/test-results/hil-smoke-linux-$profile.json" "$source_dir/test-results/" 2>/dev/null || true
            if [ -d "$work_dir/test-results/hil-logs/linux-$profile" ]; then
                mkdir -p "$source_dir/test-results/hil-logs"
                rm -rf "$source_dir/test-results/hil-logs/linux-$profile"
                cp -r "$work_dir/test-results/hil-logs/linux-$profile" "$source_dir/test-results/hil-logs/"
            fi
        }
        trap copy_back EXIT
        cd "$work_dir"
        EMBERPROBE_HIL_CONFIRM=YES xvfb-run -a node test/hil/run-smoke.js --config "$config" --profile "$profile" --repeat "$repeat"
        ;;
    *)
        echo "Unknown mode: $mode" >&2
        exit 2
        ;;
esac
