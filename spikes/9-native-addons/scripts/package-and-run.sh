#!/bin/sh
# usage: package-and-run.sh <label>   (run from apps/demo; env passes through, e.g. SPIKE_STRIP_BUILD=1)
# The packaged app is copied OUTSIDE the repository before it runs, so Node's upward node_modules lookup
# cannot find the workspace's node_modules by accident (that would be a false pass).
set -u
L=$1
E=$(pwd)/../../evidence
RUNDIR=${SPIKE_RUNDIR:-/private/tmp/claude-501/-Users-cal-Projects-lab-app-foundation/e951459b-74fd-4455-94f3-00debf481d2a/scratchpad/run}/$L
rm -rf out
node ../../scripts/run-with-timeout.mjs 400 "$E/package-$L.log" pnpm package
echo "package exit=$?"
rm -rf "${RUNDIR:?}"
mkdir -p "$RUNDIR"
ditto out/SpikeDemo-darwin-arm64/SpikeDemo.app "$RUNDIR/SpikeDemo.app"
APP="$RUNDIR/SpikeDemo.app"
rm -f "$E/packaged-$L-report.json"
SPIKE_REPORT="$E/packaged-$L-report.json" SPIKE_QUIT=1 node ../../scripts/run-with-timeout.mjs 40 "$E/packaged-$L.log" "$APP/Contents/MacOS/SpikeDemo"
echo "run exit=$?"
pnpm exec asar list "$APP/Contents/Resources/app.asar" > "$E/asar-list-$L.txt"
node -e 'const r=require(process.argv[1]);console.log(JSON.stringify({packaged:r.packaged,ok:Object.fromEntries(Object.entries(r.addons).map(([k,v])=>[k,v.ok||v.error.split("\n").slice(0,2).join(" | ")])),loaded:r.loadedNativeFiles},null,1))' "$E/packaged-$L-report.json"
