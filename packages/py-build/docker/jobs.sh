#!/bin/sh
# Derived make width for the fork build: min(nproc, RAM / 1.5 GB), at least 1.
# A wasm clang invocation peaks well under 1.5 GB, so this keeps a full -j
# safely inside the box (earlyoom on the dev host kills at 8% free). Override
# per box via build.config.json `fork.jobs.make` (avlo-build fork passes it as
# JOBS_MAKE); the width never touches the output bytes.
n=$(nproc)
m=$(awk '/MemTotal/ { print int($2 / 1572864) }' /proc/meminfo)
[ "$m" -ge 1 ] || m=1
if [ "$n" -lt "$m" ]; then echo "$n"; else echo "$m"; fi
