#!/bin/bash

set -e

./make-talloc-static.sh
./make-proot.sh
# Copy and strip proot and loader to assets/libs/arm64-v8a
ASSETS_LIB_DIR="${PWD}/../../../assets/libs/arm64-v8a"
mkdir -p "$ASSETS_LIB_DIR"
# Copy proot binary
if [ -f build/proot/src/proot ]; then
	echo "Copying and stripping proot to $ASSETS_LIB_DIR/libproot.so"
	cp build/proot/src/proot "$ASSETS_LIB_DIR/libproot.so"
	${STRIP:-strip} "$ASSETS_LIB_DIR/libproot.so" || true
fi
# Copy loader binary (prefer loader-m32 if reasonable size, else loader)
if [ -f build/proot/src/loader/loader-m32 ]; then
	LOADER_SIZE=$(stat -f%z build/proot/src/loader/loader-m32)
	if [ "$LOADER_SIZE" -lt 100000000 ]; then
		echo "Copying and stripping loader-m32 to $ASSETS_LIB_DIR/libproot_loader.so"
		cp build/proot/src/loader/loader-m32 "$ASSETS_LIB_DIR/libproot_loader.so"
		${STRIP:-strip} "$ASSETS_LIB_DIR/libproot_loader.so" || true
	fi
elif [ -f build/proot/src/loader/loader ]; then
	LOADER_SIZE=$(stat -f%z build/proot/src/loader/loader)
	if [ "$LOADER_SIZE" -lt 100000000 ]; then
		echo "Copying and stripping loader to $ASSETS_LIB_DIR/libproot_loader.so"
		cp build/proot/src/loader/loader "$ASSETS_LIB_DIR/libproot_loader.so"
		${STRIP:-strip} "$ASSETS_LIB_DIR/libproot_loader.so" || true
	fi
fi
./pack.sh
