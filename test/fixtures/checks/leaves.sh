#!/bin/sh
# A check that exits 0 at once, leaving a child that holds its output open until
# "$1/release" exists.
dir=$1
sh -c 'echo $$ >>"$1/children"; while [ ! -f "$1/release" ]; do sleep 0.1; done' sh "$dir" &
echo $$ >>"$dir/starts"
