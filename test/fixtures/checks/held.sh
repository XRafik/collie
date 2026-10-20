#!/bin/sh
# A check that ignores SIGTERM and has a child outside its process group. It notes in
# "$1/overlaps" any earlier start still running, and exits 0 once "$1/release" exists.
dir=$1
for earlier in $(cat "$dir/starts" "$dir/children" 2>/dev/null); do
  kill -0 "$earlier" 2>/dev/null && echo "$$ beside $earlier" >>"$dir/overlaps"
done
echo $$ >>"$dir/starts"
trap '' TERM
setsid sh -c 'echo $$ >>"$1/children"; while [ ! -f "$1/release" ]; do sleep 0.1; done' \
  sh "$dir" >/dev/null 2>&1 &
while [ ! -f "$dir/release" ]; do sleep 0.1; done
