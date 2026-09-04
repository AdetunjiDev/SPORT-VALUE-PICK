#!/usr/bin/env bash
# =====================================================================
# Netlify build for Sporty Value Pick AI.
#
# Prisma generates to packages/db/generated/client (see schema.prisma
# `output`), which is stable under pnpm. We then stage that client next to
# the bundled functions as node_modules/.prisma/client so runtime resolution
# and PRISMA_QUERY_ENGINE_LIBRARY both work.
# =====================================================================
set -euo pipefail

GENERATED="packages/db/generated/client"
RHEL_ENGINE="libquery_engine-rhel-openssl-3.0.x.so.node"

run_pnpm() {
  if command -v pnpm >/dev/null 2>&1; then
    pnpm "$@"
  else
    npx --yes pnpm@10.33.2 "$@"
  fi
}

echo '--- node_modules layout guard ---'
if [ -d node_modules ] && [ ! -e node_modules/.prisma ] && [ ! -d node_modules/@prisma/client ] \
   && [ -d node_modules/.pnpm ]; then
  echo '  cached node_modules looks like a stale pnpm layout - removing it'
  rm -rf node_modules packages/*/node_modules services/*/node_modules
else
  echo '  layout ok or no cache present'
fi

run_pnpm install --frozen-lockfile --prod=false

echo '--- prisma generate ---'
run_pnpm --filter @sportybet/db generate

echo '--- verifying generated client ---'
if [ ! -f "$GENERATED/schema.prisma" ]; then
  echo "BUILD ABORTED: missing $GENERATED/schema.prisma after prisma generate."
  echo "Check generator.output in packages/db/prisma/schema.prisma."
  exit 1
fi
if [ ! -f "$GENERATED/$RHEL_ENGINE" ]; then
  echo "BUILD ABORTED: missing $GENERATED/$RHEL_ENGINE."
  echo "Check binaryTargets includes rhel-openssl-3.0.x."
  ls -la "$GENERATED" || true
  exit 1
fi
if grep -ql 'did not initialize yet' "$GENERATED"/*.js 2>/dev/null; then
  echo "BUILD ABORTED: generated client is still the uninitialized stub."
  exit 1
fi
echo "  ok  $GENERATED (schema + rhel engine)"

echo '--- bundling Netlify functions ---'
rm -rf netlify/functions
mkdir -p netlify/functions

# Workspace packages (including packages/db/generated) are inlined.
# Native .node engines stay as files beside the function; tesseract is optional.
npx --yes esbuild@0.24.2 \
  netlify/src/app.mts \
  netlify/src/crawl.mts \
  --bundle --platform=node --format=esm --target=node20 \
  --outdir=netlify/functions --out-extension:.js=.mjs \
  --external:*.node \
  --external:node-tesseract-ocr \
  --banner:js="import{createRequire as __cr}from'module';const require=__cr(import.meta.url);"

for f in netlify/functions/app.mjs netlify/functions/crawl.mjs; do
  test -f "$f" || { echo "BUILD ABORTED: missing $f"; exit 1; }
done

if grep -q '@sportybet/' netlify/functions/app.mjs; then
  echo "BUILD ABORTED: a bare @sportybet import survived bundling."
  exit 1
fi
echo '  ok  netlify/functions/*.mjs'

echo '--- staging Prisma client + engine next to the functions ---'
# Node resolves .prisma from the function directory; preparePrismaEnv also
# points PRISMA_QUERY_ENGINE_LIBRARY at this engine file.
mkdir -p netlify/functions/node_modules/.prisma
rm -rf netlify/functions/node_modules/.prisma/client
cp -a "$GENERATED" netlify/functions/node_modules/.prisma/client

# Also drop the engine next to the .mjs in case a bundled require looks here.
cp -f "$GENERATED/$RHEL_ENGINE" "netlify/functions/$RHEL_ENGINE"

if grep -ql 'did not initialize yet' netlify/functions/node_modules/.prisma/client/*.js 2>/dev/null; then
  echo "BUILD ABORTED: staged prisma client is still the uninitialized stub."
  exit 1
fi
test -f netlify/functions/node_modules/.prisma/client/schema.prisma
test -f "netlify/functions/node_modules/.prisma/client/$RHEL_ENGINE"
echo '  ok  staged Prisma client + rhel engine'

mkdir -p public
echo 'ok' > public/index.html

echo '--- Netlify build complete ---'
