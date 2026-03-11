#[cfg(target_os = "android")]
pub mod apk {
    use anyhow::{bail, Context, Result};
    use byteorder::{LittleEndian, ReadBytesExt};
    use image::imageops::FilterType;
    use image::io::Reader as ImageReader;
    use image::{DynamicImage, GenericImageView, ImageOutputFormat, RgbaImage};
    use rsa::pkcs8::DecodePrivateKey;
    use rsa::{PaddingScheme, RsaPrivateKey, RsaPublicKey};
    use serde::Deserialize;
    use sha2::{Digest, Sha256};
    use std::collections::HashSet;
    use std::env;
    use std::fs::{self, File};
    use std::io::{Cursor, Read, Seek, SeekFrom, Write};
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use zip::write::FileOptions;
    use zip::{CompressionMethod, ZipArchive, ZipWriter};

    use compiler::Table;
    use manifest::{Activity, AndroidManifest, IntentFilter, MetaData};
    use res::Chunk;
    use utils::{Target, VersionCode};

    #[derive(Clone, Debug, Default, Deserialize)]
    struct GenericConfig {
        icon: Option<PathBuf>,
        #[serde(default)]
        runtime_libs: Vec<PathBuf>,
    }

    #[derive(Clone, Debug, Default, Deserialize)]
    struct AndroidConfig {
        #[serde(flatten)]
        generic: GenericConfig,
        #[serde(default)]
        manifest: AndroidManifest,
        #[serde(default)]
        assets: Vec<AssetPath>,
        #[serde(default)]
        gradle: bool,
        #[serde(default)]
        dependencies: Vec<String>,
        #[serde(default)]
        wry: bool,
    }

    #[derive(Clone, Debug, Default, Deserialize)]
    struct RawConfig {
        #[serde(flatten)]
        generic: GenericConfig,
        android: Option<AndroidConfig>,
    }

    #[derive(Clone, Copy, Debug, Default, Deserialize)]
    #[serde(rename_all = "snake_case")]
    enum UnalignedCompressed {
        Unaligned,
        #[default]
        Compressed,
    }

    #[derive(Clone, Copy, Debug, Deserialize)]
    #[serde(untagged)]
    enum ZipAlignmentOptions {
        Aligned(u16),
        UnalignedCompressed(UnalignedCompressed),
    }

    impl Default for ZipAlignmentOptions {
        fn default() -> Self {
            Self::UnalignedCompressed(UnalignedCompressed::Compressed)
        }
    }

    impl ZipAlignmentOptions {
        fn to_zip_file_options(self) -> ZipFileOptions {
            match self {
                Self::Aligned(alignment) => ZipFileOptions::Aligned(alignment),
                Self::UnalignedCompressed(UnalignedCompressed::Unaligned) => {
                    ZipFileOptions::Unaligned
                }
                Self::UnalignedCompressed(UnalignedCompressed::Compressed) => {
                    ZipFileOptions::Compressed
                }
            }
        }
    }

    #[derive(Clone, Debug, Deserialize)]
    #[serde(untagged)]
    enum AssetPath {
        Path(PathBuf),
        Extended {
            path: PathBuf,
            #[serde(default)]
            optional: bool,
            #[serde(default)]
            alignment: ZipAlignmentOptions,
        },
    }

    impl AssetPath {
        fn path(&self) -> &Path {
            match self {
                AssetPath::Path(path) => path,
                AssetPath::Extended { path, .. } => path,
            }
        }

        fn optional(&self) -> bool {
            match self {
                AssetPath::Path(_) => false,
                AssetPath::Extended { optional, .. } => *optional,
            }
        }

        fn alignment(&self) -> ZipAlignmentOptions {
            match self {
                AssetPath::Path(_) => Default::default(),
                AssetPath::Extended { alignment, .. } => *alignment,
            }
        }
    }

    #[derive(Debug, Deserialize)]
    struct CargoManifest {
        package: CargoPackage,
    }

    #[derive(Debug, Deserialize)]
    struct CargoPackage {
        name: String,
        version: String,
    }

