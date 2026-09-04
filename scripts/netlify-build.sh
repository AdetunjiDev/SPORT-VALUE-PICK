#!/usr/bin/env bash
# =====================================================================
# Netlify build for Sporty Value Pick AI.
#
# Produces:
#   netlify/functions/app.mjs
#   netlify/functions/crawl.mjs
#   netlify/functions/node_modules/@prisma/client/**
#   netlify/functions/node_modules/.prisma/client/**  (generated + rhel engine)
#
# node_bundler = "none" so Netlify does not re-bundle and replace our
# generated Prisma client with an uninitialized stub. telegram is bundled
# into the handlers so it cannot fail with ERR_MODULE_NOT_FOUND.
# =====================================================================
set -euo pipefail

run_pnpm() {
  if command -v pnpm >/dev/null 2>&1; then
    pnpm "$@"
  else
    npx --yes pnpm@10.33.2 "$@"
  fi
}

echo '--- node_modules layout guard ---'
if [ -d node_modules ] && [ ! -d node_modules/@prisma/client ]; then
  echo '  cached node_modules predates node-linker=hoisted (no @prisma/client at root) - removing it'
  rm -rf node_modules packages/*/node_modules services/*/node_modules
else
  echo '  layout ok or no cache present'
fi

run_pnpm install --frozen-lockfile --prod=false

echo '--- prisma generate ---'
run_pnpm --filter @sportybet/db generate

echo '--- locating a real generated Prisma client ---'
mapfile -t REAL_CLIENTS < <(
  find node_modules -type f -path '*/.prisma/client/schema.prisma' -print 2>/dev/null \
    | sed 's#/schema.prisma$##'
)

if [ "${#REAL_CLIENTS[@]}" -eq 0 ]; then
  echo "BUILD ABORTED: prisma generate did not produce node_modules/**/.prisma/client/schema.prisma."
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
  echo "BUILD ABORTED: no generated client contains libquery_engine-rhel-openssl-3.0.x.so.node."
  printf '  %s\n' "${REAL_CLIENTS[@]}"
  exit 1
fi
echo "  using: $CLIENT"

echo '--- installing generated client at the canonical root path ---'
rm -rf node_modules/.prisma/client
mkdir -p node_modules/.prisma
cp -a "$CLIENT" node_modules/.prisma/client

if grep -ql 'did not initialize yet' node_modules/.prisma/client/*.js 2>/dev/null; then
  echo "BUILD ABORTED: node_modules/.prisma/client is still the uninitialized stub."
  exit 1
fi
test -f node_modules/.prisma/client/schema.prisma
test -f node_modules/.prisma/client/libquery_engine-rhel-openssl-3.0.x.so.node
echo '  ok  node_modules/.prisma/client'

test -e "node_modules/@prisma/client" \
  || { echo "BUILD ABORTED: node_modules/@prisma/client missing (need node-linker=hoisted)."; exit 1; }

echo '--- bundling Netlify functions ---'
rm -rf netlify/functions
mkdir -p netlify/functions

# Workspace packages inlined; @prisma/client left external (native engine);
# telegram BUNDLED; node-tesseract-ocr optional and absent on Netlify.
npx --yes esbuild@0.24.2 \
  netlify/src/app.mts \
  netlify/src/crawl.mts \
  --bundle --platform=node --format=esm --target=node20 \
  --outdir=netlify/functions --out-extension:.js=.mjs \
  --external:@prisma/client --external:.prisma \
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

echo '--- staging Prisma next to the functions ---'
mkdir -p netlify/functions/node_modules/.prisma netlify/functions/node_modules/@prisma
rm -rf netlify/functions/node_modules/.prisma/client netlify/functions/node_modules/@prisma/client
cp -a node_modules/.prisma/client netlify/functions/node_modules/.prisma/client
cp -a node_modules/@prisma/client netlify/functions/node_modules/@prisma/client

if grep -ql 'did not initialize yet' netlify/functions/node_modules/.prisma/client/*.js 2>/dev/null; then
  echo "BUILD ABORTED: staged prisma client is still the uninitialized stub."
  exit 1
fi
test -f netlify/functions/node_modules/.prisma/client/schema.prisma
test -f netlify/functions/node_modules/.prisma/client/libquery_engine-rhel-openssl-3.0.x.so.node
echo '  ok  staged Prisma client + rhel engine'

mkdir -p public
echo 'ok' > public/index.html

echo '--- Netlify build complete ---'
