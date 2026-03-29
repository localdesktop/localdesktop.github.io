use anyhow::Result;
use std::path::Path;

pub fn new(name: &str) -> Result<()> {
    let root = Path::new(name);
    let src = root.join("src");
    let android = src.join("android");
    let kotlin = android.join("kotlin");
    std::fs::create_dir(root)?;
    std::fs::create_dir(&src)?;
    std::fs::create_dir(&android)?;
    std::fs::create_dir(&kotlin)?;
    std::fs::write(
        root.join("Cargo.toml"),
        include_bytes!("../../template/Cargo_toml"),
    )?;
    std::fs::write(
        root.join(".gitignore"),
        include_bytes!("../../template/.gitignore"),
    )?;
    std::fs::write(
        root.join("manifest.yaml"),
        include_bytes!("../../template/manifest.yaml"),
    )?;
    std::fs::write(src.join("lib.rs"), include_bytes!("../../template/lib.rs"))?;
    std::fs::write(
        src.join("main.rs"),
        include_bytes!("../../template/main.rs"),
    )?;
    std::fs::write(
        kotlin.join("MainActivity.kt"),
        include_bytes!("../../template/MainActivity.kt"),
    )?;
    Ok(())
}