    pub fn build() -> Result<()> {
        let mut release = true;
        let mut manifest_path = PathBuf::from("manifest.yaml");
        let mut out_path = None;
        let mut android_jar_override = None;
        let mut args = std::env::args().skip(1);
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--release" => release = true,
                "--debug" => release = false,
                "--manifest" => {
                    manifest_path = PathBuf::from(
                        args.next()
                            .context("`--manifest` requires a path argument")?,
                    );
                }
                "--out" => {
                    out_path = Some(PathBuf::from(
                        args.next().context("`--out` requires a path argument")?,
                    ));
                }
                "--android-jar" => {
                    android_jar_override = Some(PathBuf::from(
                        args.next()
                            .context("`--android-jar` requires a path argument")?,
                    ));
                }
                "-h" | "--help" => {
                    println!(
                    "Usage: cargo run -- [--release] [--debug] [--manifest PATH] [--out PATH] [--android-jar PATH]"
                );
                    return Ok(());
                }
                _ => bail!("unknown argument: {arg}"),
            }
        }

        let root = std::env::var("CARGO_MANIFEST_DIR")
            .map(PathBuf::from)
            .unwrap_or(std::env::current_dir()?);

        if !manifest_path.is_absolute() {
            manifest_path = root.join(manifest_path);
        }

        let config = {
            let contents = fs::read_to_string(&manifest_path)
                .with_context(|| format!("Reading `{}`", manifest_path.display()))?;
            serde_yaml::from_str::<RawConfig>(&contents)
                .with_context(|| format!("Parsing `{}`", manifest_path.display()))?
        };

        let mut android = config.android.unwrap_or_default();
        android.gradle = false;
        let wry = android.wry;
        let assets = std::mem::take(&mut android.assets);
        let icon = android.generic.icon.take().or(config.generic.icon);
        let mut runtime_libs = android.generic.runtime_libs;
        runtime_libs.extend(config.generic.runtime_libs);

        let cargo_manifest = {
            let cargo_path = root.join("Cargo.toml");
            let contents = fs::read_to_string(&cargo_path)
                .with_context(|| format!("Reading `{}`", cargo_path.display()))?;
            toml::from_str::<CargoManifest>(&contents)
                .with_context(|| format!("Parsing `{}`", cargo_path.display()))?
        };

        let package_name = cargo_manifest.package.name;
        let package_version = cargo_manifest.package.version;
        let lib_name = package_name.replace('-', "_");

        let mut manifest = std::mem::take(&mut android.manifest);
        if manifest.package.is_none() {
            manifest.package = Some(format!("com.example.{lib_name}"));
        }
        if manifest.version_name.is_none() {
            manifest.version_name = Some(package_version.clone());
        }
        if manifest.version_code.is_none() {
            if let Ok(code) = VersionCode::from_semver(&package_version) {
                manifest.version_code = Some(code.to_code(1));
            }
        }
        let target_sdk_version = 33;
        let target_sdk_codename = 13;
        let min_sdk_version = 21;
        manifest
            .compile_sdk_version
            .get_or_insert(target_sdk_version);
        manifest
            .platform_build_version_code
            .get_or_insert(target_sdk_version);
        manifest
            .compile_sdk_version_codename
            .get_or_insert(target_sdk_codename);
        manifest
            .platform_build_version_name
            .get_or_insert(target_sdk_codename);
        manifest
            .sdk
            .target_sdk_version
            .get_or_insert(target_sdk_version);
        manifest.sdk.min_sdk_version.get_or_insert(min_sdk_version);

        let app = &mut manifest.application;
        if app.label.is_none() {
            app.label = Some(package_name.clone());
        }
        if app.debuggable.is_none() {
            app.debuggable = Some(!release);
        }
        if app.has_code.is_none() {
            app.has_code = Some(wry);
        }
        if wry && app.theme.is_none() {
            app.theme = Some("@style/Theme.AppCompat.Light.NoActionBar".into());
        }
        if app.activities.is_empty() {
            app.activities.push(Activity::default());
        }
        let activity = &mut app.activities[0];
        if activity.config_changes.is_none() {
            activity.config_changes = Some(
                [
                    "orientation",
                    "keyboardHidden",
                    "keyboard",
                    "screenSize",
                    "smallestScreenSize",
                    "locale",
                    "layoutDirection",
                    "fontScale",
                    "screenLayout",
                    "density",
                    "uiMode",
                ]
                .join("|"),
            );
        }
        if activity.launch_mode.is_none() {
            activity.launch_mode = Some("singleTop".into());
        }
        if activity.name.is_none() {
            activity.name = Some(
                if wry {
                    ".MainActivity"
                } else {
                    "android.app.NativeActivity"
                }
                .into(),
            );
        }
        if activity.window_soft_input_mode.is_none() {
            activity.window_soft_input_mode = Some("adjustResize".into());
        }
        if activity.hardware_accelerated.is_none() {
            activity.hardware_accelerated = Some(true);
        }
        if activity.exported.is_none() {
            activity.exported = Some(true);
        }
        if !wry {
            activity.meta_data.push(MetaData {
                name: "android.app.lib_name".into(),
                value: lib_name.clone(),
            });
        }
        activity.intent_filters.push(IntentFilter {
            actions: vec!["android.intent.action.MAIN".into()],
            categories: vec!["android.intent.category.LAUNCHER".into()],
            data: vec![],
        });

        let mut cargo = Command::new("cargo");
        cargo.arg("build").arg("--lib");
        if release {
            cargo.arg("--release");
        }
        let status = cargo
            .current_dir(&root)
            .status()
            .context("Running `cargo build`")?;
        if !status.success() {
            bail!("`cargo build` failed");
        }

        let target_dir = std::env::var("CARGO_TARGET_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| root.join("target"));
        let build_root = if let Ok(triple) = std::env::var("CARGO_BUILD_TARGET") {
            target_dir.join(triple)
        } else {
            target_dir.clone()
        };
        let profile_dir = build_root.join(if release { "release" } else { "debug" });
        let cdylib_path = profile_dir.join(format!("lib{lib_name}.so"));
        if !cdylib_path.exists() {
            bail!("Expected cdylib not found at `{}`", cdylib_path.display());
        }

        let apk_target = match std::env::consts::ARCH {
            "aarch64" => Target::Arm64V8a,
            "arm" => Target::ArmV7a,
            "x86" => Target::X86,
            "x86_64" => Target::X86_64,
            arch => bail!("unsupported host arch `{arch}`"),
        };

        let out_path = out_path.unwrap_or_else(|| root.join(format!("{package_name}.apk")));
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent)?;
        }

        let android_jar = ensure_android_jar(
            &root,
            manifest.sdk.target_sdk_version.unwrap_or(33),
            android_jar_override,
        )?;

        let mut apk = Apk::new(out_path.clone(), manifest, release)?;

        let icon_path = icon.map(|path| root.join(path));
        apk.add_res(icon_path.as_deref(), &android_jar)?;

        for asset in &assets {
            let path = root.join(asset.path());
            if asset.optional() && !path.exists() {
                continue;
            }
            apk.add_asset(&path, asset.alignment().to_zip_file_options())?;
        }

        let mut libraries = Vec::new();
        libraries.push(cdylib_path);
        for runtime_root in runtime_libs {
            let abi_dir = root.join(runtime_root).join(apk_target.as_str());
            let entries = fs::read_dir(&abi_dir)
                .with_context(|| format!("Runtime libs not found at `{}`", abi_dir.display()))?;
            for entry in entries {
                let entry = entry?;
                let path = entry.path();
                if path.is_file() && path.extension().and_then(|ext| ext.to_str()) == Some("so") {
                    libraries.push(path);
                }
            }
        }

        let mut seen = HashSet::new();
        for lib in libraries {
            if seen.insert(lib.clone()) {
                apk.add_lib(apk_target, &lib)?;
            }
        }

        apk.finish(None)?;

        println!("APK written to {}", out_path.display());
        Ok(())
    }

    pub struct Apk {
        manifest: AndroidManifest,
        path: PathBuf,
        zip: Zip,
    }

    impl Apk {
        pub fn new(path: PathBuf, manifest: AndroidManifest, compress: bool) -> Result<Self> {
            let zip = Zip::new(&path, compress)?;
            Ok(Self {
                manifest,
                path,
                zip,
            })
        }

        pub fn add_res(&mut self, icon: Option<&Path>, android: &Path) -> Result<()> {
            let mut buf = vec![];
            let mut table = Table::default();
            table
                .import_apk(android)
                .with_context(|| format!("Failed to parse `{}`", android.display()))?;
            if let Some(path) = icon {
                let mut scaler = Scaler::open(path)?;
                scaler.optimize();
                let package = if let Some(package) = self.manifest.package.as_ref() {
                    package
                } else {
                    anyhow::bail!("missing manifest.package");
                };
                let mipmap = compiler::compile_mipmap(package, "icon")?;

                let mut cursor = Cursor::new(&mut buf);
                mipmap.chunk().write(&mut cursor)?;
                self.zip.create_file(
                    Path::new("resources.arsc"),
                    ZipFileOptions::Aligned(4),
                    &buf,
                )?;

                for (name, size) in mipmap.variants() {
                    buf.clear();
                    let mut cursor = Cursor::new(&mut buf);
                    scaler.write(&mut cursor, ScalerOpts::new(size))?;
                    self.zip
                        .create_file(name.as_ref(), ZipFileOptions::Aligned(4), &buf)?;
                }

                table.import_chunk(mipmap.chunk());
                self.manifest.application.icon = Some("@mipmap/icon".into());
            }
            let manifest = compiler::compile_manifest(&self.manifest, &table)?;
            buf.clear();
            let mut cursor = Cursor::new(&mut buf);
            manifest.write(&mut cursor)?;
            self.zip.create_file(
                Path::new("AndroidManifest.xml"),
                ZipFileOptions::Compressed,
                &buf,
            )?;
            Ok(())
        }

        pub fn add_asset(&mut self, asset: &Path, opts: ZipFileOptions) -> Result<()> {
            let file_name = asset
                .file_name()
                .context("Asset must have file_name component")?;
            let dest = Path::new("assets").join(file_name);
            if asset.is_dir() {
                self.zip.add_directory(asset, &dest, opts)
            } else {
                self.zip.add_file(asset, &dest, opts)
            }
            .with_context(|| format!("While embedding asset `{}`", asset.display()))
        }

        pub fn add_dex(&mut self, dex: &Path) -> Result<()> {
            self.zip
                .add_file(dex, Path::new("classes.dex"), ZipFileOptions::Compressed)?;
            Ok(())
        }

        pub fn add_lib(&mut self, target: Target, path: &Path) -> Result<()> {
            let name = path.file_name().context("invalid path")?;
            self.zip.add_file(
                path,
                &Path::new("lib").join(target.as_str()).join(name),
                ZipFileOptions::Compressed,
            )
        }

        pub fn finish(self, signer: Option<Signer>) -> Result<()> {
            self.zip.finish()?;
            sign::sign(&self.path, signer)?;
            Ok(())
        }

        pub fn sign(path: &Path, signer: Option<Signer>) -> Result<()> {
            sign::sign(path, signer)
        }

        pub fn verify(path: &Path) -> Result<Vec<Certificate>> {
            sign::verify(path)
        }

        pub fn entry_point(path: &Path) -> Result<EntryPoint> {
            let manifest = extract_zip_file(path, "AndroidManifest.xml")?;
            let chunks = if let Chunk::Xml(chunks) = Chunk::parse(&mut Cursor::new(manifest))? {
                chunks
            } else {
                anyhow::bail!("invalid manifest 0");
            };
            let strings = if let Chunk::StringPool(strings, _) = &chunks[0] {
                strings
            } else {
                anyhow::bail!("invalid manifest 1");
            };
            let mut manifest = None;
            let mut package = None;
            let mut activity = None;
            let mut name = None;
            for (i, s) in strings.iter().enumerate() {
                match s.as_str() {
                    "manifest" => {
                        manifest = Some(i as i32);
                    }
                    "package" => {
                        package = Some(i as i32);
                    }
                    "activity" => {
                        activity = Some(i as i32);
                    }
                    "name" => {
                        name = Some(i as i32);
                    }
                    _ => {}
                }
            }
            let (manifest, package, activity, name) =
                if let (Some(manifest), Some(package), Some(activity), Some(name)) =
                    (manifest, package, activity, name)
                {
                    (manifest, package, activity, name)
                } else {
                    anyhow::bail!("invalid manifest 2");
                };
            let mut package_value = None;
            let mut name_value = None;
            for chunk in &chunks[2..] {
                if let Chunk::XmlStartElement(_, el, attrs) = chunk {
                    match el.name {
                        x if x == manifest => {
                            package_value = attrs
                                .iter()
                                .find(|attr| attr.name == package)
                                .map(|attr| attr.raw_value);
                        }
                        x if x == activity => {
                            if name_value.is_some() {
                                continue;
                            }
                            name_value = attrs
                                .iter()
                                .find(|attr| attr.name == name)
                                .map(|attr| attr.raw_value);
                        }
                        _ => {}
                    }
                }
            }
            let entry = if let (Some(package_value), Some(name_value)) = (package_value, name_value)
            {
                EntryPoint {
                    package: strings[package_value as usize].clone(),
                    activity: strings[name_value as usize].clone(),
                }
            } else {
                anyhow::bail!("invalid manifest 3");
            };
            Ok(entry)
        }
    }

    #[derive(Clone, Debug, Eq, PartialEq)]
    pub struct EntryPoint {
        pub package: String,
        pub activity: String,
    }

    type Certificate = rasn_pkix::Certificate;

    struct Scaler {
        img: DynamicImage,
    }

    impl Scaler {
        pub fn open<P: AsRef<Path>>(path: P) -> Result<Self> {
            let path = path.as_ref();
            let img = ImageReader::open(path)
                .with_context(|| format!("Scaler failed to open image at `{}`", path.display()))?
                .decode()?;
            let (width, height) = img.dimensions();
            anyhow::ensure!(width == height, "expected width == height");
            anyhow::ensure!(width >= 512, "expected icon of at least 512x512 px");
            Ok(Self { img })
        }

        pub fn optimize(&mut self) {
            let mut is_grayscale = true;
            let mut is_opaque = true;
            let (width, height) = self.img.dimensions();
            for x in 0..width {
                for y in 0..height {
                    let pixel = self.img.get_pixel(x, y);
                    if pixel[0] != pixel[1] || pixel[1] != pixel[2] {
                        is_grayscale = false;
                    }
                    if pixel[3] != 255 {
                        is_opaque = false;
                    }
                    if !is_grayscale && !is_opaque {
                        break;
                    }
                }
            }
            match (is_grayscale, is_opaque) {
                (true, true) => self.img = DynamicImage::ImageLuma8(self.img.to_luma8()),
                (true, false) => self.img = DynamicImage::ImageLumaA8(self.img.to_luma_alpha8()),
                (false, true) => self.img = DynamicImage::ImageRgb8(self.img.to_rgb8()),
                (false, false) => {}
            }
        }

        pub fn write<W: Write + Seek>(&self, w: &mut W, opts: ScalerOpts) -> Result<()> {
            let resized = self
                .img
                .resize(opts.scaled_size, opts.scaled_size, FilterType::Nearest);
            if opts.scaled_size == opts.target_width && opts.scaled_size == opts.target_height {
                resized.write_to(w, ImageOutputFormat::Png)?;
            } else {
                let x = (opts.target_width - opts.scaled_size) / 2;
                let y = (opts.target_height - opts.scaled_size) / 2;
                let mut padded = RgbaImage::new(opts.target_width, opts.target_height);
                image::imageops::overlay(&mut padded, &resized, x as i64, y as i64);
                padded.write_to(w, ImageOutputFormat::Png)?;
            }
            Ok(())
        }
    }

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    struct ScalerOpts {
        target_width: u32,
        target_height: u32,
        scaled_size: u32,
    }

    impl ScalerOpts {
        pub fn new(size: u32) -> Self {
            Self {
                target_width: size,
                target_height: size,
                scaled_size: size,
            }
        }
    }

    #[derive(Clone)]
    struct Signer {
        key: RsaPrivateKey,
        pubkey: RsaPublicKey,
        cert: Certificate,
    }

    impl Signer {
        pub fn new(pem: &str) -> Result<Self> {
            let pem = pem::parse_many(pem)?;
            let key = if let Some(key) = pem.iter().find(|pem| pem.tag == "PRIVATE KEY") {
                RsaPrivateKey::from_pkcs8_der(&key.contents)?
            } else {
                anyhow::bail!("no private key found");
            };
            let cert = if let Some(cert) = pem.iter().find(|pem| pem.tag == "CERTIFICATE") {
                rasn::der::decode::<Certificate>(&cert.contents)
                    .map_err(|err| anyhow::anyhow!("{}", err))?
            } else {
                anyhow::bail!("no certificate found");
            };
            let pubkey = RsaPublicKey::from(&key);
            Ok(Self { key, pubkey, cert })
        }

        pub fn from_path(path: &Path) -> Result<Self> {
            Self::new(&std::fs::read_to_string(path)?)
        }

        pub fn sign(&self, bytes: &[u8]) -> Vec<u8> {
            let digest = Sha256::digest(bytes);
            let padding = PaddingScheme::new_pkcs1v15_sign::<sha2::Sha256>();
            self.key.sign(padding, &digest).unwrap()
        }

        pub fn pubkey(&self) -> &RsaPublicKey {
            &self.pubkey
        }

        pub fn key(&self) -> &RsaPrivateKey {
            &self.key
        }

        pub fn cert(&self) -> &Certificate {
            &self.cert
        }
    }

    impl std::fmt::Debug for Signer {
        fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            f.debug_struct("Signer")
                .field("pubkey", &self.pubkey)
                .field("cert", &self.cert)
                .finish_non_exhaustive()
        }
    }

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    enum ZipFileOptions {
        Unaligned,
        Aligned(u16),
        Compressed,
    }

    impl ZipFileOptions {
        pub fn alignment(self) -> u16 {
            match self {
                Self::Aligned(align) => align,
                _ => 1,
            }
        }

        pub fn compression_method(&self) -> CompressionMethod {
            match self {
                Self::Compressed => CompressionMethod::Deflated,
                _ => CompressionMethod::Stored,
            }
        }
    }

    struct ZipInfo {
        pub cde_start: u64,
        pub cd_start: u64,
    }

    impl ZipInfo {
        pub fn new<R: Read + Seek>(r: &mut R) -> Result<Self> {
            let cde_start = find_cde_start_pos(r)?;
            r.seek(SeekFrom::Start(cde_start + 16))?;
            let cd_start = r.read_u32::<LittleEndian>()? as u64;
            Ok(Self {
                cde_start,
                cd_start,
            })
        }
    }

    fn find_cde_start_pos<R: Read + Seek>(reader: &mut R) -> Result<u64> {
        const CENTRAL_DIRECTORY_END_SIGNATURE: u32 = 0x06054b50;
        const HEADER_SIZE: u64 = 22;
        let file_length = reader.seek(SeekFrom::End(0))?;
        let search_upper_bound = file_length.saturating_sub(HEADER_SIZE + u16::MAX as u64);
        anyhow::ensure!(file_length >= HEADER_SIZE, "Invalid zip header");
        let mut pos = file_length - HEADER_SIZE;
        while pos >= search_upper_bound {
            reader.seek(SeekFrom::Start(pos))?;
            if reader.read_u32::<LittleEndian>()? == CENTRAL_DIRECTORY_END_SIGNATURE {
                return Ok(pos);
            }
            pos = match pos.checked_sub(1) {
                Some(p) => p,
                None => break,
            };
        }
        anyhow::bail!("Could not find central directory end");
    }

    struct Zip {
        zip: ZipWriter<File>,
        compress: bool,
    }

    impl Zip {
        pub fn new(path: &Path, compress: bool) -> Result<Self> {
            Ok(Self {
                zip: ZipWriter::new(File::create(path)?),
                compress,
            })
        }

        pub fn add_file(&mut self, source: &Path, dest: &Path, opts: ZipFileOptions) -> Result<()> {
            let mut f = File::open(source)
                .with_context(|| format!("While opening file `{}`", source.display()))?;
            self.start_file(dest, opts)?;
            std::io::copy(&mut f, &mut self.zip)?;
            Ok(())
        }

        pub fn add_directory(
            &mut self,
            source: &Path,
            dest: &Path,
            opts: ZipFileOptions,
        ) -> Result<()> {
            add_recursive(self, source, dest, opts)?;
            Ok(())
        }

        pub fn create_file(
            &mut self,
            dest: &Path,
            opts: ZipFileOptions,
            contents: &[u8],
        ) -> Result<()> {
            self.start_file(dest, opts)?;
            self.zip.write_all(contents)?;
            Ok(())
        }

        fn start_file(&mut self, dest: &Path, opts: ZipFileOptions) -> Result<()> {
            let name = dest
                .iter()
                .map(|seg| seg.to_str().unwrap())
                .collect::<Vec<_>>()
                .join("/");
            let compression_method = if self.compress {
                opts.compression_method()
            } else {
                CompressionMethod::Stored
            };
            let zopts = FileOptions::default().compression_method(compression_method);
            self.zip.start_file_aligned(name, zopts, opts.alignment())?;
            Ok(())
        }

        pub fn finish(mut self) -> Result<()> {
            self.zip.finish()?;
            Ok(())
        }
    }

    fn add_recursive(
        zip: &mut Zip,
        source: &Path,
        dest: &Path,
        opts: ZipFileOptions,
    ) -> Result<()> {
        for entry in std::fs::read_dir(source)
            .with_context(|| format!("While reading directory `{}`", source.display()))?
        {
            let entry = entry?;
            let file_name = entry.file_name();
            let source = source.join(&file_name);
            let dest = dest.join(&file_name);
            let file_type = entry.file_type()?;
            if file_type.is_dir() {
                add_recursive(zip, &source, &dest, opts)?;
            } else if file_type.is_file() {
                zip.add_file(&source, &dest, opts)?;
            }
        }
        Ok(())
    }

    fn extract_zip_file(archive: &Path, name: &str) -> Result<Vec<u8>> {
        let mut archive = ZipArchive::new(File::open(archive)?)?;
        let mut f = archive.by_name(name)?;
        let mut buf = Vec::with_capacity(f.size() as usize);
        f.read_to_end(&mut buf)?;
        Ok(buf)
    }

    mod manifest {
        use anyhow::Result;
        use serde::{Deserialize, Serialize, Serializer};

        /// Android [manifest element](https://developer.android.com/guide/topics/manifest/manifest-element), containing an [`Application`] element.
        #[derive(Clone, Debug, Deserialize, Serialize)]
        #[serde(rename = "manifest")]
        #[serde(deny_unknown_fields)]
        pub struct AndroidManifest {
            #[serde(rename(serialize = "xmlns:android"))]
            #[serde(default = "default_namespace")]
            ns_android: String,
            pub package: Option<String>,
            #[serde(rename(serialize = "android:versionCode"))]
            pub version_code: Option<u32>,
            #[serde(rename(serialize = "android:versionName"))]
            pub version_name: Option<String>,
            #[serde(rename(serialize = "android:compileSdkVersion"))]
            pub compile_sdk_version: Option<u32>,
            #[serde(rename(serialize = "android:compileSdkVersionCodename"))]
            pub compile_sdk_version_codename: Option<u32>,
            #[serde(rename(serialize = "platformBuildVersionCode"))]
            pub platform_build_version_code: Option<u32>,
            #[serde(rename(serialize = "platformBuildVersionName"))]
            pub platform_build_version_name: Option<u32>,
            #[serde(rename(serialize = "uses-sdk"))]
            #[serde(default)]
            pub sdk: Sdk,
            #[serde(rename(serialize = "uses-feature"))]
            #[serde(default)]
            pub uses_feature: Vec<Feature>,
            #[serde(rename(serialize = "uses-permission"))]
            #[serde(default)]
            pub uses_permission: Vec<Permission>,
            #[serde(default)]
            pub application: Application,
        }

        impl Default for AndroidManifest {
            fn default() -> Self {
                Self {
                    ns_android: default_namespace(),
                    package: Default::default(),
                    version_code: Default::default(),
                    version_name: Default::default(),
                    sdk: Default::default(),
                    uses_feature: Default::default(),
                    uses_permission: Default::default(),
                    application: Default::default(),
                    compile_sdk_version: Default::default(),
                    compile_sdk_version_codename: Default::default(),
                    platform_build_version_code: Default::default(),
                    platform_build_version_name: Default::default(),
                }
            }
        }

        impl std::fmt::Display for AndroidManifest {
            fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                write!(f, "{}", quick_xml::se::to_string(self).unwrap())
            }
        }

        /// Android [application element](https://developer.android.com/guide/topics/manifest/application-element), containing an [`Activity`] element.
        #[derive(Clone, Debug, Default, Deserialize, Serialize)]
        #[serde(deny_unknown_fields)]
        pub struct Application {
            #[serde(rename(serialize = "android:debuggable"))]
            pub debuggable: Option<bool>,
            #[serde(rename(serialize = "android:theme"))]
            pub theme: Option<String>,
            #[serde(rename(serialize = "android:hasCode"))]
            pub has_code: Option<bool>,
            #[serde(rename(serialize = "android:icon"))]
            pub icon: Option<String>,
            #[serde(rename(serialize = "android:label"))]
            pub label: Option<String>,
            #[serde(rename(serialize = "android:appComponentFactory"))]
            pub app_component_factory: Option<String>,
            #[serde(rename(serialize = "meta-data"))]
            #[serde(default)]
            pub meta_data: Vec<MetaData>,
            #[serde(rename(serialize = "activity"))]
            #[serde(default)]
            pub activities: Vec<Activity>,
            #[serde(rename(serialize = "android:usesCleartextTraffic"))]
            pub use_cleartext_traffic: Option<bool>,
            #[serde(rename(serialize = "android:extractNativeLibs"))]
            pub extract_native_libs: Option<bool>,
        }

        /// Android [activity element](https://developer.android.com/guide/topics/manifest/activity-element).
        #[derive(Clone, Debug, Default, Deserialize, Serialize)]
        #[serde(deny_unknown_fields)]
        pub struct Activity {
            #[serde(rename(serialize = "android:configChanges"))]
            pub config_changes: Option<String>,
            #[serde(rename(serialize = "android:label"))]
            pub label: Option<String>,
            #[serde(rename(serialize = "android:launchMode"))]
            pub launch_mode: Option<String>,
            #[serde(rename(serialize = "android:name"))]
            pub name: Option<String>,
            #[serde(rename(serialize = "android:screenOrientation"))]
            pub orientation: Option<String>,
            #[serde(rename(serialize = "android:windowSoftInputMode"))]
            pub window_soft_input_mode: Option<String>,
            #[serde(rename(serialize = "android:exported"))]
            pub exported: Option<bool>,
            #[serde(rename(serialize = "android:hardwareAccelerated"))]
            pub hardware_accelerated: Option<bool>,
            #[serde(rename(serialize = "meta-data"))]
            #[serde(default)]
            pub meta_data: Vec<MetaData>,
            /// If no `MAIN` action exists in any intent filter, a default `MAIN` filter is serialized.
            #[serde(rename(serialize = "intent-filter"))]
            #[serde(default)]
            pub intent_filters: Vec<IntentFilter>,
            #[serde(rename(serialize = "android:colorMode"))]
            pub color_mode: Option<String>,
        }

        /// Android [intent filter element](https://developer.android.com/guide/topics/manifest/intent-filter-element).
        #[derive(Clone, Debug, Default, Deserialize, Serialize)]
        #[serde(deny_unknown_fields)]
        pub struct IntentFilter {
            /// Serialize strings wrapped in `<action android:name="..." />`
            #[serde(serialize_with = "serialize_actions")]
            #[serde(rename(serialize = "action"))]
            #[serde(default)]
            pub actions: Vec<String>,
            /// Serialize as vector of structs for proper xml formatting
            #[serde(serialize_with = "serialize_catergories")]
            #[serde(rename(serialize = "category"))]
            #[serde(default)]
            pub categories: Vec<String>,
            #[serde(default)]
            pub data: Vec<IntentFilterData>,
        }

        fn serialize_actions<S>(actions: &[String], serializer: S) -> Result<S::Ok, S::Error>
        where
            S: Serializer,
        {
            use serde::ser::SerializeSeq;

            #[derive(Serialize)]
            struct Action {
                #[serde(rename = "android:name")]
                name: String,
            }
            let mut seq = serializer.serialize_seq(Some(actions.len()))?;
            for action in actions {
                seq.serialize_element(&Action {
                    name: action.clone(),
                })?;
            }
            seq.end()
        }

        fn serialize_catergories<S>(categories: &[String], serializer: S) -> Result<S::Ok, S::Error>
        where
            S: Serializer,
        {
            use serde::ser::SerializeSeq;

            #[derive(Serialize)]
            struct Category {
                #[serde(rename = "android:name")]
                pub name: String,
            }

            let mut seq = serializer.serialize_seq(Some(categories.len()))?;
            for category in categories {
                seq.serialize_element(&Category {
                    name: category.clone(),
                })?;
            }
            seq.end()
        }

        /// Android [intent filter data element](https://developer.android.com/guide/topics/manifest/data-element).
        #[derive(Clone, Debug, Default, Deserialize, Serialize)]
        #[serde(deny_unknown_fields)]
        pub struct IntentFilterData {
            #[serde(rename(serialize = "android:scheme"))]
            pub scheme: Option<String>,
            #[serde(rename(serialize = "android:host"))]
            pub host: Option<String>,
            #[serde(rename(serialize = "android:port"))]
            pub port: Option<String>,
            #[serde(rename(serialize = "android:path"))]
            pub path: Option<String>,
            #[serde(rename(serialize = "android:pathPattern"))]
            pub path_pattern: Option<String>,
            #[serde(rename(serialize = "android:pathPrefix"))]
            pub path_prefix: Option<String>,
            #[serde(rename(serialize = "android:mimeType"))]
            pub mime_type: Option<String>,
        }

        /// Android [meta-data element](https://developer.android.com/guide/topics/manifest/meta-data-element).
        #[derive(Clone, Debug, Default, Deserialize, Serialize)]
        #[serde(deny_unknown_fields)]
        pub struct MetaData {
            #[serde(rename(serialize = "android:name"))]
            pub name: String,
            #[serde(rename(serialize = "android:value"))]
            pub value: String,
        }

        /// Android [uses-feature element](https://developer.android.com/guide/topics/manifest/uses-feature-element).
        #[derive(Clone, Debug, Default, Deserialize, Serialize)]
        #[serde(deny_unknown_fields)]
        pub struct Feature {
            #[serde(rename(serialize = "android:name"))]
            pub name: Option<String>,
            #[serde(rename(serialize = "android:required"))]
            pub required: Option<bool>,
            /// The `version` field is currently used for the following features:
            ///
            /// - `name="android.hardware.vulkan.compute"`: The minimum level of compute features required. See the [Android documentation](https://developer.android.com/reference/android/content/pm/PackageManager#FEATURE_VULKAN_HARDWARE_COMPUTE)
            ///   for available levels and the respective Vulkan features required/provided.
            ///
            /// - `name="android.hardware.vulkan.level"`: The minimum Vulkan requirements. See the [Android documentation](https://developer.android.com/reference/android/content/pm/PackageManager#FEATURE_VULKAN_HARDWARE_LEVEL)
            ///   for available levels and the respective Vulkan features required/provided.
            ///
            /// - `name="android.hardware.vulkan.version"`: Represents the value of Vulkan's `VkPhysicalDeviceProperties::apiVersion`. See the [Android documentation](https://developer.android.com/reference/android/content/pm/PackageManager#FEATURE_VULKAN_HARDWARE_VERSION)
            ///    for available levels and the respective Vulkan features required/provided.
            #[serde(rename(serialize = "android:version"))]
            pub version: Option<u32>,
            #[serde(rename(serialize = "android:glEsVersion"))]
            #[serde(serialize_with = "serialize_opengles_version")]
            pub opengles_version: Option<(u8, u8)>,
        }

        fn serialize_opengles_version<S>(
            version: &Option<(u8, u8)>,
            serializer: S,
        ) -> Result<S::Ok, S::Error>
        where
            S: Serializer,
        {
            match version {
                Some(version) => {
                    let opengles_version = format!("0x{:04}{:04}", version.0, version.1);
                    serializer.serialize_some(&opengles_version)
                }
                None => serializer.serialize_none(),
            }
        }

        /// Android [uses-permission element](https://developer.android.com/guide/topics/manifest/uses-permission-element).
        #[derive(Clone, Debug, Deserialize, Serialize)]
        #[serde(deny_unknown_fields)]
        pub struct Permission {
            #[serde(rename(serialize = "android:name"))]
            pub name: String,
            #[serde(rename(serialize = "android:maxSdkVersion"))]
            pub max_sdk_version: Option<u32>,
        }

        /// Android [uses-sdk element](https://developer.android.com/guide/topics/manifest/uses-sdk-element).
        #[derive(Clone, Debug, Default, Deserialize, Serialize)]
        #[serde(deny_unknown_fields)]
        pub struct Sdk {
            #[serde(rename(serialize = "android:minSdkVersion"))]
            pub min_sdk_version: Option<u32>,
            #[serde(rename(serialize = "android:targetSdkVersion"))]
            pub target_sdk_version: Option<u32>,
            #[serde(rename(serialize = "android:maxSdkVersion"))]
            pub max_sdk_version: Option<u32>,
        }

        fn default_namespace() -> String {
            "http://schemas.android.com/apk/res/android".to_string()
        }
    }

    mod res {
        use anyhow::Result;
        use byteorder::{LittleEndian, ReadBytesExt, WriteBytesExt};
        use std::io::{Read, Seek, SeekFrom, Write};

        #[derive(Clone, Copy, Debug, Eq, PartialEq)]
        #[repr(u16)]
        pub enum ChunkType {
            Null = 0x0000,
            StringPool = 0x0001,
            Table = 0x0002,
            Xml = 0x0003,
            XmlStartNamespace = 0x0100,
            XmlEndNamespace = 0x0101,
            XmlStartElement = 0x0102,
            XmlEndElement = 0x0103,
            //XmlCdata = 0x0104,
            //XmlLastChunk = 0x017f,
            XmlResourceMap = 0x0180,
            TablePackage = 0x0200,
            TableType = 0x0201,
            TableTypeSpec = 0x0202,
            Unknown = 0x0206,
        }

        impl ChunkType {
            pub fn from_u16(ty: u16) -> Option<Self> {
                Some(match ty {
                    ty if ty == ChunkType::Null as u16 => ChunkType::Null,
                    ty if ty == ChunkType::StringPool as u16 => ChunkType::StringPool,
                    ty if ty == ChunkType::Table as u16 => ChunkType::Table,
                    ty if ty == ChunkType::Xml as u16 => ChunkType::Xml,
                    ty if ty == ChunkType::XmlStartNamespace as u16 => ChunkType::XmlStartNamespace,
                    ty if ty == ChunkType::XmlEndNamespace as u16 => ChunkType::XmlEndNamespace,
                    ty if ty == ChunkType::XmlStartElement as u16 => ChunkType::XmlStartElement,
                    ty if ty == ChunkType::XmlEndElement as u16 => ChunkType::XmlEndElement,
                    //ty if ty == ChunkType::XmlCdata as u16 => ChunkType::XmlCdata,
                    //ty if ty == ChunkType::XmlLastChunk as u16 => ChunkType::XmlLastChunk,
                    ty if ty == ChunkType::XmlResourceMap as u16 => ChunkType::XmlResourceMap,
                    ty if ty == ChunkType::TablePackage as u16 => ChunkType::TablePackage,
                    ty if ty == ChunkType::TableType as u16 => ChunkType::TableType,
                    ty if ty == ChunkType::TableTypeSpec as u16 => ChunkType::TableTypeSpec,
                    ty if ty == ChunkType::Unknown as u16 => ChunkType::Unknown,
                    _ => return None,
                })
            }
        }

        #[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
        pub struct ResChunkHeader {
            /// Type identifier for this chunk. The meaning of this value depends
            /// on the containing chunk.
            pub ty: u16,
            /// Size of the chunk header (in bytes). Adding this value to the address
            /// of the chunk allows you to find its associated data (if any).
            pub header_size: u16,
            /// Total size of this chunk (in bytes). This is the header_size plus the
            /// size of any data associated with the chunk. Adding this value to the
            /// chunk allows you to completely skip its contents (including any child
            /// chunks). If this value is the same as header_size, there is no data
            /// associated with the chunk.
            pub size: u32,
        }

        impl ResChunkHeader {
            pub fn read(r: &mut impl Read) -> Result<Self> {
                let ty = r.read_u16::<LittleEndian>()?;
                let header_size = r.read_u16::<LittleEndian>()?;
                let size = r.read_u32::<LittleEndian>()?;
                Ok(Self {
                    ty,
                    header_size,
                    size,
                })
            }

            pub fn write(&self, w: &mut impl Write) -> Result<()> {
                w.write_u16::<LittleEndian>(self.ty)?;
                w.write_u16::<LittleEndian>(self.header_size)?;
                w.write_u32::<LittleEndian>(self.size)?;
                Ok(())
            }
        }

        #[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
        pub struct ResStringPoolHeader {
            pub string_count: u32,
            pub style_count: u32,
            pub flags: u32,
            pub strings_start: u32,
            pub styles_start: u32,
        }

        impl ResStringPoolHeader {
            pub const SORTED_FLAG: u32 = 1 << 0;
            pub const UTF8_FLAG: u32 = 1 << 8;

            pub fn read(r: &mut impl Read) -> Result<Self> {
                let string_count = r.read_u32::<LittleEndian>()?;
                let style_count = r.read_u32::<LittleEndian>()?;
                let flags = r.read_u32::<LittleEndian>()?;
                let strings_start = r.read_u32::<LittleEndian>()?;
                let styles_start = r.read_u32::<LittleEndian>()?;
                Ok(Self {
                    string_count,
                    style_count,
                    flags,
                    strings_start,
                    styles_start,
                })
            }

            pub fn write(&self, w: &mut impl Write) -> Result<()> {
                w.write_u32::<LittleEndian>(self.string_count)?;
                w.write_u32::<LittleEndian>(self.style_count)?;
                w.write_u32::<LittleEndian>(self.flags)?;
                w.write_u32::<LittleEndian>(self.strings_start)?;
                w.write_u32::<LittleEndian>(self.styles_start)?;
                Ok(())
            }

            pub fn is_utf8(&self) -> bool {
                self.flags & Self::UTF8_FLAG > 0
            }
        }

        #[derive(Clone, Copy, Debug, Eq, PartialEq)]
        pub struct ResTableHeader {
            pub package_count: u32,
        }

        impl ResTableHeader {
            pub fn read(r: &mut impl Read) -> Result<Self> {
                let package_count = r.read_u32::<LittleEndian>()?;
                Ok(Self { package_count })
            }

            pub fn write(&self, w: &mut impl Write) -> Result<()> {
                w.write_u32::<LittleEndian>(self.package_count)?;
                Ok(())
            }
        }

        #[derive(Clone, Copy, Debug, Eq, PartialEq)]
        pub struct ResXmlNodeHeader {
            pub line_number: u32,
            pub comment: i32,
        }

        impl ResXmlNodeHeader {
            pub fn read(r: &mut impl Read) -> Result<Self> {
                let _line_number = r.read_u32::<LittleEndian>()?;
                let _comment = r.read_i32::<LittleEndian>()?;
                Ok(Self {
                    line_number: 1,
                    comment: -1,
                })
            }

            pub fn write(&self, w: &mut impl Write) -> Result<()> {
                w.write_u32::<LittleEndian>(self.line_number)?;
                w.write_i32::<LittleEndian>(self.comment)?;
                Ok(())
            }
        }

        impl Default for ResXmlNodeHeader {
            fn default() -> Self {
                Self {
                    line_number: 1,
                    comment: -1,
                }
            }
        }

        #[derive(Clone, Copy, Debug, Eq, PartialEq)]
        pub struct ResXmlNamespace {
            pub prefix: i32,
            pub uri: i32,
        }

        impl ResXmlNamespace {
            pub fn read(r: &mut impl Read) -> Result<Self> {
                let prefix = r.read_i32::<LittleEndian>()?;
                let uri = r.read_i32::<LittleEndian>()?;
                Ok(Self { prefix, uri })
            }

            pub fn write(&self, w: &mut impl Write) -> Result<()> {
                w.write_i32::<LittleEndian>(self.prefix)?;
                w.write_i32::<LittleEndian>(self.uri)?;
                Ok(())
            }
        }

        #[derive(Clone, Copy, Debug, Eq, PartialEq)]
        pub struct ResXmlStartElement {
            /// String of the full namespace of this element.
            pub namespace: i32,
            /// String name of this node if it is an ELEMENT; the raw
            /// character data if this is a CDATA node.
            pub name: i32,
            /// Byte offset from the start of this structure to where
            /// the attributes start.
            pub attribute_start: u16,
            /// Size of the attribute structures that follow.
            pub attribute_size: u16,
            /// Number of attributes associated with an ELEMENT. These are
            /// available as an array of ResXmlAttribute structures
            /// immediately following this node.
            pub attribute_count: u16,
            /// Index (1-based) of the "id" attribute. 0 if none.
            pub id_index: u16,
            /// Index (1-based) of the "class" attribute. 0 if none.
            pub class_index: u16,
            /// Index (1-based) of the "style" attribute. 0 if none.
            pub style_index: u16,
        }

        impl Default for ResXmlStartElement {
            fn default() -> Self {
                Self {
                    namespace: -1,
                    name: -1,
                    attribute_start: 0x0014,
                    attribute_size: 0x0014,
                    attribute_count: 0,
                    id_index: 0,
                    class_index: 0,
                    style_index: 0,
                }
            }
        }

        impl ResXmlStartElement {
            pub fn read(r: &mut impl Read) -> Result<Self> {
                let namespace = r.read_i32::<LittleEndian>()?;
                let name = r.read_i32::<LittleEndian>()?;
                let attribute_start = r.read_u16::<LittleEndian>()?;
                let attribute_size = r.read_u16::<LittleEndian>()?;
                let attribute_count = r.read_u16::<LittleEndian>()?;
                let id_index = r.read_u16::<LittleEndian>()?;
                let class_index = r.read_u16::<LittleEndian>()?;
                let style_index = r.read_u16::<LittleEndian>()?;
                Ok(Self {
                    namespace,
                    name,
                    attribute_start,
                    attribute_size,
                    attribute_count,
                    id_index,
                    class_index,
                    style_index,
                })
            }

            pub fn write(&self, w: &mut impl Write) -> Result<()> {
                w.write_i32::<LittleEndian>(self.namespace)?;
                w.write_i32::<LittleEndian>(self.name)?;
                w.write_u16::<LittleEndian>(self.attribute_start)?;
                w.write_u16::<LittleEndian>(self.attribute_size)?;
                w.write_u16::<LittleEndian>(self.attribute_count)?;
                w.write_u16::<LittleEndian>(self.id_index)?;
                w.write_u16::<LittleEndian>(self.class_index)?;
                w.write_u16::<LittleEndian>(self.style_index)?;
                Ok(())
            }
        }

        #[derive(Clone, Copy, Debug, Eq, PartialEq)]
        pub struct ResXmlAttribute {
            pub namespace: i32,
            pub name: i32,
            pub raw_value: i32,
            pub typed_value: ResValue,
        }

        impl ResXmlAttribute {
            pub fn read(r: &mut impl Read) -> Result<Self> {
                let namespace = r.read_i32::<LittleEndian>()?;
                let name = r.read_i32::<LittleEndian>()?;
                let raw_value = r.read_i32::<LittleEndian>()?;
                let typed_value = ResValue::read(r)?;
                Ok(Self {
                    namespace,
                    name,
                    raw_value,
                    typed_value,
                })
            }

            pub fn write(&self, w: &mut impl Write) -> Result<()> {
                w.write_i32::<LittleEndian>(self.namespace)?;
                w.write_i32::<LittleEndian>(self.name)?;
                w.write_i32::<LittleEndian>(self.raw_value)?;
                self.typed_value.write(w)?;
                Ok(())
            }
        }

        #[derive(Clone, Copy, Debug, Eq, PartialEq)]
        pub struct ResXmlEndElement {
            pub namespace: i32,
            pub name: i32,
        }

        impl ResXmlEndElement {
            pub fn read(r: &mut impl Read) -> Result<Self> {
                let namespace = r.read_i32::<LittleEndian>()?;
                let name = r.read_i32::<LittleEndian>()?;
                Ok(Self { namespace, name })
            }

            pub fn write(&self, w: &mut impl Write) -> Result<()> {
                w.write_i32::<LittleEndian>(self.namespace)?;
                w.write_i32::<LittleEndian>(self.name)?;
                Ok(())
            }
        }

        #[derive(Clone, Copy, Debug, Eq, PartialEq)]
        pub struct ResTableRef(u32);

        impl ResTableRef {
            pub fn new(package: u8, ty: u8, entry: u16) -> Self {
                let package = (package as u32) << 24;
                let ty = (ty as u32) << 16;
                let entry = entry as u32;
                Self(package | ty | entry)
            }

            pub fn package(self) -> u8 {
                (self.0 >> 24) as u8
            }

            pub fn ty(self) -> u8 {
                (self.0 >> 16) as u8
            }

            pub fn entry(self) -> u16 {
                self.0 as u16
            }
        }

        impl From<u32> for ResTableRef {
            fn from(r: u32) -> Self {
                Self(r)
            }
        }

        impl From<ResTableRef> for u32 {
            fn from(r: ResTableRef) -> u32 {
                r.0
            }
        }

        impl std::fmt::Display for ResTableRef {
            fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                write!(f, "{}", self.0)
            }
        }

        #[derive(Clone, Debug, Eq, PartialEq)]
        pub struct ResTablePackageHeader {
            /// If this is a base package, its ID. Package IDs start
            /// at 1 (corresponding to the value of the package bits in a
            /// resource identifier). 0 means this is not a base package.
            pub id: u32,
            /// Actual name of this package, \0-terminated.
            pub name: String,
            /// Offset to a ResStringPoolHeader defining the resource
            /// type symbol table. If zero, this package is inheriting
            /// from another base package (overriding specific values in it).
            pub type_strings: u32,
            /// Last index into type_strings that is for public use by others.
            pub last_public_type: u32,
            /// Offset to a ResStringPoolHeader defining the resource key
            /// symbol table. If zero, this package is inheriting from another
            /// base package (overriding specific values in it).
            pub key_strings: u32,
            /// Last index into key_strings that is for public use by others.
            pub last_public_key: u32,
            pub type_id_offset: u32,
        }

        impl ResTablePackageHeader {
            pub fn read<R: Read + Seek>(r: &mut R) -> Result<Self> {
                let id = r.read_u32::<LittleEndian>()?;
                let mut name = [0; 128];
                let mut name_len = 0xff;
                for (i, item) in name.iter_mut().enumerate() {
                    let c = r.read_u16::<LittleEndian>()?;
                    if name_len < 128 {
                        continue;
                    }
                    if c == 0 {
                        name_len = i;
                    } else {
                        *item = c;
                    }
                }
                let name = String::from_utf16(&name[..name_len])?;
                let type_strings = r.read_u32::<LittleEndian>()?;
                let last_public_type = r.read_u32::<LittleEndian>()?;
                let key_strings = r.read_u32::<LittleEndian>()?;
                let last_public_key = r.read_u32::<LittleEndian>()?;
                let type_id_offset = r.read_u32::<LittleEndian>()?;
                Ok(Self {
                    id,
                    name,
                    type_strings,
                    last_public_type,
                    key_strings,
                    last_public_key,
                    type_id_offset,
                })
            }

            pub fn write(&self, w: &mut impl Write) -> Result<()> {
                w.write_u32::<LittleEndian>(self.id)?;
                let mut name = [0; 128];
                for (i, c) in self.name.encode_utf16().enumerate() {
                    name[i] = c;
                }
                for c in name {
                    w.write_u16::<LittleEndian>(c)?;
                }
                w.write_u32::<LittleEndian>(self.type_strings)?;
                w.write_u32::<LittleEndian>(self.last_public_type)?;
                w.write_u32::<LittleEndian>(self.key_strings)?;
                w.write_u32::<LittleEndian>(self.last_public_key)?;
                w.write_u32::<LittleEndian>(self.type_id_offset)?;
                Ok(())
            }
        }

        #[derive(Clone, Copy, Debug, Eq, PartialEq)]
        pub struct ResTableTypeSpecHeader {
            /// The type identifier this chunk is holding. Type IDs start
            /// at 1 (corresponding to the value of the type bits in a
            /// resource identifier). 0 is invalid.
            pub id: u8,
            /// Must be 0.
            pub res0: u8,
            /// Must be 0.
            pub res1: u16,
            /// Number of u32 entry configuration masks that follow.
            pub entry_count: u32,
        }

        impl ResTableTypeSpecHeader {
            pub fn read(r: &mut impl Read) -> Result<Self> {
                let id = r.read_u8()?;
                let res0 = r.read_u8()?;
                let res1 = r.read_u16::<LittleEndian>()?;
                let entry_count = r.read_u32::<LittleEndian>()?;
                Ok(Self {
                    id,
                    res0,
                    res1,
                    entry_count,
                })
            }

            pub fn write(&self, w: &mut impl Write) -> Result<()> {
                w.write_u8(self.id)?;
                w.write_u8(self.res0)?;
                w.write_u16::<LittleEndian>(self.res1)?;
                w.write_u32::<LittleEndian>(self.entry_count)?;
                Ok(())
            }
        }

        #[derive(Clone, Debug, Eq, PartialEq)]
        pub struct ResTableTypeHeader {
            /// The type identifier this chunk is holding. Type IDs start
            /// at 1 (corresponding to the value of the type bits in a
            /// resource identifier). 0 is invalid.
            pub id: u8,
            /// Must be 0.
            pub res0: u8,
            /// Must be 0.
            pub res1: u16,
            /// Number of u32 entry indices that follow.
            pub entry_count: u32,
            /// Offset from header where ResTableEntry data starts.
            pub entries_start: u32,
            /// Configuration this collection of entries is designed for.
            pub config: ResTableConfig,
        }

        impl ResTableTypeHeader {
            pub fn read(r: &mut impl Read) -> Result<Self> {
                let id = r.read_u8()?;
                let res0 = r.read_u8()?;
                let res1 = r.read_u16::<LittleEndian>()?;
                let entry_count = r.read_u32::<LittleEndian>()?;
                let entries_start = r.read_u32::<LittleEndian>()?;
                let config = ResTableConfig::read(r)?;
                Ok(Self {
                    id,
                    res0,
                    res1,
                    entry_count,
                    entries_start,
                    config,
                })
            }

            pub fn write(&self, w: &mut impl Write) -> Result<()> {
                w.write_u8(self.id)?;
                w.write_u8(self.res0)?;
                w.write_u16::<LittleEndian>(self.res1)?;
                w.write_u32::<LittleEndian>(self.entry_count)?;
                w.write_u32::<LittleEndian>(self.entries_start)?;
                self.config.write(w)?;
                Ok(())
            }
        }

        #[derive(Clone, Debug, Eq, PartialEq)]
        pub struct ResTableConfig {
            pub size: u32,
            pub imsi: u32,
            pub locale: u32,
            pub screen_type: ScreenType,
            pub input: u32,
            pub screen_size: u32,
            pub version: u32,
            pub unknown: Vec<u8>,
        }

        impl ResTableConfig {
            pub fn read(r: &mut impl Read) -> Result<Self> {
                let size = r.read_u32::<LittleEndian>()?;
                let imsi = r.read_u32::<LittleEndian>()?;
                let locale = r.read_u32::<LittleEndian>()?;
                let screen_type = ScreenType::read(r)?;
                let input = r.read_u32::<LittleEndian>()?;
                let screen_size = r.read_u32::<LittleEndian>()?;
                let version = r.read_u32::<LittleEndian>()?;
                let unknown_len = size as usize - 28;
                let mut unknown = vec![0; unknown_len];
                r.read_exact(&mut unknown)?;
                Ok(Self {
                    size,
                    imsi,
                    locale,
                    screen_type,
                    input,
                    screen_size,
                    version,
                    unknown,
                })
            }

            pub fn write(&self, w: &mut impl Write) -> Result<()> {
                w.write_u32::<LittleEndian>(self.size)?;
                w.write_u32::<LittleEndian>(self.imsi)?;
                w.write_u32::<LittleEndian>(self.locale)?;
                self.screen_type.write(w)?;
                w.write_u32::<LittleEndian>(self.input)?;
                w.write_u32::<LittleEndian>(self.screen_size)?;
                w.write_u32::<LittleEndian>(self.version)?;
                w.write_all(&self.unknown)?;
                Ok(())
            }
        }

        #[derive(Clone, Copy, Debug, Eq, PartialEq)]
        pub struct ScreenType {
            pub orientation: u8,
            pub touchscreen: u8,
            pub density: u16,
        }

        impl ScreenType {
            pub fn read(r: &mut impl Read) -> Result<Self> {
                let orientation = r.read_u8()?;
                let touchscreen = r.read_u8()?;
                let density = r.read_u16::<LittleEndian>()?;
                Ok(Self {
                    orientation,
                    touchscreen,
                    density,
                })
            }

            pub fn write(&self, w: &mut impl Write) -> Result<()> {
                w.write_u8(self.orientation)?;
                w.write_u8(self.touchscreen)?;
                w.write_u16::<LittleEndian>(self.density)?;
                Ok(())
            }
        }

        #[derive(Clone, Debug, Eq, PartialEq)]
        pub struct ResTableEntry {
            pub size: u16,
            pub flags: u16,
            pub key: u32,
            pub value: ResTableValue,
        }

        impl ResTableEntry {
            pub fn is_complex(&self) -> bool {
                self.flags & 0x1 > 0
            }

            pub fn is_public(&self) -> bool {
                self.flags & 0x2 > 0
            }

            pub fn read(r: &mut impl Read) -> Result<Self> {
                let size = r.read_u16::<LittleEndian>()?;
                let flags = r.read_u16::<LittleEndian>()?;
                let key = r.read_u32::<LittleEndian>()?;
                let is_complex = flags & 0x1 > 0;
                let value = if is_complex {
                    if size < 16 {
                        anyhow::bail!("invalid ResTableEntry size: {size}");
                    }
                    let entry = ResTableMapEntry::read(r)?;
                    if size > 16 {
                        let mut extra = vec![0; (size - 16) as usize];
                        r.read_exact(&mut extra)?;
                    }
                    let mut map = Vec::with_capacity(entry.count as usize);
                    for _ in 0..entry.count {
                        map.push(ResTableMap::read(r)?);
                    }
                    ResTableValue::Complex(entry, map)
                } else {
                    if size < 8 {
                        anyhow::bail!("invalid ResTableEntry size: {size}");
                    }
                    if size > 8 {
                        let mut extra = vec![0; (size - 8) as usize];
                        r.read_exact(&mut extra)?;
                    }
                    ResTableValue::Simple(ResValue::read(r)?)
                };
                Ok(Self {
                    size,
                    flags,
                    key,
                    value,
                })
            }

            pub fn write(&self, w: &mut impl Write) -> Result<()> {
                w.write_u16::<LittleEndian>(self.size)?;
                w.write_u16::<LittleEndian>(self.flags)?;
                w.write_u32::<LittleEndian>(self.key)?;
                self.value.write(w)?;
                Ok(())
            }
        }

        #[derive(Clone, Debug, Eq, PartialEq)]
        pub enum ResTableValue {
            Simple(ResValue),
            Complex(ResTableMapEntry, Vec<ResTableMap>),
        }

        impl ResTableValue {
            pub fn read(r: &mut impl Read, is_complex: bool) -> Result<Self> {
                let res = if is_complex {
                    let entry = ResTableMapEntry::read(r)?;
                    let mut map = Vec::with_capacity(entry.count as usize);
                    for _ in 0..entry.count {
                        map.push(ResTableMap::read(r)?);
                    }
                    Self::Complex(entry, map)
                } else {
                    Self::Simple(ResValue::read(r)?)
                };
                Ok(res)
            }

            pub fn write(&self, w: &mut impl Write) -> Result<()> {
                match self {
                    Self::Simple(value) => value.write(w)?,
                    Self::Complex(entry, map) => {
                        entry.write(w)?;
                        for entry in map {
                            entry.write(w)?;
                        }
                    }
                }
                Ok(())
            }
        }

        #[derive(Clone, Copy, Debug, Eq, PartialEq)]
        pub struct ResValue {
            pub size: u16,
            pub res0: u8,
            pub data_type: u8,
            pub data: u32,
        }

        impl ResValue {
            pub fn read(r: &mut impl Read) -> Result<Self> {
                let size = r.read_u16::<LittleEndian>()?;
                let res0 = r.read_u8()?;
                let data_type = r.read_u8()?;
                let data = r.read_u32::<LittleEndian>()?;
                if size > 8 {
                    let mut extra = vec![0; (size - 8) as usize];
                    r.read_exact(&mut extra)?;
                }
                Ok(Self {
                    size,
                    res0,
                    data_type,
                    data,
                })
            }

            pub fn write(&self, w: &mut impl Write) -> Result<()> {
                w.write_u16::<LittleEndian>(self.size)?;
                w.write_u8(self.res0)?;
                w.write_u8(self.data_type)?;
                w.write_u32::<LittleEndian>(self.data)?;
                Ok(())
            }
        }

        #[derive(Clone, Copy, Debug, Eq, PartialEq)]
        #[repr(u8)]
        pub enum ResValueType {
            Null = 0x00,
            Reference = 0x01,
            Attribute = 0x02,
            String = 0x03,
            Float = 0x04,
            Dimension = 0x05,
            Fraction = 0x06,
            IntDec = 0x10,
            IntHex = 0x11,
            IntBoolean = 0x12,
            IntColorArgb8 = 0x1c,
            IntColorRgb8 = 0x1d,
            IntColorArgb4 = 0x1e,
            IntColorRgb4 = 0x1f,
        }

        impl ResValueType {
            pub fn from_u8(ty: u8) -> Option<Self> {
                Some(match ty {
                    x if x == Self::Null as u8 => Self::Null,
                    x if x == Self::Reference as u8 => Self::Reference,
                    x if x == Self::Attribute as u8 => Self::Attribute,
                    x if x == Self::String as u8 => Self::String,
                    x if x == Self::Float as u8 => Self::Float,
                    x if x == Self::Dimension as u8 => Self::Dimension,
                    x if x == Self::Fraction as u8 => Self::Fraction,
                    x if x == Self::IntDec as u8 => Self::IntDec,
                    x if x == Self::IntHex as u8 => Self::IntHex,
                    x if x == Self::IntBoolean as u8 => Self::IntBoolean,
                    x if x == Self::IntColorArgb8 as u8 => Self::IntColorArgb8,
                    x if x == Self::IntColorRgb8 as u8 => Self::IntColorRgb8,
                    x if x == Self::IntColorArgb4 as u8 => Self::IntColorArgb4,
                    x if x == Self::IntColorRgb4 as u8 => Self::IntColorRgb4,
                    _ => return None,
                })
            }
        }

        #[derive(Clone, Copy, Debug, Eq, PartialEq)]
        #[repr(u32)]
        pub enum ResAttributeType {
            Any = 0x0000_ffff,
            Reference = 1 << 0,
            String = 1 << 1,
            Integer = 1 << 2,
            Boolean = 1 << 3,
            Color = 1 << 4,
            Float = 1 << 5,
            Dimension = 1 << 6,
            Fraction = 1 << 7,
            Enum = 1 << 16,
            Flags = 1 << 17,
        }

        impl ResAttributeType {
            pub fn from_u32(ty: u32) -> Option<Self> {
                Some(match ty {
                    x if x == Self::Any as u32 => Self::Any,
                    x if x == Self::Reference as u32 => Self::Reference,
                    x if x == Self::String as u32 => Self::String,
                    x if x == Self::Integer as u32 => Self::Integer,
                    x if x == Self::Boolean as u32 => Self::Boolean,
                    x if x == Self::Color as u32 => Self::Color,
                    x if x == Self::Float as u32 => Self::Float,
                    x if x == Self::Dimension as u32 => Self::Dimension,
                    x if x == Self::Fraction as u32 => Self::Fraction,
                    x if x == Self::Enum as u32 => Self::Enum,
                    x if x == Self::Flags as u32 => Self::Flags,
                    _ => return None,
                })
            }
        }

        #[derive(Clone, Copy, Debug, Eq, PartialEq)]
        pub struct ResTableMapEntry {
            pub parent: u32,
            pub count: u32,
        }

        impl ResTableMapEntry {
            pub fn read(r: &mut impl Read) -> Result<Self> {
                let parent = r.read_u32::<LittleEndian>()?;
                let count = r.read_u32::<LittleEndian>()?;
                Ok(Self { parent, count })
            }

            pub fn write(&self, w: &mut impl Write) -> Result<()> {
                w.write_u32::<LittleEndian>(self.parent)?;
                w.write_u32::<LittleEndian>(self.count)?;
                Ok(())
            }
        }

        #[derive(Clone, Copy, Debug, Eq, PartialEq)]
        pub struct ResTableMap {
            pub name: u32,
            pub value: ResValue,
        }

        impl ResTableMap {
            pub fn read(r: &mut impl Read) -> Result<Self> {
                let name = r.read_u32::<LittleEndian>()?;
                let value = ResValue::read(r)?;
                Ok(Self { name, value })
            }

            pub fn write(&self, w: &mut impl Write) -> Result<()> {
                w.write_u32::<LittleEndian>(self.name)?;
                self.value.write(w)?;
                Ok(())
            }
        }

        #[derive(Clone, Copy, Debug, Eq, PartialEq)]
        pub struct ResSpan {
            pub name: i32,
            pub first_char: u32,
            pub last_char: u32,
        }

        impl ResSpan {
            pub fn read(r: &mut impl Read) -> Result<Option<Self>> {
                let name = r.read_i32::<LittleEndian>()?;
                if name == -1 {
                    return Ok(None);
                }
                let first_char = r.read_u32::<LittleEndian>()?;
                let last_char = r.read_u32::<LittleEndian>()?;
                Ok(Some(Self {
                    name,
                    first_char,
                    last_char,
                }))
            }

            pub fn write(&self, w: &mut impl Write) -> Result<()> {
                w.write_i32::<LittleEndian>(self.name)?;
                w.write_u32::<LittleEndian>(self.first_char)?;
                w.write_u32::<LittleEndian>(self.last_char)?;
                Ok(())
            }
        }

        #[derive(Clone, Debug, Eq, PartialEq)]
        pub enum Chunk {
            Null,
            StringPool(Vec<String>, Vec<Vec<ResSpan>>),
            Table(ResTableHeader, Vec<Chunk>),
            Xml(Vec<Chunk>),
            XmlStartNamespace(ResXmlNodeHeader, ResXmlNamespace),
            XmlEndNamespace(ResXmlNodeHeader, ResXmlNamespace),
            XmlStartElement(ResXmlNodeHeader, ResXmlStartElement, Vec<ResXmlAttribute>),
            XmlEndElement(ResXmlNodeHeader, ResXmlEndElement),
            XmlResourceMap(Vec<u32>),
            TablePackage(ResTablePackageHeader, Vec<Chunk>),
            TableType(ResTableTypeHeader, Vec<u32>, Vec<Option<ResTableEntry>>),
            TableTypeSpec(ResTableTypeSpecHeader, Vec<u32>),
            Unknown,
        }

        impl Chunk {
            pub fn parse<R: Read + Seek>(r: &mut R) -> Result<Self> {
                let start_pos = r.stream_position()?;
                let header = ResChunkHeader::read(r)?;
                let end_pos = start_pos + header.size as u64;
                match ChunkType::from_u16(header.ty) {
                    Some(ChunkType::Null) => {
                        tracing::trace!("null");
                        Ok(Chunk::Null)
                    }
                    Some(ChunkType::StringPool) => {
                        tracing::trace!("string pool");
                        let string_pool_header = ResStringPoolHeader::read(r)?;
                        let count = string_pool_header.string_count as i64
                            + string_pool_header.style_count as i64;
                        r.seek(SeekFrom::Current(count * 4))?;
                        /*let mut string_indices = Vec::with_capacity(string_pool_header.string_count);
                        for _ in 0..string_pool_header.string_count {
                            string_indices.push(r.read_u32::<LittleEndian>()?);
                        }
                        let mut style_indices = Vec::with_capacity(string_pool_header.style_count);
                        for _ in 0..string_pool_header.style_count {
                            style_indices.push(r.read_u32::<LittleEndian>()?);
                        }*/
                        let mut strings =
                            Vec::with_capacity(string_pool_header.string_count as usize);
                        for _ in 0..string_pool_header.string_count {
                            if string_pool_header.is_utf8() {
                                let charsh = r.read_u8()? as u16;
                                let _chars = if charsh > 0x7f {
                                    charsh & 0x7f | r.read_u8()? as u16
                                } else {
                                    charsh
                                };
                                let bytesh = r.read_u8()? as u16;
                                let bytes = if bytesh > 0x7f {
                                    bytesh & 0x7f | r.read_u8()? as u16
                                } else {
                                    bytesh
                                };
                                let mut buf = vec![0; bytes as usize];
                                r.read_exact(&mut buf)?;
                                // some times there is an invalid string?
                                let s = String::from_utf8(buf).unwrap_or_default();
                                strings.push(s);
                                if r.read_u8()? != 0 {
                                    // fails to read some files otherwise
                                    r.seek(SeekFrom::Start(end_pos))?;
                                }
                            } else {
                                let charsh = r.read_u16::<LittleEndian>()? as u32;
                                let chars = if charsh > 0x7fff {
                                    charsh & 0x7fff | r.read_u16::<LittleEndian>()? as u32
                                } else {
                                    charsh
                                };
                                let mut buf = Vec::with_capacity(chars as usize * 2);
                                loop {
                                    let code = r.read_u16::<LittleEndian>()?;
                                    if code != 0 {
                                        buf.push(code);
                                    } else {
                                        break;
                                    }
                                }
                                let s = String::from_utf16(buf.as_slice())?;
                                strings.push(s);
                            }
                        }
                        let pos = r.stream_position()? as i64;
                        if pos % 4 != 0 {
                            r.seek(SeekFrom::Current(4 - pos % 4))?;
                        }
                        let mut styles =
                            Vec::with_capacity(string_pool_header.style_count as usize);
                        for _ in 0..string_pool_header.style_count {
                            let mut spans = vec![];
                            while let Some(span) = ResSpan::read(r)? {
                                spans.push(span);
                            }
                            styles.push(spans);
                        }
                        // FIXME: skip some unparsable parts
                        r.seek(SeekFrom::Start(end_pos))?;
                        Ok(Chunk::StringPool(strings, styles))
                    }
                    Some(ChunkType::Table) => {
                        tracing::trace!("table");
                        let table_header = ResTableHeader::read(r)?;
                        let mut chunks = vec![];
                        while r.stream_position()? < end_pos {
                            chunks.push(Chunk::parse(r)?);
                        }
                        Ok(Chunk::Table(table_header, chunks))
                    }
                    Some(ChunkType::Xml) => {
                        tracing::trace!("xml");
                        let mut chunks = vec![];
                        while r.stream_position()? < end_pos {
                            chunks.push(Chunk::parse(r)?);
                        }
                        Ok(Chunk::Xml(chunks))
                    }
                    Some(ChunkType::XmlStartNamespace) => {
                        tracing::trace!("xml start namespace");
                        let node_header = ResXmlNodeHeader::read(r)?;
                        let namespace = ResXmlNamespace::read(r)?;
                        Ok(Chunk::XmlStartNamespace(node_header, namespace))
                    }
                    Some(ChunkType::XmlEndNamespace) => {
                        tracing::trace!("xml end namespace");
                        let node_header = ResXmlNodeHeader::read(r)?;
                        let namespace = ResXmlNamespace::read(r)?;
                        Ok(Chunk::XmlEndNamespace(node_header, namespace))
                    }
                    Some(ChunkType::XmlStartElement) => {
                        tracing::trace!("xml start element");
                        let node_header = ResXmlNodeHeader::read(r)?;
                        let start_element = ResXmlStartElement::read(r)?;
                        let mut attributes =
                            Vec::with_capacity(start_element.attribute_count as usize);
                        for _ in 0..start_element.attribute_count {
                            attributes.push(ResXmlAttribute::read(r)?);
                        }
                        Ok(Chunk::XmlStartElement(
                            node_header,
                            start_element,
                            attributes,
                        ))
                    }
                    Some(ChunkType::XmlEndElement) => {
                        tracing::trace!("xml end element");
                        let node_header = ResXmlNodeHeader::read(r)?;
                        let end_element = ResXmlEndElement::read(r)?;
                        Ok(Chunk::XmlEndElement(node_header, end_element))
                    }
                    Some(ChunkType::XmlResourceMap) => {
                        tracing::trace!("xml resource map");
                        let mut resource_map = Vec::with_capacity(
                            (header.size as usize - header.header_size as usize) / 4,
                        );
                        for _ in 0..resource_map.capacity() {
                            resource_map.push(r.read_u32::<LittleEndian>()?);
                        }
                        Ok(Chunk::XmlResourceMap(resource_map))
                    }
                    Some(ChunkType::TablePackage) => {
                        tracing::trace!("table package");
                        let package_header = ResTablePackageHeader::read(r)?;
                        let mut chunks = vec![];
                        while r.stream_position()? < end_pos {
                            chunks.push(Chunk::parse(r)?);
                        }
                        Ok(Chunk::TablePackage(package_header, chunks))
                    }
                    Some(ChunkType::TableType) => {
                        tracing::trace!("table type");
                        let type_header = ResTableTypeHeader::read(r)?;
                        let is_sparse = type_header.res1 & 0x1 != 0;
                        if is_sparse {
                            let entries_base = start_pos + type_header.entries_start as u64;
                            let mut sparse = Vec::with_capacity(type_header.entry_count as usize);
                            for _ in 0..type_header.entry_count {
                                let idx = r.read_u16::<LittleEndian>()?;
                                let offset = r.read_u16::<LittleEndian>()?;
                                sparse.push((idx, offset));
                            }
                            let max_idx = sparse.iter().map(|(idx, _)| *idx).max().unwrap_or(0);
                            let mut entries = vec![None; max_idx as usize + 1];
                            for (idx, offset) in sparse {
                                let entry_pos = entries_base + (offset as u64) * 4;
                                r.seek(SeekFrom::Start(entry_pos))?;
                                let entry = ResTableEntry::read(r)?;
                                entries[idx as usize] = Some(entry);
                            }
                            r.seek(SeekFrom::Start(end_pos))?;
                            Ok(Chunk::TableType(type_header, Vec::new(), entries))
                        } else {
                            let mut index = Vec::with_capacity(type_header.entry_count as usize);
                            let index_table_bytes = type_header
                                .entries_start
                                .saturating_sub(header.header_size as u32);
                            let index_entry_size = if type_header.entry_count == 0 {
                                0
                            } else {
                                index_table_bytes / type_header.entry_count
                            };
                            for _ in 0..type_header.entry_count {
                                if index_entry_size == 2 {
                                    let entry = r.read_u16::<LittleEndian>()?;
                                    if entry == 0xffff {
                                        index.push(0xffff_ffff);
                                    } else {
                                        index.push(u32::from(entry) * 4);
                                    }
                                } else {
                                    let entry = r.read_u32::<LittleEndian>()?;
                                    index.push(entry);
                                }
                            }
                            let entries_base = start_pos + type_header.entries_start as u64;
                            let mut entries = Vec::with_capacity(type_header.entry_count as usize);
                            for offset in &index {
                                if *offset == 0xffff_ffff {
                                    entries.push(None);
                                } else {
                                    let entry_pos = entries_base + *offset as u64;
                                    r.seek(SeekFrom::Start(entry_pos))?;
                                    let entry = ResTableEntry::read(r)?;
                                    entries.push(Some(entry));
                                }
                            }
                            r.seek(SeekFrom::Start(end_pos))?;
                            Ok(Chunk::TableType(type_header, index, entries))
                        }
                    }
                    Some(ChunkType::TableTypeSpec) => {
                        tracing::trace!("table type spec");
                        let type_spec_header = ResTableTypeSpecHeader::read(r)?;
                        let mut type_spec = vec![0; type_spec_header.entry_count as usize];
                        for c in type_spec.iter_mut() {
                            *c = r.read_u32::<LittleEndian>()?;
                        }
                        Ok(Chunk::TableTypeSpec(type_spec_header, type_spec))
                    }
                    Some(ChunkType::Unknown) => {
                        tracing::trace!("unknown");
                        // FIXME: skip some unparsable parts
                        r.seek(SeekFrom::Start(end_pos))?;
                        Ok(Chunk::Unknown)
                    }
                    None => {
                        anyhow::bail!("unrecognized chunk {:?}", header);
                    }
                }
            }

            pub fn write<W: Seek + Write>(&self, w: &mut W) -> Result<()> {
                struct ChunkWriter {
                    ty: ChunkType,
                    start_chunk: u64,
                    end_header: u64,
                }
                impl ChunkWriter {
                    fn start_chunk<W: Seek + Write>(ty: ChunkType, w: &mut W) -> Result<Self> {
                        let start_chunk = w.stream_position()?;
                        ResChunkHeader::default().write(w)?;
                        Ok(Self {
                            ty,
                            start_chunk,
                            end_header: 0,
                        })
                    }

                    fn end_header<W: Seek + Write>(&mut self, w: &mut W) -> Result<()> {
                        self.end_header = w.stream_position()?;
                        Ok(())
                    }

                    fn end_chunk<W: Seek + Write>(self, w: &mut W) -> Result<(u64, u64)> {
                        assert_ne!(self.end_header, 0);
                        let end_chunk = w.stream_position()?;
                        let header = ResChunkHeader {
                            ty: self.ty as u16,
                            header_size: (self.end_header - self.start_chunk) as u16,
                            size: (end_chunk - self.start_chunk) as u32,
                        };
                        w.seek(SeekFrom::Start(self.start_chunk))?;
                        header.write(w)?;
                        w.seek(SeekFrom::Start(end_chunk))?;
                        Ok((self.start_chunk, end_chunk))
                    }
                }
                match self {
                    Chunk::Null => {}
                    Chunk::StringPool(strings, styles) => {
                        let mut chunk = ChunkWriter::start_chunk(ChunkType::StringPool, w)?;
                        ResStringPoolHeader::default().write(w)?;
                        chunk.end_header(w)?;
                        let indices_count = strings.len() + styles.len();
                        let mut indices = Vec::with_capacity(indices_count);
                        for _ in 0..indices_count {
                            w.write_u32::<LittleEndian>(0)?;
                        }
                        let strings_start = w.stream_position()?;
                        for string in strings {
                            indices.push(w.stream_position()? - strings_start);
                            assert!(string.len() < 0x7f);
                            let chars = string.chars().count();
                            w.write_u8(chars as u8)?;
                            w.write_u8(string.len() as u8)?;
                            w.write_all(string.as_bytes())?;
                            w.write_u8(0)?;
                        }
                        while w.stream_position()? % 4 != 0 {
                            w.write_u8(0)?;
                        }
                        let styles_start = w.stream_position()?;
                        for style in styles {
                            indices.push(w.stream_position()? - styles_start);
                            for span in style {
                                span.write(w)?;
                            }
                            w.write_i32::<LittleEndian>(-1)?;
                        }
                        let (start_chunk, end_chunk) = chunk.end_chunk(w)?;

                        w.seek(SeekFrom::Start(start_chunk + 8))?;
                        ResStringPoolHeader {
                            string_count: strings.len() as u32,
                            style_count: styles.len() as u32,
                            flags: ResStringPoolHeader::UTF8_FLAG,
                            strings_start: (strings_start - start_chunk) as u32,
                            styles_start: (styles_start - start_chunk) as u32,
                        }
                        .write(w)?;
                        for index in indices {
                            w.write_u32::<LittleEndian>(index as u32)?;
                        }
                        w.seek(SeekFrom::Start(end_chunk))?;
                    }
                    Chunk::Table(table_header, chunks) => {
                        let mut chunk = ChunkWriter::start_chunk(ChunkType::Table, w)?;
                        table_header.write(w)?;
                        chunk.end_header(w)?;
                        for chunk in chunks {
                            chunk.write(w)?;
                        }
                        chunk.end_chunk(w)?;
                    }
                    Chunk::Xml(chunks) => {
                        let mut chunk = ChunkWriter::start_chunk(ChunkType::Xml, w)?;
                        chunk.end_header(w)?;
                        for chunk in chunks {
                            chunk.write(w)?;
                        }
                        chunk.end_chunk(w)?;
                    }
                    Chunk::XmlStartNamespace(node_header, namespace) => {
                        let mut chunk = ChunkWriter::start_chunk(ChunkType::XmlStartNamespace, w)?;
                        node_header.write(w)?;
                        chunk.end_header(w)?;
                        namespace.write(w)?;
                        chunk.end_chunk(w)?;
                    }
                    Chunk::XmlEndNamespace(node_header, namespace) => {
                        let mut chunk = ChunkWriter::start_chunk(ChunkType::XmlEndNamespace, w)?;
                        node_header.write(w)?;
                        chunk.end_header(w)?;
                        namespace.write(w)?;
                        chunk.end_chunk(w)?;
                    }
                    Chunk::XmlStartElement(node_header, start_element, attributes) => {
                        let mut chunk = ChunkWriter::start_chunk(ChunkType::XmlStartElement, w)?;
                        node_header.write(w)?;
                        chunk.end_header(w)?;
                        start_element.write(w)?;
                        for attr in attributes {
                            attr.write(w)?;
                        }
                        chunk.end_chunk(w)?;
                    }
                    Chunk::XmlEndElement(node_header, end_element) => {
                        let mut chunk = ChunkWriter::start_chunk(ChunkType::XmlEndElement, w)?;
                        node_header.write(w)?;
                        chunk.end_header(w)?;
                        end_element.write(w)?;
                        chunk.end_chunk(w)?;
                    }
                    Chunk::XmlResourceMap(resource_map) => {
                        let mut chunk = ChunkWriter::start_chunk(ChunkType::XmlResourceMap, w)?;
                        chunk.end_header(w)?;
                        for entry in resource_map {
                            w.write_u32::<LittleEndian>(*entry)?;
                        }
                        chunk.end_chunk(w)?;
                    }
                    Chunk::TablePackage(package_header, chunks) => {
                        let package_start = w.stream_position()?;
                        let mut chunk = ChunkWriter::start_chunk(ChunkType::TablePackage, w)?;
                        let mut package_header = package_header.clone();
                        let header_start = w.stream_position()?;
                        package_header.write(w)?;
                        chunk.end_header(w)?;

                        let type_strings_start = w.stream_position()?;
                        package_header.type_strings = (type_strings_start - package_start) as u32;
                        chunks[0].write(w)?;

                        let key_strings_start = w.stream_position()?;
                        package_header.key_strings = (key_strings_start - package_start) as u32;
                        chunks[1].write(w)?;

                        for chunk in &chunks[2..] {
                            chunk.write(w)?;
                        }
                        chunk.end_chunk(w)?;

                        let end = w.stream_position()?;
                        w.seek(SeekFrom::Start(header_start))?;
                        package_header.write(w)?;
                        w.seek(SeekFrom::Start(end))?;
                    }
                    Chunk::TableType(type_header, index, entries) => {
                        let mut chunk = ChunkWriter::start_chunk(ChunkType::TableType, w)?;
                        type_header.write(w)?;
                        chunk.end_header(w)?;
                        for offset in index {
                            w.write_u32::<LittleEndian>(*offset)?;
                        }
                        for entry in entries.iter().flatten() {
                            entry.write(w)?;
                        }
                        chunk.end_chunk(w)?;
                    }
                    Chunk::TableTypeSpec(type_spec_header, type_spec) => {
                        let mut chunk = ChunkWriter::start_chunk(ChunkType::TableTypeSpec, w)?;
                        type_spec_header.write(w)?;
                        chunk.end_header(w)?;
                        for spec in type_spec {
                            w.write_u32::<LittleEndian>(*spec)?;
                        }
                        chunk.end_chunk(w)?;
                    }
                    Chunk::Unknown => {}
                }
                Ok(())
            }
        }
    }

    mod utils {
        use anyhow::{Context, Result};

        #[derive(Clone, Copy, Debug, Eq, PartialEq)]
        #[repr(u8)]
        pub enum Target {
            ArmV7a = 1,
            Arm64V8a = 2,
            X86 = 3,
            X86_64 = 4,
        }

        impl Target {
            /// Identifier used in the NDK to refer to the ABI
            pub fn as_str(self) -> &'static str {
                match self {
                    Self::Arm64V8a => "arm64-v8a",
                    Self::ArmV7a => "armeabi-v7a",
                    Self::X86 => "x86",
                    Self::X86_64 => "x86_64",
                }
            }
        }

        #[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
        pub struct VersionCode {
            major: u8,
            minor: u8,
            patch: u8,
        }

        impl VersionCode {
            pub fn new(major: u8, minor: u8, patch: u8) -> Self {
                Self {
                    major,
                    minor,
                    patch,
                }
            }

            pub fn from_semver(version: &str) -> Result<Self> {
                let mut iter = version.split(|c1| ['.', '-', '+'].iter().any(|c2| c1 == *c2));
                let mut p = || {
                    iter.next()
                        .context("invalid semver")?
                        .parse()
                        .map_err(|_| anyhow::anyhow!("invalid semver"))
                };
                Ok(Self::new(p()?, p()?, p()?))
            }

            pub fn to_code(&self, apk_id: u8) -> u32 {
                (apk_id as u32) << 24
                    | (self.major as u32) << 16
                    | (self.minor as u32) << 8
                    | self.patch as u32
            }
        }
    }

    mod sign {
        use super::{Signer, ZipInfo};
        use anyhow::Result;
        use byteorder::{LittleEndian, ReadBytesExt, WriteBytesExt};
        use rasn_pkix::Certificate;
        use rsa::pkcs8::{DecodePublicKey, EncodePublicKey};
        use rsa::{PaddingScheme, PublicKey, RsaPublicKey};
        use sha2::{Digest as _, Sha256};
        use std::fs::File;
        use std::io::{BufReader, Cursor, Read, Seek, SeekFrom, Write};
        use std::path::Path;

        const DEBUG_PEM: &str = r#"-----BEGIN CERTIFICATE-----
    MIIDeTCCAmGgAwIBAgIUCymsKTowQdR5TEv+vKSVjAWmYBowDQYJKoZIhvcNAQEL
    BQAwTDELMAkGA1UEBhMCVVMxEzARBgNVBAgMClNvbWUtU3RhdGUxEDAOBgNVBAoM
    B0FuZHJvaWQxFjAUBgNVBAMMDUFuZHJvaWQgRGVidWcwHhcNMjIwMTI4MTUyNjQ5
    WhcNMzIwMTI2MTUyNjQ5WjBMMQswCQYDVQQGEwJVUzETMBEGA1UECAwKU29tZS1T
    dGF0ZTEQMA4GA1UECgwHQW5kcm9pZDEWMBQGA1UEAwwNQW5kcm9pZCBEZWJ1ZzCC
    ASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBANdFY1F564A3MzuCaTUGluti
    pqLWr1o515BC8o42fIClqBWPcz3Hb4C56A6FLVq50gmFz+mMNGBqrgkT9RKICk+O
    OV8hl0O/DzXM4COdfSdWZ1ZaNkFL1lboIAmfmTckWEymFj67gwqqpPy6dujteIn6
    S28AbdHs2FAr1R+ciMoQ7ijxLSMq/JyYNSu/ldcvdzaevxiYMpcDZ6SMDTNn3eHs
    D9w9iSkupVloUWx7ophdR0U2k2CFH3uEyDHC6L65K8aP+SQaN20IlmWftkwoRyum
    cfzW/b9i77XnaT8PlrX1yjZ2ubeD7c/JyEVj2gd5B+OnkTmC+Mi0I+6Eke5vFVMC
    AwEAAaNTMFEwHQYDVR0OBBYEFFVRccNTaUP2O9T8yrguVH4+CCSWMB8GA1UdIwQY
    MBaAFFVRccNTaUP2O9T8yrguVH4+CCSWMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZI
    hvcNAQELBQADggEBANbpPG3teQt/Z1ALsaIrsXOqpPKqVPCRp3w+hNzl/rleEpgm
    zDIlyrLVDRzQyUFHhl9j1oJKPHzpE/1hy46rOZ509dqGqdfcDCTXjLi1O8JJ54wA
    PdJ0h/8YPzh1md+GibZZYFimnFNoG9i6jQuEb4l5HIZLjJj02u+e4gpTD85LdOvw
    S4jS/30KnuZVcr7TilrgOMMeP6GRzbBJ+/hXcfY2biSAu5pdEht2NV9SSKlIO3DD
    ulXXz0+BJJ+PdVqTpPgHvbXbHktOD58srszwmLHHZJl5IfcBwJO0TNvad5lALBYI
    kdxygt2CwyNOJUVd/nfQJ1O3YiwRkoVJ6on9Mnk=
    -----END CERTIFICATE-----
    -----BEGIN PRIVATE KEY-----
    MIIEvwIBADANBgkqhkiG9w0BAQEFAASCBKkwggSlAgEAAoIBAQDXRWNReeuANzM7
    gmk1BpbrYqai1q9aOdeQQvKONnyApagVj3M9x2+AuegOhS1audIJhc/pjDRgaq4J
    E/USiApPjjlfIZdDvw81zOAjnX0nVmdWWjZBS9ZW6CAJn5k3JFhMphY+u4MKqqT8
    unbo7XiJ+ktvAG3R7NhQK9UfnIjKEO4o8S0jKvycmDUrv5XXL3c2nr8YmDKXA2ek
    jA0zZ93h7A/cPYkpLqVZaFFse6KYXUdFNpNghR97hMgxwui+uSvGj/kkGjdtCJZl
    n7ZMKEcrpnH81v2/Yu+152k/D5a19co2drm3g+3PychFY9oHeQfjp5E5gvjItCPu
    hJHubxVTAgMBAAECggEBAMAD45A0WOy30Bn/vAoRQ6LYDtzm8+hd+bpzDNnvHeS+
    XoxEtT1g3EOND8GL5yWq4/+cfRTL+5gY7/2m8I3EDLZjnScO1lcWX+HUSgVan9zr
    xCcRNp3NoHVKffE3i7nU0HImH2d7aGqmRZ4sUI5562/fc1OipVJ/mX8BagvVW2oo
    RpThTUYC37T/X/kD0U/06pJzWmF3RAAhANk6+Z9VVX1kNsPEMBzoWTmhqb6dxiAc
    Ayce8AslF8E0CmyMQ9HK7GwHCprENS7cIUMPG+vgrO5yFbGkIo4DrNTs2naA4f4S
    iQvpNpGfRAfTdi4gV3YZoxfOOOhAh8A9RsAFrT8t6dECgYEA9hVWXHru1jlY1uiV
    misILoSux+iE25HGqOdHuqF5vR5Ji1Z4iFE1UNAOtKaSbTDm0IccEBpTOkzL8A5f
    BgRJRy+TjdE/ynzPgLLD/QnvGfdYarmr6H1xLKOlUY9vgUP2WAC4Zou9Jf/Ylbpg
    BpfkXw0ebfhu1LGRXDj1sgqXAbsCgYEA3/Iuuq0YZy8msyc0Ap53mQgPjdqE2neo
    xx7JHuXBGvVeCJ+zEzSg/rqWPNN4qpuHCc2ICb1nI5lkxJqimY30Em/Prpp9jMIK
    wpeT/bPfOzITXyAOUIxRGqioTIv+ckyt+2t4x5qU+fWHBqWYTZb7EF3oJuipz9aZ
    IoDwaKxd1UkCgYEArYNKC5daxI5XB+Gjarsg37wKiUZ4N2HIU9wQBZZKAoFSlf74
    qhWopDyvwc0ZvggXF73MmcYWHSt9ONzJP7LSAHGZdwuuERaEMVjbPJY+k26GV2pn
    vlyE6lbRAHtEwj6rek23uAab7ilCDAEIKF39VtAnPp9Hdo1l00MOauVwqHUCgYB9
    FSsuj1ILCBYIiMQPFm3cptjxNXVxBNbbaQGS5WdHZHdCP9joyEOII7WYgdFrEXWK
    byclsYmzI5FaErjxJY2G4rbQYm/vt84ExF8fnGD6Ek0pm6EDMmx2hG+EWckkFFo1
    DOEoM9o0BwSFHOcFp2fRy3HIkbmPYeCkmfotrOC4KQKBgQC0OEniLk9PPhcaHO6/
    Oo2xwWUq+TEN72jW5AV77xpykkAw3T4TeY5w84BZfCjOa4bYsvjvbjtn/DhtoDBj
    TySd4PKKWF9XalNpbXmVQYtPU8huw1iwg+dV5llQG2pksFWDD2rglAEb2TEpwEvL
    hmBjxp0mRtma4r/6hMJJzPdUmQ==
    -----END PRIVATE KEY-----"#;

        const APK_SIGNING_BLOCK_MAGIC: &[u8] = b"APK Sig Block 42";
        const APK_SIGNING_BLOCK_V2_ID: u32 = 0x7109871a;
        const APK_SIGNING_BLOCK_V3_ID: u32 = 0xf05368c0;
        const APK_SIGNING_BLOCK_V4_ID: u32 = 0x42726577;
        const RSA_PKCS1V15_SHA2_256: u32 = 0x0103;
        const MAX_CHUNK_SIZE: usize = 1024 * 1024;

        pub fn verify(path: &Path) -> Result<Vec<Certificate>> {
            let f = File::open(path)?;
            let mut r = BufReader::new(f);
            let sblock = parse_apk_signing_block(&mut r)?;
            let mut sblockv2 = None;
            for block in &sblock.blocks {
                match block.id {
                    APK_SIGNING_BLOCK_V2_ID => {
                        tracing::debug!("v2 signing block");
                        sblockv2 = Some(*block);
                    }
                    APK_SIGNING_BLOCK_V3_ID => {
                        tracing::debug!("v3 signing block");
                    }
                    APK_SIGNING_BLOCK_V4_ID => {
                        tracing::debug!("v4 signing block");
                    }
                    id => {
                        tracing::debug!("unknown signing block 0x{:x}", id);
                    }
                }
            }
            let block = if let Some(block) = sblockv2 {
                r.seek(SeekFrom::Start(block.start))?;
                ApkSignatureBlockV2::read(&mut r)?
            } else {
                anyhow::bail!("no signing block v2 found");
            };
            let zip_hash =
                compute_digest(&mut r, sblock.sb_start, sblock.cd_start, sblock.cde_start)?;
            let mut certificates = vec![];
            for signer in &block.signers {
                anyhow::ensure!(
                    !signer.signatures.is_empty(),
                    "found no signatures in v2 block"
                );
                for sig in &signer.signatures {
                    anyhow::ensure!(
                        sig.algorithm == RSA_PKCS1V15_SHA2_256,
                        "found unsupported signature algorithm 0x{:x}",
                        sig.algorithm
                    );
                    let pubkey = RsaPublicKey::from_public_key_der(&signer.public_key)?;
                    let digest = Sha256::digest(&signer.signed_data);
                    let padding = PaddingScheme::new_pkcs1v15_sign::<sha2::Sha256>();
                    pubkey.verify(padding, &digest, &sig.signature)?;
                }
                let mut r = Cursor::new(&signer.signed_data[..]);
                let signed_data = SignedData::read(&mut r)?;
                anyhow::ensure!(
                    !signed_data.digests.is_empty(),
                    "found no digests in v2 block"
                );
                for digest in &signed_data.digests {
                    anyhow::ensure!(
                        digest.algorithm == RSA_PKCS1V15_SHA2_256,
                        "found unsupported digest algorithm 0x{:x}",
                        digest.algorithm
                    );
                    anyhow::ensure!(
                        digest.digest == zip_hash,
                        "computed hash doesn't match signed hash."
                    );
                }
                for cert in &signed_data.certificates {
                    let cert = rasn::der::decode::<Certificate>(cert)
                        .map_err(|err| anyhow::anyhow!("{}", err))?;
                    certificates.push(cert);
                }
                for attr in &signed_data.additional_attributes {
                    tracing::debug!("v2: additional attribute: 0x{:x} {:?}", attr.0, &attr.1);
                }
            }
            Ok(certificates)
        }

        pub fn sign(path: &Path, signer: Option<Signer>) -> Result<()> {
            let signer = signer
                .map(Ok)
                .unwrap_or_else(|| Signer::new(&normalize_pem(DEBUG_PEM)))?;
            let apk = std::fs::read(path)?;
            let mut r = Cursor::new(&apk);
            let block = parse_apk_signing_block(&mut r)?;
            let zip_hash = compute_digest(&mut r, block.sb_start, block.cd_start, block.cde_start)?;
            let mut nblock = vec![];
            let mut w = Cursor::new(&mut nblock);
            write_apk_signing_block(&mut w, zip_hash, &signer)?;
            let mut f = File::create(path)?;
            f.write_all(&apk[..(block.sb_start as usize)])?;
            f.write_all(&nblock)?;
            let cd_start = f.stream_position()?;
            f.write_all(&apk[(block.cd_start as usize)..(block.cde_start as usize)])?;
            let cde_start = f.stream_position()?;
            f.write_all(&apk[(block.cde_start as usize)..])?;
            f.seek(SeekFrom::Start(cde_start + 16))?;
            f.write_u32::<LittleEndian>(cd_start as u32)?;
            Ok(())
        }

        fn normalize_pem(pem: &str) -> String {
            pem.lines()
                .map(|line| line.trim())
                .collect::<Vec<_>>()
                .join("\n")
        }

        fn compute_digest<R: Read + Seek>(
            r: &mut R,
            sb_start: u64,
            cd_start: u64,
            cde_start: u64,
        ) -> Result<[u8; 32]> {
            let mut chunks = vec![];
            let mut hasher = Sha256::new();
            let mut chunk = vec![0u8; MAX_CHUNK_SIZE];

            // chunk contents
            r.rewind()?;
            let mut pos = 0;
            while pos < sb_start {
                hash_chunk(&mut chunks, r, sb_start, &mut hasher, &mut chunk, &mut pos)?;
            }

            // chunk cd
            let mut pos = r.seek(SeekFrom::Start(cd_start))?;
            while pos < cde_start {
                hash_chunk(&mut chunks, r, cde_start, &mut hasher, &mut chunk, &mut pos)?;
            }

            // chunk cde
            chunk.clear();
            r.read_to_end(&mut chunk)?;
            let mut cursor = Cursor::new(&mut chunk);
            cursor.seek(SeekFrom::Start(16))?;
            cursor.write_u32::<LittleEndian>(sb_start as u32)?;
            hasher.update([0xa5]);
            assert!(chunk.len() <= MAX_CHUNK_SIZE);
            hasher.update((chunk.len() as u32).to_le_bytes());
            hasher.update(chunk);
            chunks.push(hasher.finalize_reset().into());

            // compute root
            hasher.update([0x5a]);
            hasher.update((chunks.len() as u32).to_le_bytes());
            for chunk in &chunks {
                hasher.update(chunk);
            }
            Ok(hasher.finalize().into())
        }

        fn hash_chunk<R: Read + Seek>(
            chunks: &mut Vec<[u8; 32]>,
            r: &mut R,
            size: u64,
            hasher: &mut Sha256,
            buffer: &mut Vec<u8>,
            pos: &mut u64,
        ) -> Result<()> {
            let end = std::cmp::min(*pos + MAX_CHUNK_SIZE as u64, size);
            let len = (end - *pos) as usize;
            buffer.resize(len, 0);
            r.read_exact(buffer).unwrap();
            hasher.update([0xa5]);
            hasher.update((len as u32).to_le_bytes());
            hasher.update(buffer);
            chunks.push(hasher.finalize_reset().into());
            *pos = end;
            Ok(())
        }

        #[derive(Debug, Default)]
        struct Digest {
            pub algorithm: u32,
            pub digest: Vec<u8>,
        }

        impl Digest {
            fn new(hash: [u8; 32]) -> Self {
                Self {
                    algorithm: RSA_PKCS1V15_SHA2_256,
                    digest: hash.to_vec(),
                }
            }

            fn size(&self) -> u32 {
                self.digest.len() as u32 + 12
            }

            fn read(r: &mut impl Read) -> Result<Self> {
                let _digest_size = r.read_u32::<LittleEndian>()?;
                let algorithm = r.read_u32::<LittleEndian>()?;
                let size = r.read_u32::<LittleEndian>()?;
                let mut digest = vec![0; size as usize as _];
                r.read_exact(&mut digest)?;
                Ok(Self { algorithm, digest })
            }

            fn write(&self, w: &mut impl Write) -> Result<()> {
                w.write_u32::<LittleEndian>(self.digest.len() as u32 + 8)?;
                w.write_u32::<LittleEndian>(self.algorithm)?;
                w.write_u32::<LittleEndian>(self.digest.len() as u32)?;
                w.write_all(&self.digest)?;
                Ok(())
            }
        }

        #[derive(Debug, Default)]
        struct SignedData {
            pub digests: Vec<Digest>,
            pub certificates: Vec<Vec<u8>>,
            pub additional_attributes: Vec<(u32, Vec<u8>)>,
        }

        impl SignedData {
            fn new(hash: [u8; 32], signer: &Signer) -> Result<Self> {
                Ok(Self {
                    digests: vec![Digest::new(hash)],
                    certificates: vec![rasn::der::encode(signer.cert())
                        .map_err(|err| anyhow::anyhow!("{}", err))?],
                    additional_attributes: vec![],
                })
            }

            fn read(r: &mut impl Read) -> Result<Self> {
                let mut signed_data = SignedData::default();
                let mut remaining_digests_size = r.read_u32::<LittleEndian>()?;
                while remaining_digests_size > 0 {
                    let digest = Digest::read(r)?;
                    remaining_digests_size -= digest.size();
                    signed_data.digests.push(digest);
                }
                let mut remaining_certificates_size = r.read_u32::<LittleEndian>()?;
                while remaining_certificates_size > 0 {
                    let length = r.read_u32::<LittleEndian>()?;
                    let mut cert = vec![0; length as usize];
                    r.read_exact(&mut cert)?;
                    signed_data.certificates.push(cert);
                    remaining_certificates_size -= length + 4;
                }
                let mut remaining_additional_attributes_size = r.read_u32::<LittleEndian>()?;
                while remaining_additional_attributes_size > 0 {
                    let length = r.read_u32::<LittleEndian>()?;
                    let id = r.read_u32::<LittleEndian>()?;
                    let mut value = vec![0; length as usize - 4];
                    r.read_exact(&mut value)?;
                    signed_data.additional_attributes.push((id, value));
                    remaining_additional_attributes_size -= length + 4;
                }
                Ok(signed_data)
            }

            fn write(&self, w: &mut impl Write) -> Result<()> {
                w.write_u32::<LittleEndian>(self.digests.iter().map(|d| d.size()).sum())?;
                for digest in &self.digests {
                    digest.write(w)?;
                }
                w.write_u32::<LittleEndian>(
                    self.certificates.iter().map(|c| c.len() as u32 + 4).sum(),
                )?;
                for cert in &self.certificates {
                    w.write_u32::<LittleEndian>(cert.len() as u32)?;
                    w.write_all(cert)?;
                }
                w.write_u32::<LittleEndian>(
                    self.additional_attributes
                        .iter()
                        .map(|(_, v)| v.len() as u32 + 8)
                        .sum(),
                )?;
                for (id, value) in &self.additional_attributes {
                    w.write_u32::<LittleEndian>(value.len() as u32 + 4)?;
                    w.write_u32::<LittleEndian>(*id)?;
                    w.write_all(value)?;
                }
                Ok(())
            }
        }

        #[derive(Debug)]
        struct ApkSignatureBlockV2 {
            pub signers: Vec<ApkSigner>,
        }

        #[derive(Debug)]
        struct ApkSigner {
            pub signed_data: Vec<u8>,
            pub signatures: Vec<ApkSignature>,
            pub public_key: Vec<u8>,
        }

        #[derive(Debug)]
        struct ApkSignature {
            pub algorithm: u32,
            pub signature: Vec<u8>,
        }

        impl ApkSignatureBlockV2 {
            fn new(hash: [u8; 32], signer: &Signer) -> Result<Self> {
                let mut signed_data = vec![];
                SignedData::new(hash, signer)?.write(&mut signed_data)?;
                let signature = signer.sign(&signed_data);
                Ok(Self {
                    signers: vec![ApkSigner {
                        signed_data,
                        signatures: vec![ApkSignature {
                            algorithm: RSA_PKCS1V15_SHA2_256,
                            signature,
                        }],
                        public_key: signer.pubkey().to_public_key_der()?.as_ref().to_vec(),
                    }],
                })
            }

            fn read(r: &mut impl Read) -> Result<Self> {
                let mut signers = vec![];
                let mut remaining_size = r.read_u32::<LittleEndian>()? as u64;
                while remaining_size > 0 {
                    let signer_size = r.read_u32::<LittleEndian>()?;

                    let signed_data_size = r.read_u32::<LittleEndian>()?;
                    let mut signed_data = vec![0; signed_data_size as _];
                    r.read_exact(&mut signed_data)?;

                    let mut signatures = vec![];
                    let mut remaining_signature_size = r.read_u32::<LittleEndian>()?;
                    while remaining_signature_size > 0 {
                        let signature_size = r.read_u32::<LittleEndian>()?;
                        let algorithm = r.read_u32::<LittleEndian>()?;
                        let size = r.read_u32::<LittleEndian>()?;
                        let mut signature = vec![0; size as usize];
                        r.read_exact(&mut signature)?;
                        signatures.push(ApkSignature {
                            algorithm,
                            signature,
                        });
                        remaining_signature_size -= signature_size + 4;
                    }

                    let public_key_size = r.read_u32::<LittleEndian>()?;
                    let mut public_key = vec![0; public_key_size as _];
                    r.read_exact(&mut public_key)?;

                    signers.push(ApkSigner {
                        signed_data,
                        signatures,
                        public_key,
                    });
                    remaining_size -= signer_size as u64 + 4;
                }
                Ok(ApkSignatureBlockV2 { signers })
            }

            fn write(&self, w: &mut impl Write) -> Result<()> {
                let mut buffer = vec![];
                for signer in &self.signers {
                    let mut signer_buffer = vec![];
                    signer_buffer.write_u32::<LittleEndian>(signer.signed_data.len() as u32)?;
                    signer_buffer.write_all(&signer.signed_data)?;
                    let mut sig_buffer = vec![];
                    for sig in &signer.signatures {
                        sig_buffer.write_u32::<LittleEndian>(sig.signature.len() as u32 + 8)?;
                        sig_buffer.write_u32::<LittleEndian>(sig.algorithm)?;
                        sig_buffer.write_u32::<LittleEndian>(sig.signature.len() as u32)?;
                        sig_buffer.write_all(&sig.signature)?;
                    }
                    signer_buffer.write_u32::<LittleEndian>(sig_buffer.len() as u32)?;
                    signer_buffer.write_all(&sig_buffer)?;
                    signer_buffer.write_u32::<LittleEndian>(signer.public_key.len() as u32)?;
                    signer_buffer.write_all(&signer.public_key)?;
                    buffer.write_u32::<LittleEndian>(signer_buffer.len() as u32)?;
                    buffer.write_all(&signer_buffer)?;
                }
                w.write_u32::<LittleEndian>(buffer.len() as u32)?;
                w.write_all(&buffer)?;
                Ok(())
            }
        }

        #[derive(Debug, Default)]
        struct ApkSignatureBlock {
            pub blocks: Vec<ApkOpaqueBlock>,
            pub sb_start: u64,
            pub cd_start: u64,
            pub cde_start: u64,
        }

        #[derive(Clone, Copy, Debug)]
        struct ApkOpaqueBlock {
            pub id: u32,
            pub start: u64,
        }

        fn write_apk_signing_block<W: Write + Seek>(
            w: &mut W,
            hash: [u8; 32],
            signer: &Signer,
        ) -> Result<()> {
            let mut buf = vec![];
            ApkSignatureBlockV2::new(hash, signer)?.write(&mut buf)?;
            let size = buf.len() as u64 + 36;
            w.write_u64::<LittleEndian>(size)?;
            w.write_u64::<LittleEndian>(buf.len() as u64 + 4)?;
            w.write_u32::<LittleEndian>(APK_SIGNING_BLOCK_V2_ID)?;
            w.write_all(&buf)?;
            w.write_u64::<LittleEndian>(size)?;
            w.write_all(APK_SIGNING_BLOCK_MAGIC)?;
            Ok(())
        }

        fn parse_apk_signing_block<R: Read + Seek>(r: &mut R) -> Result<ApkSignatureBlock> {
            let info = ZipInfo::new(r)?;
            let mut block = ApkSignatureBlock {
                cde_start: info.cde_start,
                cd_start: info.cd_start,
                ..Default::default()
            };
            r.seek(SeekFrom::Start(block.cd_start - 16 - 8))?;
            let mut remaining_size = r.read_u64::<LittleEndian>()?;
            let mut magic = [0; 16];
            r.read_exact(&mut magic)?;
            if magic != APK_SIGNING_BLOCK_MAGIC {
                block.sb_start = block.cd_start;
                return Ok(block);
            }
            let mut pos = r.seek(SeekFrom::Current(-(remaining_size as i64)))?;
            block.sb_start = pos - 8;
            while remaining_size > 24 {
                let length = r.read_u64::<LittleEndian>()?;
                let id = r.read_u32::<LittleEndian>()?;
                block.blocks.push(ApkOpaqueBlock {
                    id,
                    start: pos + 8 + 4,
                });
                pos = r.seek(SeekFrom::Start(pos + length + 8))?;
                remaining_size -= length + 8;
            }
            Ok(block)
        }
    }

    mod compiler {
        mod attributes {
            use crate::apk::compiler::table::{Ref, Table};
            use crate::apk::res::{ResAttributeType, ResValue, ResValueType};
            use anyhow::{Context, Result};
            use roxmltree::Attribute;
            use std::collections::{BTreeMap, BTreeSet};

            pub fn compile_attr(
                table: &Table,
                name: &str,
                value: &str,
                strings: &Strings,
            ) -> Result<ResValue> {
                let attr_type = table
                    .entry_by_ref(Ref::attr(name))
                    .ok()
                    .and_then(|entry| entry.attribute_type());
                let (data, data_type) = match attr_type {
                    Some(ResAttributeType::Reference) => {
                        let id = table.entry_by_ref(Ref::parse(value)?)?.id();
                        (u32::from(id), ResValueType::Reference)
                    }
                    Some(ResAttributeType::String) => {
                        (strings.id(value) as u32, ResValueType::String)
                    }
                    Some(ResAttributeType::Integer) => (value.parse()?, ResValueType::IntDec),
                    Some(ResAttributeType::Boolean) => match value {
                        "true" => (0xffff_ffff, ResValueType::IntBoolean),
                        "false" => (0x0000_0000, ResValueType::IntBoolean),
                        _ => anyhow::bail!("expected boolean"),
                    },
                    Some(ResAttributeType::Enum) => {
                        let entry = table.entry_by_ref(Ref::attr(name))?;
                        let id = table.entry_by_ref(Ref::id(value))?.id();
                        let value = entry.lookup_value(id).unwrap();
                        (value.data, ResValueType::from_u8(value.data_type).unwrap())
                    }
                    Some(ResAttributeType::Flags) => {
                        let entry = table.entry_by_ref(Ref::attr(name))?;
                        let mut data = 0;
                        let mut data_type = ResValueType::Null;
                        for flag in value.split('|') {
                            let id = table.entry_by_ref(Ref::id(flag))?.id();
                            let value = entry.lookup_value(id).unwrap();
                            data |= value.data;
                            data_type = ResValueType::from_u8(value.data_type).unwrap();
                        }
                        (data, data_type)
                    }
                    _ => fallback_attr_value(name, value, strings)?,
                };
                Ok(ResValue {
                    size: 8,
                    res0: 0,
                    data_type: data_type as u8,
                    data,
                })
            }

            fn fallback_attr_value(
                name: &str,
                value: &str,
                strings: &Strings,
            ) -> Result<(u32, ResValueType)> {
                if value == "true" {
                    return Ok((0xffff_ffff, ResValueType::IntBoolean));
                }
                if value == "false" {
                    return Ok((0x0000_0000, ResValueType::IntBoolean));
                }
                if let Ok(num) = value.parse::<u32>() {
                    return Ok((num, ResValueType::IntDec));
                }
                if let Some(id) = resource_id_from_ref(value) {
                    return Ok((id, ResValueType::Reference));
                }
                if name == "configChanges" || value.contains('|') {
                    return Ok((strings.id(value) as u32, ResValueType::String));
                }
                Ok((strings.id(value) as u32, ResValueType::String))
            }

            fn resource_id_from_ref(value: &str) -> Option<u32> {
                let value = value.strip_prefix('@')?;
                let (ty, entry) = value.split_once('/')?;
                if ty == "mipmap" && entry == "icon" {
                    return Some(0x7f01_0000);
                }
                None
            }

            pub struct StringPoolBuilder<'a> {
                table: &'a Table,
                attributes: BTreeMap<u32, &'a str>,
                strings: BTreeSet<&'a str>,
            }

            impl<'a> StringPoolBuilder<'a> {
                pub fn new(table: &'a Table) -> Self {
                    Self {
                        table,
                        attributes: Default::default(),
                        strings: Default::default(),
                    }
                }

                pub fn add_attribute(&mut self, attr: Attribute<'a, 'a>) -> Result<()> {
                    if let Some(ns) = attr.namespace() {
                        if ns == "http://schemas.android.com/apk/res/android" {
                            if let Ok(entry) = self.table.entry_by_ref(Ref::attr(attr.name())) {
                                self.attributes.insert(entry.id().into(), attr.name());
                                if entry.attribute_type() == Some(ResAttributeType::String) {
                                    self.strings.insert(attr.value());
                                }
                                return Ok(());
                            }
                        }
                    }
                    if attr.name() == "platformBuildVersionCode"
                        || attr.name() == "platformBuildVersionName"
                    {
                        self.strings.insert(attr.name());
                    } else {
                        self.strings.insert(attr.name());
                        self.strings.insert(attr.value());
                    }
                    Ok(())
                }

                pub fn add_string(&mut self, s: &'a str) {
                    self.strings.insert(s);
                }

                pub fn build(self) -> Strings {
                    let mut strings =
                        Vec::with_capacity(self.attributes.len() + self.strings.len());
                    let mut map = Vec::with_capacity(self.attributes.len());
                    for (id, name) in self.attributes {
                        strings.push(name.to_string());
                        map.push(id);
                    }
                    for string in self.strings {
                        strings.push(string.to_string());
                    }
                    Strings { strings, map }
                }
            }

            pub struct Strings {
                pub strings: Vec<String>,
                pub map: Vec<u32>,
            }

            impl Strings {
                pub fn id(&self, s2: &str) -> i32 {
                    self.strings
                        .iter()
                        .position(|s| s == s2)
                        .with_context(|| format!("all strings added to the string pool: {}", s2))
                        .unwrap() as i32
                }
            }
        }

        mod table {
            use crate::apk::extract_zip_file;
            use crate::apk::res::{
                Chunk, ResAttributeType, ResTableEntry, ResTableRef, ResTableValue, ResValue,
            };
            use anyhow::{Context, Result};
            use std::io::Cursor;
            use std::path::Path;

            pub struct Ref<'a> {
                package: Option<&'a str>,
                ty: &'a str,
                name: &'a str,
            }

            impl<'a> Ref<'a> {
                pub fn attr(name: &'a str) -> Self {
                    Self {
                        package: Some("android"),
                        ty: "attr",
                        name,
                    }
                }

                pub fn id(name: &'a str) -> Self {
                    Self {
                        package: Some("android"),
                        ty: "id",
                        name,
                    }
                }

                pub fn parse(s: &'a str) -> Result<Self> {
                    let s = s
                        .strip_prefix('@')
                        .with_context(|| format!("invalid reference {}: expected `@`", s))?;
                    let (descr, name) = s
                        .split_once('/')
                        .with_context(|| format!("invalid reference {}: expected `/`", s))?;
                    let (package, ty) = if let Some((package, ty)) = descr.split_once(':') {
                        (Some(package), ty)
                    } else {
                        (None, descr)
                    };
                    Ok(Self { package, ty, name })
                }
            }

            struct Package<'a> {
                id: u8,
                types: &'a [String],
                keys: &'a [String],
                chunks: &'a [Chunk],
            }

            impl<'a> Package<'a> {
                fn new(id: u8, chunks: &'a [Chunk]) -> Result<Self> {
                    let types = if let Chunk::StringPool(strings, _) = &chunks[0] {
                        strings
                    } else {
                        anyhow::bail!("invalid package");
                    };
                    let keys = if let Chunk::StringPool(strings, _) = &chunks[1] {
                        strings
                    } else {
                        anyhow::bail!("invalid package");
                    };
                    let chunks = &chunks[2..];
                    Ok(Self {
                        id,
                        types,
                        keys,
                        chunks,
                    })
                }

                fn lookup_type_id(&self, name: &str) -> Result<u8> {
                    let id = self
                        .types
                        .iter()
                        .position(|s| s.as_str() == name)
                        .with_context(|| format!("failed to locate type id {}", name))?;
                    Ok(id as u8 + 1)
                }

                fn lookup_key_id(&self, name: &str) -> Result<u32> {
                    let id = self
                        .keys
                        .iter()
                        .position(|s| s.as_str() == name)
                        .with_context(|| format!("failed to locate key id {}", name))?;
                    Ok(id as u32)
                }

                fn lookup_type(&self, id: u8) -> Result<Type<'a>> {
                    for chunk in self.chunks {
                        if let Chunk::TableType(header, _offsets, entries) = chunk {
                            if header.id == id {
                                return Ok(Type {
                                    package: self.id,
                                    id,
                                    entries,
                                });
                            }
                        }
                    }
                    anyhow::bail!("failed to locate type {}", id);
                }
            }

            struct Type<'a> {
                package: u8,
                id: u8,
                entries: &'a [Option<ResTableEntry>],
            }

            impl<'a> Type<'a> {
                pub fn lookup_entry_id(&self, key: u32) -> Result<u16> {
                    let id = self
                        .entries
                        .iter()
                        .position(|entry| {
                            if let Some(entry) = entry {
                                entry.key == key
                            } else {
                                false
                            }
                        })
                        .with_context(|| format!("failed to lookup entry id {}", key))?;
                    Ok(id as u16)
                }

                pub fn lookup_entry(&self, id: u16) -> Result<Entry<'a>> {
                    let entry = self
                        .entries
                        .get(id as usize)
                        .with_context(|| format!("failed to lookup entry {}", id))?
                        .as_ref()
                        .with_context(|| format!("failed to lookup entry {}", id))?;
                    let id = ResTableRef::new(self.package, self.id, id);
                    Ok(Entry { id, entry })
                }
            }

            #[derive(Clone, Copy, Debug)]
            pub struct Entry<'a> {
                id: ResTableRef,
                entry: &'a ResTableEntry,
            }

            impl Entry<'_> {
                pub fn id(self) -> ResTableRef {
                    self.id
                }

                pub fn attribute_type(self) -> Option<ResAttributeType> {
                    if let ResTableValue::Complex(_, entries) = &self.entry.value {
                        let data = entries[0].value.data;
                        // TODO: android supports multiple types
                        if data == 0b110 {
                            return Some(ResAttributeType::Integer);
                        }
                        if data == 0b11 {
                            return Some(ResAttributeType::String);
                        }
                        if data == 0b111110 {
                            return Some(ResAttributeType::String);
                        }
                        if let Some(value) = ResAttributeType::from_u32(entries[0].value.data) {
                            Some(value)
                        } else {
                            panic!("attribute_type: 0x{:x}", data);
                        }
                    } else {
                        None
                    }
                }

                pub fn lookup_value(&self, id: ResTableRef) -> Option<ResValue> {
                    if let ResTableValue::Complex(_, entries) = &self.entry.value {
                        for entry in &entries[1..] {
                            if entry.name == u32::from(id) {
                                return Some(entry.value);
                            }
                        }
                    }
                    None
                }
            }

            #[derive(Default)]
            pub struct Table {
                packages: Vec<Chunk>,
            }

            impl Table {
                pub fn import_apk(&mut self, apk: &Path) -> Result<()> {
                    let resources = extract_zip_file(apk, "resources.arsc")?;
                    let chunk = Chunk::parse(&mut Cursor::new(resources))?;
                    self.import_chunk(&chunk);
                    Ok(())
                }

                pub fn import_chunk(&mut self, chunk: &Chunk) {
                    if let Chunk::Table(_, packages) = chunk {
                        self.packages.extend_from_slice(packages);
                    }
                }

                fn lookup_package_id(&self, name: Option<&str>) -> Result<u8> {
                    if let Some(name) = name {
                        for package in &self.packages {
                            if let Chunk::TablePackage(header, _) = package {
                                if header.name == name {
                                    return Ok(header.id as u8);
                                }
                            }
                        }
                        anyhow::bail!("failed to locate package {}", name);
                    } else {
                        Ok(127)
                    }
                }

                fn lookup_package(&self, id: u8) -> Result<Package> {
                    for package in &self.packages {
                        if let Chunk::TablePackage(header, chunks) = package {
                            if header.id == id as u32 {
                                return Package::new(id, chunks);
                            }
                        }
                    }
                    anyhow::bail!("failed to locate package {}", id);
                }

                pub fn entry_by_ref(&self, r: Ref) -> Result<Entry> {
                    let id = self.lookup_package_id(r.package)?;
                    let package = self.lookup_package(id)?;
                    let id = package.lookup_type_id(r.ty)?;
                    let ty = package.lookup_type(id)?;
                    let key = package.lookup_key_id(r.name)?;
                    let id = ty.lookup_entry_id(key)?;
                    ty.lookup_entry(id)
                }

                /*pub fn entry(&self, r: ResTableRef) -> Result<Entry> {
                    let package = self.lookup_package(r.package())?;
                    let ty = package.lookup_type(r.ty())?;
                    ty.lookup_entry(r.entry())
                }*/
            }
        }

        mod xml {
            use crate::apk::compiler::attributes::{StringPoolBuilder, Strings};
            use crate::apk::compiler::table::Table;
            use crate::apk::res::{
                Chunk, ResValue, ResValueType, ResXmlAttribute, ResXmlEndElement, ResXmlNamespace,
                ResXmlNodeHeader, ResXmlStartElement,
            };
            use anyhow::Result;
            use roxmltree::{Document, Node, NodeType};
            use std::collections::BTreeMap;

            pub fn compile_xml(xml: &str, table: &Table) -> Result<Chunk> {
                let doc = Document::parse(xml)?;
                let root = doc.root_element();
                let mut builder = StringPoolBuilder::new(table);
                build_string_pool(root, &mut builder)?;
                let strings = builder.build();
                let mut chunks = vec![Chunk::Null, Chunk::Null];

                for ns in root.namespaces() {
                    chunks.push(Chunk::XmlStartNamespace(
                        ResXmlNodeHeader::default(),
                        ResXmlNamespace {
                            prefix: ns.name().map(|ns| strings.id(ns)).unwrap_or(-1),
                            uri: strings.id(ns.uri()),
                        },
                    ));
                }
                compile_node(root, &strings, &mut chunks, table)?;
                for ns in root.namespaces() {
                    chunks.push(Chunk::XmlEndNamespace(
                        ResXmlNodeHeader::default(),
                        ResXmlNamespace {
                            prefix: ns.name().map(|ns| strings.id(ns)).unwrap_or(-1),
                            uri: strings.id(ns.uri()),
                        },
                    ));
                }

                chunks[0] = Chunk::StringPool(strings.strings, vec![]);
                chunks[1] = Chunk::XmlResourceMap(strings.map);
                Ok(Chunk::Xml(chunks))
            }

            fn build_string_pool<'a>(
                node: Node<'a, 'a>,
                builder: &mut StringPoolBuilder<'a>,
            ) -> Result<()> {
                if node.node_type() != NodeType::Element {
                    for node in node.children() {
                        build_string_pool(node, builder)?;
                    }
                    return Ok(());
                }
                for ns in node.namespaces() {
                    if let Some(prefix) = ns.name() {
                        builder.add_string(prefix);
                    }
                    builder.add_string(ns.uri());
                }
                if let Some(ns) = node.tag_name().namespace() {
                    builder.add_string(ns);
                }
                builder.add_string(node.tag_name().name());
                for attr in node.attributes() {
                    builder.add_attribute(attr)?;
                }
                for node in node.children() {
                    build_string_pool(node, builder)?;
                }
                Ok(())
            }

            fn compile_node(
                node: Node,
                strings: &Strings,
                chunks: &mut Vec<Chunk>,
                table: &Table,
            ) -> Result<()> {
                if node.node_type() != NodeType::Element {
                    for node in node.children() {
                        compile_node(node, strings, chunks, table)?;
                    }
                    return Ok(());
                }

                let mut id_index = 0;
                let mut class_index = 0;
                let mut style_index = 0;
                let mut attrs = BTreeMap::new();
                for (i, attr) in node.attributes().enumerate() {
                    match attr.name() {
                        "id" => id_index = i as u16 + 1,
                        "class" => class_index = i as u16 + 1,
                        "style" => style_index = i as u16 + 1,
                        _ => {}
                    }
                    let value = if let Some("http://schemas.android.com/apk/res/android") =
                        attr.namespace()
                    {
                        super::attributes::compile_attr(table, attr.name(), attr.value(), strings)?
                    } else if attr.name() == "platformBuildVersionCode"
                        || attr.name() == "platformBuildVersionName"
                    {
                        ResValue {
                            size: 8,
                            res0: 0,
                            data_type: ResValueType::IntDec as u8,
                            data: attr.value().parse()?,
                        }
                    } else {
                        ResValue {
                            size: 8,
                            res0: 0,
                            data_type: ResValueType::String as u8,
                            data: strings.id(attr.value()) as u32,
                        }
                    };
                    let raw_value = if value.data_type == ResValueType::String as u8 {
                        value.data as i32
                    } else {
                        -1
                    };
                    let attr = ResXmlAttribute {
                        namespace: attr.namespace().map(|ns| strings.id(ns)).unwrap_or(-1),
                        name: strings.id(attr.name()),
                        raw_value,
                        typed_value: value,
                    };
                    attrs.insert(attr.name, attr);
                }
                let namespace = node
                    .tag_name()
                    .namespace()
                    .map(|ns| strings.id(ns))
                    .unwrap_or(-1);
                let name = strings.id(node.tag_name().name());
                chunks.push(Chunk::XmlStartElement(
                    ResXmlNodeHeader::default(),
                    ResXmlStartElement {
                        namespace,
                        name,
                        attribute_start: 0x0014,
                        attribute_size: 0x0014,
                        attribute_count: attrs.len() as _,
                        id_index,
                        class_index,
                        style_index,
                    },
                    attrs.into_values().collect(),
                ));
                /*let mut children = BTreeMap::new();
                for node in node.children() {
                    children.insert(strings.id(node.tag_name().name()), node);
                }
                for (_, node) in children {
                    compile_node(node, strings, chunks)?;
                }*/
                for node in node.children() {
                    compile_node(node, strings, chunks, table)?;
                }
                chunks.push(Chunk::XmlEndElement(
                    ResXmlNodeHeader::default(),
                    ResXmlEndElement { namespace, name },
                ));
                Ok(())
            }
        }

        use crate::apk::manifest::AndroidManifest;
        use crate::apk::res::{
            Chunk, ResTableConfig, ResTableEntry, ResTableHeader, ResTablePackageHeader,
            ResTableTypeHeader, ResTableTypeSpecHeader, ResTableValue, ResValue, ScreenType,
        };
        use anyhow::Result;

        pub use table::Table;

        pub fn compile_manifest(manifest: &AndroidManifest, table: &Table) -> Result<Chunk> {
            let xml = quick_xml::se::to_string(manifest)?;
            xml::compile_xml(&xml, table)
        }

        const DPI_SIZE: [u32; 5] = [48, 72, 96, 144, 192];

        fn variants(name: &str) -> impl Iterator<Item = (String, u32)> + '_ {
            DPI_SIZE
                .into_iter()
                .map(move |size| (format!("res/{0}/{0}{1}.png", name, size), size))
        }

        pub fn compile_mipmap<'a>(package_name: &str, name: &'a str) -> Result<Mipmap<'a>> {
            let chunk = Chunk::Table(
                ResTableHeader { package_count: 1 },
                vec![
                    Chunk::StringPool(variants(name).map(|(res, _)| res).collect(), vec![]),
                    Chunk::TablePackage(
                        ResTablePackageHeader {
                            id: 127,
                            name: package_name.to_string(),
                            type_strings: 288,
                            last_public_type: 1,
                            key_strings: 332,
                            last_public_key: 1,
                            type_id_offset: 0,
                        },
                        vec![
                            Chunk::StringPool(vec!["mipmap".to_string()], vec![]),
                            Chunk::StringPool(vec!["icon".to_string()], vec![]),
                            Chunk::TableTypeSpec(
                                ResTableTypeSpecHeader {
                                    id: 1,
                                    res0: 0,
                                    res1: 0,
                                    entry_count: 1,
                                },
                                vec![256],
                            ),
                            mipmap_table_type(1, 160, 0),
                            mipmap_table_type(1, 240, 1),
                            mipmap_table_type(1, 320, 2),
                            mipmap_table_type(1, 480, 3),
                            mipmap_table_type(1, 640, 4),
                        ],
                    ),
                ],
            );
            Ok(Mipmap { name, chunk })
        }

        fn mipmap_table_type(type_id: u8, density: u16, string_id: u32) -> Chunk {
            Chunk::TableType(
                ResTableTypeHeader {
                    id: type_id,
                    res0: 0,
                    res1: 0,
                    entry_count: 1,
                    entries_start: 88,
                    config: ResTableConfig {
                        size: 28 + 36,
                        imsi: 0,
                        locale: 0,
                        screen_type: ScreenType {
                            orientation: 0,
                            touchscreen: 0,
                            density,
                        },
                        input: 0,
                        screen_size: 0,
                        version: 4,
                        unknown: vec![0; 36],
                    },
                },
                vec![0],
                vec![Some(ResTableEntry {
                    size: 8,
                    flags: 0,
                    key: 0,
                    value: ResTableValue::Simple(ResValue {
                        size: 8,
                        res0: 0,
                        data_type: 3,
                        data: string_id,
                    }),
                })],
            )
        }

        pub struct Mipmap<'a> {
            name: &'a str,
            chunk: Chunk,
        }

        impl<'a> Mipmap<'a> {
            pub fn chunk(&self) -> &Chunk {
                &self.chunk
            }

            pub fn variants(&self) -> impl Iterator<Item = (String, u32)> + 'a {
                variants(self.name)
            }
        }
    }

    fn ensure_android_jar(
        root: &Path,
        target_sdk: u32,
        override_path: Option<PathBuf>,
    ) -> Result<PathBuf> {
        if let Some(mut path) = override_path {
            if !path.is_absolute() {
                path = root.join(path);
            }
            if !path.exists() {
                bail!("android.jar not found at `{}`", path.display());
            }
            ensure_android_jar_has_resources(&path)?;
            return Ok(path);
        }

        if let Ok(env_path) = env::var("ANDROID_JAR") {
            let path = PathBuf::from(env_path);
            if !path.exists() {
                bail!("ANDROID_JAR points to missing file `{}`", path.display());
            }
            ensure_android_jar_has_resources(&path)?;
            return Ok(path);
        }

        if let Ok(android_home) = env::var("ANDROID_HOME") {
            let platforms = Path::new(&android_home).join("platforms");
            if platforms.exists() {
                let target_dir = platforms.join(format!("android-{}", target_sdk));
                let candidate = target_dir.join("android.jar");
                if candidate.exists() {
                    ensure_android_jar_has_resources(&candidate)?;
                    return Ok(candidate);
                }
                let mut candidates = vec![];
                for entry in fs::read_dir(&platforms)? {
                    let entry = entry?;
                    let candidate = entry.path().join("android.jar");
                    if candidate.exists() {
                        candidates.push(candidate);
                    }
                }
                candidates.sort();
                if let Some(candidate) = candidates.pop() {
                    ensure_android_jar_has_resources(&candidate)?;
                    return Ok(candidate);
                }
            }
        }

        let sdk_dir = root.join(".cache").join("Android.sdk");
        let jar_path = sdk_dir
            .join("platforms")
            .join(format!("android-{}", target_sdk))
            .join("android.jar");
        if jar_path.exists() {
            ensure_android_jar_has_resources(&jar_path)?;
            return Ok(jar_path);
        }

        download_android_jar(&sdk_dir, target_sdk)?;
        ensure_android_jar_has_resources(&jar_path)?;
        Ok(jar_path)
    }

    fn ensure_android_jar_has_resources(path: &Path) -> Result<()> {
        let file = File::open(path)?;
        let mut archive = ZipArchive::new(file)?;
        archive
            .by_name("resources.arsc")
            .with_context(|| format!("`{}` missing resources.arsc", path.display()))?;
        Ok(())
    }

    fn download_android_jar(sdk_dir: &Path, target_sdk: u32) -> Result<()> {
        let package = format!("platforms;android-{}", target_sdk);
        android_sdkmanager::download_and_extract_packages(
            sdk_dir.to_str().context("Invalid SDK path")?,
            android_sdkmanager::HostOs::Linux,
            &[&package],
            Some(&[android_sdkmanager::MatchType::EntireName("android.jar")]),
        );
        Ok(())
    }
}

#[cfg(not(target_os = "android"))]
fn main() {
    println!(
        "`build_apk` is intended to run on Android hosts where the host and target architectures match."
    );
}

#[cfg(target_os = "android")]
fn main() {
    if let Err(err) = apk::build() {
        eprintln!("{err:?}");
        std::process::exit(1);
    }
}
