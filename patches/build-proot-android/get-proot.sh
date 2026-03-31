#!/bin/bash

set -e
shopt -s nullglob

. ./config

cd "$BUILD_DIR"

git clone "$PROOT_REPO" proot
git -C proot checkout "$PROOT_COMMIT"

echo "Fetched termux/proot $PROOT_VERSION ($PROOT_COMMIT)"
