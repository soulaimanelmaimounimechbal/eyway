#!/usr/bin/env bash
# Azure App Service local-Git (Kudu) deployment for this pnpm monorepo.
#
# Kudu invokes this via .deployment. It replicates the GitHub Actions pipeline
# (.github/workflows/main_ey-way.yml): build the backend + frontend with pnpm and
# assemble ONE self-contained package (bundled server + non-symlinked node_modules
# for externalized @azure/* deps + the built frontend under public/) into wwwroot.
#
# Why NOT the naive `cp -R dist/*`: the api-server is an esbuild bundle that keeps
# @azure/* external, so the runtime needs a real (hoisted, non-symlink) node_modules.
set -euo pipefail

# Kudu provides these; default them so the script is runnable/testable locally.
: "${DEPLOYMENT_SOURCE:=$(pwd)}"
: "${DEPLOYMENT_TARGET:=$DEPLOYMENT_SOURCE/wwwroot}"

PNPM_VERSION="10.26.1"
PKG_DIR="$DEPLOYMENT_SOURCE/.deploy_pkg"

echo "==> Custom pnpm deployment starting"
cd "$DEPLOYMENT_SOURCE"
echo "    DEPLOYMENT_SOURCE=$DEPLOYMENT_SOURCE"
echo "    DEPLOYMENT_TARGET=$DEPLOYMENT_TARGET"
echo "    node: $(node -v)"

# --- Make pnpm available -------------------------------------------------------
# On Azure's Oryx build image the Node dir is read-only, so `corepack enable`
# (which writes PATH shims) fails and a bare `pnpm` is NOT on PATH. Instead we
# call pnpm THROUGH corepack (`corepack pnpm ...`), which resolves the pinned
# packageManager version without needing a shim on PATH. Fall back to a global
# npm install only if corepack is unavailable.
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
PNPM=""
if corepack --version >/dev/null 2>&1; then
  echo "==> Preparing pnpm@$PNPM_VERSION via corepack"
  corepack prepare "pnpm@$PNPM_VERSION" --activate || true
  if corepack pnpm --version >/dev/null 2>&1; then
    PNPM="corepack pnpm"
  fi
fi
if [ -z "$PNPM" ]; then
  echo "==> Falling back to global npm install of pnpm@$PNPM_VERSION"
  # Global install does NOT run the workspace preinstall guard, so npm is fine here.
  npm install -g "pnpm@$PNPM_VERSION"
  PNPM="pnpm"
fi
echo "    pnpm: $($PNPM --version)"

# --- Install (full, incl. dev deps needed to build) ----------------------------
echo "==> Installing dependencies (frozen lockfile)"
$PNPM install --frozen-lockfile

# --- Build backend + frontend --------------------------------------------------
echo "==> Building backend (API + voice proxy)"
$PNPM --filter @workspace/api-server run build

echo "==> Building frontend (training UI)"
# vite.config.ts THROWS if BASE_PATH or PORT are unset, even for `build`.
BASE_PATH="/" PORT="8080" $PNPM --filter @workspace/training run build

# --- Assemble the self-contained package ---------------------------------------
# --legacy: pnpm v10 refuses non-injected workspace deploys otherwise.
# --node-linker=hoisted: default symlinked layout does not survive Azure's file
# copy, so externalized @azure/* deps would fail at runtime (ERR_MODULE_NOT_FOUND).
echo "==> Assembling self-contained package"
rm -rf "$PKG_DIR"
$PNPM --filter @workspace/api-server --prod --legacy --node-linker=hoisted deploy "$PKG_DIR"

echo "==> Co-locating built frontend as public/"
rm -rf "$PKG_DIR/public"
cp -R "$DEPLOYMENT_SOURCE/artifacts/training/dist/public" "$PKG_DIR/public"

# --- Publish into wwwroot ------------------------------------------------------
echo "==> Publishing to $DEPLOYMENT_TARGET"
# Safety guard before the destructive cleanup: never wipe an empty/root/relative
# path (a mis-set DEPLOYMENT_TARGET must fail loudly, not delete the wrong tree).
case "$DEPLOYMENT_TARGET" in
  "" | "/" ) echo "FATAL: refusing to publish to unsafe target '$DEPLOYMENT_TARGET'" >&2; exit 1 ;;
  /* ) : ;;  # ok: absolute path
  * ) echo "FATAL: DEPLOYMENT_TARGET must be an absolute path, got '$DEPLOYMENT_TARGET'" >&2; exit 1 ;;
esac
mkdir -p "$DEPLOYMENT_TARGET"
# Clear old contents (incl. dotfiles) without deleting the directory itself.
find "$DEPLOYMENT_TARGET" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
# Copy contents (the trailing /. includes dotfiles).
cp -R "$PKG_DIR/." "$DEPLOYMENT_TARGET/"

rm -rf "$PKG_DIR"
echo "==> Deployment complete"
echo "    Ensure the App Service startup command is: NODE_ENV=production node dist/index.mjs"
