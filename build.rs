fn main() {
    let lib_path = "./assets/libs/arm64-v8a";
    println!("cargo::rustc-link-search={}", lib_path);

    // Custom startup/ELF properties for the loader shim (no CRT; static PIE; explicit entrypoint).
    println!("cargo:rustc-link-arg-bin=rootless_chroot_loader=-nostartfiles");
    println!("cargo:rustc-link-arg-bin=rootless_chroot_loader=-static");
    println!("cargo:rustc-link-arg-bin=rootless_chroot_loader=-Wl,-pie");
    println!("cargo:rustc-link-arg-bin=rootless_chroot_loader=-Wl,-e,_start");
}
