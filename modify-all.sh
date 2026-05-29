#!/bin/bash
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
log_info()  { echo -e "${CYAN}[INFO]${NC}  $*"; }
log_ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }

echo ""
echo "============================================================================="
echo "  Renaming HomeCode → HomeCode"
echo "============================================================================="
echo ""

# ---------------------------------------------------------------
# Step 1: Rename directories
# ---------------------------------------------------------------
log_info "Step 1: Renaming directories"
[ -d ".homecode" ] && { mv ".homecode" ".homecode"; log_ok ".homecode/ → .homecode/"; }
[ -d "packages/homecode" ] && { mv "packages/homecode" "packages/homecode"; log_ok "packages/homecode/ → packages/homecode/"; }

# ---------------------------------------------------------------
# Step 2: Rename ALL files containing 'homecode' in their name
#   (catches preview-homecode-*.png, provider-homecode.test.ts, etc.)
# ---------------------------------------------------------------
log_info "Step 2: Renaming files"
find . \
    -not -path '*/node_modules/*' \
    -not -path '*/.git/*' \
    -not -path '*/dist/*' \
    -not -path '*/build/*' \
    -type f \
    \( -name '*homecode*' -o -name '*HomeCode*' \) \
    2>/dev/null | while read f; do
    new_f=$(echo "$f" | sed -E 's/homecode/homecode/g; s/HomeCode/HomeCode/g')
    if [ "$f" != "$new_f" ] && [ -f "$f" ]; then
        mv "$f" "$new_f"
        log_ok "$f → $new_f"
    fi
done

# ---------------------------------------------------------------
# Step 3: Update text content in source/config files
#   Excludes: lock files, binaries, images, archives
# ---------------------------------------------------------------
log_info "Step 3: Updating text content"
find . \
    -not -path '*/node_modules/*' \
    -not -path '*/.git/*' \
    -not -path '*/dist/*' \
    -not -path '*/build/*' \
    -not -name '*.lock' \
    -not -name '*.lockb' \
    -not -name '*.png' \
    -not -name '*.mp4' \
    -not -name '*.zip' \
    -not -name '*.db' \
    -not -name '*.sqlite' \
    -not -name '*.bin' \
    -type f \
    2>/dev/null | while read f; do
    if grep -q 'homecode\|HomeCode' "$f" 2>/dev/null; then
        if ! diff <(cat "$f") <(sed -E 's/\bHomeCode\b/HomeCode/g; s/\bhomecode\b/homecode/g' "$f") > /dev/null 2>&1; then
            sed -i -E 's/\bHomeCode\b/HomeCode/g; s/\bhomecode\b/homecode/g' "$f"
            log_ok "Updated: $f"
        fi
    fi
done

# ---------------------------------------------------------------
# Step 4: Clean lock files & node_modules, fresh install
# ---------------------------------------------------------------
log_info "Step 4: Cleaning and reinstalling"
rm -rf node_modules packages/*/node_modules
rm -f bun.lock bun.lockb
log_ok "Removed node_modules/ and lock files"

log_info "Step 5: bun install"
bun install
log_ok "Install complete!"

echo ""
echo "============================================================================="
echo "  DONE! Commit with:"
echo "    git add -A"
echo "    git commit -m 'Rename HomeCode to HomeCode'"
echo "============================================================================="
echo ""
log_warn "Manual checks needed:"
echo "  • SVG files: if they have 'HomeCode' as visual text, edit in vector editor"
echo "  • .env files: check for OPENQCODE_* env vars"
echo "  • External URLs: any API endpoints referencing homecode.io?"
echo "  • GitHub Actions: .github/workflows/homecode.yml was updated"
