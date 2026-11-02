#!/bin/sh
# start N CPU burners for the loaded-machine runs; prints their pids; stop with: kill $(cat pids)
N=${1:-16}
for i in $(seq $N); do node -e 'for(;;);' & echo $! >> "$2"; done
