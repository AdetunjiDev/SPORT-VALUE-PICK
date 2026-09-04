#!/usr/bin/env bash
# =====================================================================
# Netlify build for Sporty Value Pick AI.
#
# Prisma generates to packages/db/generated/client (stable under pnpm).
# We copy that into node_modules/.prisma/client so `import "@prisma/client"`
# works, and leave @prisma/client EXTERNAL in the esbuild bundle so it
# loads as real CJS on Lambda (bundling it into ESM breaks __dirname).
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
if [ -d node_modules ] && [ ! -d node_modules/@prisma/client ] && [ -d node_modules/.pnpm ]; then
  echo '  cached node_modules missing root @prisma/client - removing stale tree'
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
  exit 1
fi
if [ ! -f "$GENERATED/$RHEL_ENGINE" ]; then
  echo "BUILD ABORTED: missing $GENERATED/$RHEL_ENGINE."
  ls -la "$GENERATED" || true
  exit 1
fi
if grep -ql 'did not initialize yet' "$GENERATED"/*.js 2>/dev/null; then
  echo "BUILD ABORTED: generated client is still the uninitialized stub."
  exit 1
fi
echo "  ok  $GENERATED"

echo '--- installing generated client for @prisma/client resolution ---'
# @prisma/client does require('.prisma/client'). Copy via a temp dir so we
# never rm the source we are about to copy.
STAGE=$(mktemp -d)
cp -a "$GENERATED/." "$STAGE/"
rm -rf node_modules/.prisma/client
mkdir -p node_modules/.prisma
cp -a "$STAGE/." node_modules/.prisma/client
rm -rf "$STAGE"

test -f "node_modules/.prisma/client/schema.prisma"
test -f "node_modules/.prisma/client/$RHEL_ENGINE"
test -e "node_modules/@prisma/client" \
  || { echo "BUILD ABORTED: node_modules/@prisma/client missing (need node-linker=hoisted)."; exit 1; }
echo '  ok  node_modules/.prisma/client + @prisma/client'

echo '--- bundling Netlify functions ---'
rm -rf netlify/functions
mkdir -p netlify/functions

# CRITICAL: keep @prisma/client external. Inlining Prisma into an ESM bundle
# makes its CJS runtime reference __dirname and crash with:
#   ReferenceError: __dirname is not defined in ES module scope
npx --yes esbuild@0.24.2 \
  netlify/src/app.mts \
  netlify/src/crawl.mts \
  --bundle --platform=node --format=esm --target=node20 \
  --outdir=netlify/functions --out-extension:.js=.mjs \
  --external:@prisma/client \
  --external:.prisma \
  --external:node-tesseract-ocr \
  --banner:js="import{createRequire as __cr}from'module';import{fileURLToPath as __fu}from'url';import{dirname as __dn}from'path';const __filename=__fu(import.meta.url);const __dirname=__dn(__filename);const require=__cr(import.meta.url);"

for f in netlify/functions/app.mjs netlify/functions/crawl.mjs; do
  test -f "$f" || { echo "BUILD ABORTED: missing $f"; exit 1; }
done

if grep -q '@sportybet/' netlify/functions/app.mjs; then
  echo "BUILD ABORTED: a bare @sportybet import survived bundling."
  exit 1
fi
if grep -q 'packages/db/generated/client/runtime/library' netlify/functions/app.mjs; then
  echo "BUILD ABORTED: Prisma runtime was inlined into the ESM bundle (would crash on __dirname)."
  exit 1
fi
echo '  ok  netlify/functions/*.mjs (Prisma left external)'

echo '--- staging Prisma next to the functions ---'
mkdir -p netlify/functions/node_modules/.prisma netlify/functions/node_modules/@prisma
rm -rf netlify/functions/node_modules/.prisma/client netlify/functions/node_modules/@prisma/client
cp -a node_modules/.prisma/client netlify/functions/node_modules/.prisma/client
cp -a node_modules/@prisma/client netlify/functions/node_modules/@prisma/client

test -f "netlify/functions/node_modules/.prisma/client/schema.prisma"
test -f "netlify/functions/node_modules/.prisma/client/$RHEL_ENGINE"
test -d netlify/functions/node_modules/@prisma/client
echo '  ok  staged @prisma/client + .prisma/client'

mkdir -p public
echo 'ok' > public/index.html

echo '--- Netlify build complete ---'
