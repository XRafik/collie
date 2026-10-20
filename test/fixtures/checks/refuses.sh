#!/bin/sh
# held.sh, but its child outside the group ignores SIGTERM too.
dir=$1
echo $$ >>"$dir/starts"
trap '' TERM
setsid sh -c 'trap "" TERM; echo $$ >>"$1/children"; while [ ! -f "$1/release" ]; do sleep 0.1; done' \
  sh "$dir" >/dev/null 2>&1 &
while [ ! -f "$dir/release" ]; do sleep 0.1; done
