#!/usr/bin/env bash
# Install the compiled pi adapter into the user's pi config dir.
#
# Idempotent: re-running replaces existing symlinks in place. Does not
# touch settings.json or anything else outside the three managed dirs
# (agents, extensions, prompts).

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
dist_dir="$(cd "$script_dir/../.." && pwd)/dist/pi"
target_dir="${PI_AGENT_DIR:-$HOME/.pi/agent}"

if [ ! -d "$dist_dir" ]; then
    echo "error: $dist_dir not found. Run pnpm build first." >&2
    exit 1
fi

mkdir -p "$target_dir"/{agents,extensions,prompts}

linked=0
for sub in agents extensions prompts; do
    src_sub="$dist_dir/$sub"
    [ -d "$src_sub" ] || continue
    # iterate only the top-level entries so vendored extension dirs
    # are linked as a unit (preserves their internal structure).
    for entry in "$src_sub"/*; do
        [ -e "$entry" ] || continue
        name="$(basename "$entry")"
        ln -sfn "$entry" "$target_dir/$sub/$name"
        linked=$((linked + 1))
    done
done

echo "installed $linked entries into $target_dir"
echo "  agents:     $(ls -1 "$target_dir/agents" 2>/dev/null | wc -l)"
echo "  extensions: $(ls -1 "$target_dir/extensions" 2>/dev/null | wc -l)"
echo "  prompts:    $(ls -1 "$target_dir/prompts" 2>/dev/null | wc -l)"

# To uninstall: rm -rf ~/.pi/agent (or unset PI_AGENT_DIR target).
