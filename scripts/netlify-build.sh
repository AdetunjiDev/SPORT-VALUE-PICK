#!/usr/bin/env bash
# =====================================================================
# Netlify build for Sporty Value Pick AI.
#
# Why this is a script (not an inline netlify.toml command):
#   The Prisma client must be generated AND the exact files that Node will
#   resolve at runtime must be the generated ones, not the uninitialized
#   stub @prisma/client ships before `prisma generate`. A previous build
#   asserted "rhel engine exists somewhere under node_modules", which also
#   matched engines bundled inside the `prisma` CLI package — so the build
#   went green while the function still shipped the stub and crashed with:
#
#     @prisma/client did not initialize yet. Please run "prisma generate"
#
# This script generates, verifies the CLIENT directory (not the CLI),
# stages that client next to the bundled functions (so resolution from
# /var/task/netlify/functions/app.mjs hits a known-good copy first), then
# esbuilds the two function entrypoints.
# =====================================================================
set -euo pipefail

echo '--- node_modules layout guard ---'
if [ -d node_modules ] && [ ! -d node_modules/@prisma/client ]; then
  echo '  cached node_modules predates node-linker=hoisted (no @prisma/client at root) - removing it'
  rm -rf node_modules packages/*/node_modules services/*/node_modules
else
  echo '  layout ok or no cache present'
fi

# Keep devDependencies even when Netlify sets NODE_ENV=production — we need
# the prisma CLI to generate, and pruning reshapes the tree so generate can
# write to a .pnpm inner path while a stub remains at the root.
pnpm install --frozen-lockfile --prod=false

echo '--- prisma generate ---'
pnpm --filter @sportybet/db generate

echo '--- locating a real generated Prisma client ---'
# A real client always has schema.prisma. The uninitialized stub does not.
mapfile -t REAL_CLIENTS < <(
  find node_modules -type f -path '*/.prisma/client/schema.prisma' -print 2>/dev/null \
    | sed 's#/schema.prisma$##'
)

if [ "${#REAL_CLIENTS[@]}" -eq 0 ]; then
  echo "BUILD ABORTED: prisma generate did not produce node_modules/**/.prisma/client/schema.prisma."
  echo "Without that file the function would crash at runtime with '@prisma/client did not initialize yet'."
  exit 1
fi

CLIENT=""
for d in "${REAL_CLIENTS[@]}"; do
  if ls "$d"/libquery_engine-rhel-openssl-3.0.x.so.node >/dev/null 2>&1; then
    CLIENT="$d"
    break
  fi
done

if [ -z "$CLIENT" ]; then
  echo "BUILD ABORTED: found generated client(s) but none contain libquery_engine-rhel-openssl-3.0.x.so.node."
  echo "Netlify runs on Amazon Linux; without that engine every query fails on cold start."
  echo "Checked:"
  printf '  %s\n' "${REAL_CLIENTS[@]}"
  echo "Check binaryTargets in packages/db/prisma/schema.prisma."
  exit 1
fi

echo "  using: $CLIENT"

echo '--- installing generated client at the canonical root path ---'
# Node (and Netlify's external packaging) resolve .prisma from the repo-root
# node_modules first. If generate wrote only under .pnpm/..., a stub can still
# sit at node_modules/.prisma/client and win at runtime. Force the real one.
rm -rf node_modules/.prisma/client
mkdir -p node_modules/.prisma
cp -a "$CLIENT" node_modules/.prisma/client

if grep -ql 'did not initialize yet' node_modules/.prisma/client/*.js 2>/dev/null; then
  echo "BUILD ABORTED: node_modules/.prisma/client is still the uninitialized stub."
  exit 1
fi
test -f node_modules/.prisma/client/schema.prisma
test -f node_modules/.prisma/client/libquery_engine-rhel-openssl-3.0.x.so.node
echo '  ok  node_modules/.prisma/client (schema + rhel engine, not a stub)'

echo '--- verifying externals are visible at the repo root ---'
for p in @prisma/client telegram; do
  test -e "node_modules/$p" \
    || { echo "BUILD ABORTED: node_modules/$p is missing. Check that .npmrc still sets node-linker=hoisted."; exit 1; }
  echo "  ok  node_modules/$p"
done

echo '--- bundling Netlify functions ---'
mkdir -p netlify/functions
npx --yes esbuild@0.24.2 netlify/src/app.mts netlify/src/crawl.mts \
  --bundle --platform=node --format=esm --target=node20 \
  --outdir=netlify/functions --out-extension:.js=.mjs \
  --external:@prisma/client --external:.prisma \
  --external:telegram --external:node-tesseract-ocr \
  --banner:js="import{createRequire as __cr}from'module';const require=__cr(import.meta.url);"

if grep -q '@sportybet/' netlify/functions/app.mjs; then
  echo "BUILD ABORTED: a bare @sportybet import survived bundling; it will not resolve at runtime."
  exit 1
fi
echo '  ok  netlify/functions/*.mjs'

echo '--- staging Prisma next to the functions ---'
# From /var/task/netlify/functions/app.mjs Node resolves
#   ./node_modules/@prisma/client  before walking up to /var/task/node_modules.
# Staging here means even if Netlify's external_node_modules copy of
# @prisma/client somehow recreates a stub at the task root, the function-local
# copy wins. included_files in netlify.toml ships this tree into the zip.
mkdir -p netlify/functions/node_modules/.prisma
rm -rf netlify/functions/node_modules/.prisma/client
cp -a node_modules/.prisma/client netlify/functions/node_modules/.prisma/client

mkdir -p netlify/functions/node_modules/@prisma
rm -rf netlify/functions/node_modules/@prisma/client
cp -a node_modules/@prisma/client netlify/functions/node_modules/@prisma/client

if grep -ql 'did not initialize yet' netlify/functions/node_modules/.prisma/client/*.js 2>/dev/null; then
  echo "BUILD ABORTED: staged prisma client is still the uninitialized stub."
  exit 1
fi
test -f netlify/functions/node_modules/.prisma/client/schema.prisma
test -f netlify/functions/node_modules/.prisma/client/libquery_engine-rhel-openssl-3.0.x.so.node
echo '  ok  netlify/functions/node_modules/.prisma/client'
echo '  ok  netlify/functions/node_modules/@prisma/client'

mkdir -p public
echo 'ok' > public/index.html

echo '--- Netlify build complete ---'
