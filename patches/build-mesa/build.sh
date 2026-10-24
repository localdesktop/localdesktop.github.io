#!/bin/bash
# Build the guest's private Mesa into assets/guest-mesa.tar.xz (see Dockerfile).
# Needs Docker with linux/arm64 support: native on Apple silicon, QEMU binfmt elsewhere.
set -euo pipefail
cd "$(dirname "$0")"

docker build --platform linux/arm64 -t localdesktop-guest-mesa .
docker run --platform linux/arm64 --rm localdesktop-guest-mesa cat /guest-mesa.tar.xz \
    > ../../assets/guest-mesa.tar.xz
