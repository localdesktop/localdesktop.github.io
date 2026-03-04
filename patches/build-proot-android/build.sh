#!/bin/bash

set -e

./make-talloc-static.sh
./make-proot.sh
./make-proot-assets.sh
./pack.sh
