#!/bin/sh
# Replaces the pacman keyring shipped inside the rootfs archive by one with a freshly generated
# local signing key. The shipped archive contains a pre-generated private key that is identical
# on every installation, so a new master key is created and the Arch Linux ARM packager keys
# are re-signed (trusted) with it.
#
# The new keyring is built in a scratch directory and only swapped in when it is complete, so a
# failure at any point leaves the previous, working keyring untouched.
set -u

gnupg=/etc/pacman.d/gnupg
new=/etc/pacman.d/gnupg.new
old=/etc/pacman.d/gnupg.old

cleanup() { rm -rf "$new" "$old"; }
fail() {
    echo "keyring: $*" >&2
    rm -rf "$new"
    exit 1
}

rm -rf "$new" "$old"
mkdir -m 700 "$new" || fail "cannot create $new"

pacman-key --gpgdir "$new" --init || fail "pacman-key --init failed"
pacman-key --gpgdir "$new" --populate archlinuxarm || fail "pacman-key --populate failed"

# The result must contain the Arch Linux ARM keys, locally signed, and a secret key of our own.
keys=$(gpg --homedir "$new" --batch --list-keys --with-colons 2>/dev/null | grep -c '^pub:')
[ "${keys:-0}" -ge 2 ] || fail "new keyring looks incomplete ($keys public keys)"
gpg --homedir "$new" --batch --list-secret-keys --with-colons 2>/dev/null | grep -q '^sec:' ||
    fail "new keyring has no local signing key"

# gpg-agent sockets inside the directory would block the rename.
gpgconf --homedir "$new" --kill all >/dev/null 2>&1

[ -d "$gnupg" ] && { mv "$gnupg" "$old" || fail "cannot move the old keyring away"; }
if ! mv "$new" "$gnupg"; then
    [ -d "$old" ] && mv "$old" "$gnupg"
    fail "cannot move the new keyring into place"
fi
cleanup
echo "keyring: fresh pacman keyring installed"
