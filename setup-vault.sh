#!/usr/bin/env bash
# Initialize a D3R vault: scaffold the directory layout and link
# the canonical templates from core/. Idempotent.
#
# Usage: setup-vault.sh [<vault-path>]
# Default vault path: <repo-dir-root>/.agents/vault

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_dir_root="$(cd "$script_dir/.." && pwd)"
vault="${1:-$repo_dir_root/.agents/vault}"
workflow="$script_dir/core/workflow.yaml"
templates_src="$script_dir/core/templates"

if command -v yq >/dev/null 2>&1; then
    mapfile -t dirs < <(yq '.vault.dirs[]' "$workflow")
else
    echo "warn: yq not found; using built-in vault dirs list" >&2
    dirs=(designs tasks notes issues archive templates)
fi

mkdir -p "$vault"
for d in "${dirs[@]}"; do
    mkdir -p "$vault/$d"
    [ -e "$vault/$d/.gitkeep" ] || : > "$vault/$d/.gitkeep"
done

mkdir -p "$vault/templates"
linked=0
if [ -d "$templates_src" ]; then
    for tmpl in "$templates_src"/*.md; do
        [ -e "$tmpl" ] || continue
        ln -sfn "$tmpl" "$vault/templates/$(basename "$tmpl")"
        linked=$((linked + 1))
    done
fi

cat > "$vault/README.md" <<EOF
# D3R vault

Scaffolded by setup-vault.sh. Layout and template kinds are defined
in main/core/workflow.yaml (vault.dirs and vault.template_kinds).

Templates under templates/ are symlinks back into main/core/templates/.
Re-run setup-vault.sh after pulling workflow.yaml changes.
EOF

echo "vault ready at $vault (${#dirs[@]} dirs, $linked templates)"
