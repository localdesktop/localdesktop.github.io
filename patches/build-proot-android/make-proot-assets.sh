#!/bin/bash

set -e

# Copy and strip PRoot binaries to the APK assets lib directory.
ASSETS_LIB_DIR="${PWD}/../../../assets/libs/arm64-v8a"
mkdir -p "$ASSETS_LIB_DIR"

if [ -f build/proot/src/proot ]; then
    echo "Copying and stripping proot to $ASSETS_LIB_DIR/libproot.so"
    cp build/proot/src/proot "$ASSETS_LIB_DIR/libproot.so"
    ${STRIP:-strip} "$ASSETS_LIB_DIR/libproot.so" || true
fi

# Prefer the 64-bit loader for arm64 APK packaging.
LOADER_PATH=""
if [ -f build/proot/src/loader/loader ]; then
    LOADER_PATH="build/proot/src/loader/loader"
elif [ -f build/proot/src/loader/loader-m32 ]; then
    LOADER_PATH="build/proot/src/loader/loader-m32"
fi

if [ -n "$LOADER_PATH" ]; then
    LOADER_SIZE=$(stat -f%z "$LOADER_PATH")
    if [ "$LOADER_SIZE" -lt 100000000 ]; then
        echo "Copying and stripping $(basename "$LOADER_PATH") to $ASSETS_LIB_DIR/libproot_loader.so"
        cp "$LOADER_PATH" "$ASSETS_LIB_DIR/libproot_loader.so"
        ${STRIP:-strip} "$ASSETS_LIB_DIR/libproot_loader.so" || true
    fi
fi
