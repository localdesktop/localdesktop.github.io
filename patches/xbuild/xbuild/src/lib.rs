use crate::cargo::{Cargo, CargoBuild, CrateType};
use crate::config::Config;
use crate::devices::Device;
use anyhow::Result;
use clap::{Parser, ValueEnum};
use std::path::{Path, PathBuf};
use xcommon::Signer;

#[macro_export]
macro_rules! exe {
    ($name:expr) => {
        if cfg!(target_os = "windows") {
            concat!($name, ".exe")
        } else {
            $name
        }
    };
}

pub mod cargo;
pub mod command;
mod config;
mod devices;
mod download;
mod gradle;
mod task;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Opt {
    Debug,
    Release,
}

impl std::fmt::Display for Opt {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        match self {
            Self::Debug => write!(f, "debug"),
            Self::Release => write!(f, "release"),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, ValueEnum)]
pub enum Platform {
    Android,
    Ios,
    Linux,
    Macos,
    Windows,
}

impl Platform {
    pub fn host() -> Result<Self> {
        Ok(if cfg!(target_os = "linux") || cfg!(target_os = "android") {
            Platform::Linux
        } else if cfg!(target_os = "macos") {
            Platform::Macos
        } else if cfg!(target_os = "windows") {
            Platform::Windows
        } else {
            anyhow::bail!("unsupported host");
        })
    }
}

impl std::fmt::Display for Platform {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        self.to_possible_value()
            .expect("No variant is skipped in clap")
            .get_name()
            .fmt(f)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, ValueEnum)]
pub enum Arch {
    //Arm,
    Arm64,
    X64,
    //X86,
}

impl Arch {
    pub fn host() -> Result<Self> {
        if cfg!(target_arch = "x86_64") {
            Ok(Arch::X64)
        } else if cfg!(target_arch = "aarch64") {
            Ok(Arch::Arm64)
        } else {
            anyhow::bail!("unsupported host");
        }
    }
}

impl std::fmt::Display for Arch {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        self.to_possible_value()
            .expect("No variant is skipped in clap")
            .get_name()
            .fmt(f)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, ValueEnum)]
pub enum Format {
    Aab,
    Apk,
    Appbundle,
    Appdir,
    Appimage,
    Dmg,
    Exe,
    Ipa,
    Msix,
}

impl std::fmt::Display for Format {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        self.to_possible_value()
            .expect("No variant is skipped in clap")
            .get_name()
            .fmt(f)
    }
}

impl Format {
    pub fn platform_default(platform: Platform, opt: Opt, gradle: bool) -> Self {
        match (platform, opt) {
            (Platform::Android, Opt::Release) if gradle => Self::Aab,
            (Platform::Android, _) => Self::Apk,
            (Platform::Ios, Opt::Debug) => Self::Appbundle,
            (Platform::Ios, Opt::Release) => Self::Ipa,
            (Platform::Linux, Opt::Debug) => Self::Appdir,
            (Platform::Linux, Opt::Release) => Self::Appimage,
            (Platform::Macos, Opt::Debug) => Self::Appbundle,
            (Platform::Macos, Opt::Release) => Self::Dmg,
            (Platform::Windows, Opt::Debug) => Self::Exe,
            (Platform::Windows, Opt::Release) => Self::Exe, // TODO: Msix
        }
    }

    pub fn extension(self) -> &'static str {
        match self {
            Self::Aab => "aab",
            Self::Apk => "apk",
            Self::Appbundle => "app",
            Self::Appdir => "AppDir",
            Self::Appimage => "AppImage",
            Self::Dmg => "dmg",
            Self::Exe => "exe",
            Self::Ipa => "ipa",
            Self::Msix => "msix",
        }
    }

    pub fn supports_multiarch(self) -> bool {
        matches!(self, Self::Aab | Self::Apk)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, ValueEnum)]
pub enum Store {
    Apple,
    Microsoft,
    Play,
    Sideload,
}

impl std::fmt::Display for Store {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        self.to_possible_value()
            .expect("No variant is skipped in clap")
            .get_name()
            .fmt(f)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CompileTarget {
    platform: Platform,
    arch: Arch,
    opt: Opt,
}

impl CompileTarget {
    pub fn new(platform: Platform, arch: Arch, opt: Opt) -> Self {
        Self {
            platform,
            arch,
            opt,
        }
    }

    pub fn platform(self) -> Platform {
        self.platform
    }

    pub fn arch(self) -> Arch {
        self.arch
    }

    pub fn opt(self) -> Opt {
        self.opt
    }

    pub fn android_abi(self) -> apk::Target {
        assert_eq!(self.platform(), Platform::Android);
        match self.arch() {
            Arch::Arm64 => apk::Target::Arm64V8a,
            Arch::X64 => apk::Target::X86_64,
        }
    }

    /// Returns the triple used by the non-LLVM parts of the NDK
    pub fn ndk_triple(self) -> &'static str {
        assert_eq!(self.platform(), Platform::Android);
        match self.arch() {
            Arch::Arm64 => "aarch64-linux-android",
            //Arch::Arm => "arm-linux-androideabi",
            //Arch::X86 => "i686-linux-android",
            Arch::X64 => "x86_64-linux-android",
        }
    }

    pub fn rust_triple(self) -> Result<&'static str> {
        Ok(match (self.arch, self.platform) {
            (Arch::Arm64, Platform::Android) => "aarch64-linux-android",
            (Arch::Arm64, Platform::Ios) => "aarch64-apple-ios",
            (Arch::Arm64, Platform::Linux) => "aarch64-unknown-linux-gnu",
            (Arch::Arm64, Platform::Macos) => "aarch64-apple-darwin",
            (Arch::X64, Platform::Android) => "x86_64-linux-android",
            (Arch::X64, Platform::Linux) => "x86_64-unknown-linux-gnu",
            (Arch::X64, Platform::Macos) => "x86_64-apple-darwin",
            (Arch::X64, Platform::Windows) => "x86_64-pc-windows-msvc",
            (arch, platform) => anyhow::bail!(
                "unsupported arch/platform combination {} {}",
                arch,
                platform
            ),
        })
    }

    pub fn is_host(self) -> Result<bool> {
        Ok(self.platform() == Platform::host()? && self.arch() == Arch::host()?)
    }
}

impl std::fmt::Display for CompileTarget {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        write!(f, "{}-{}-{}", self.platform, self.arch, self.opt)
    }
}

#[derive(Parser)]
pub struct BuildArgs {
    #[clap(flatten)]
    build_target: BuildTargetArgs,
    #[clap(flatten)]
    cargo: CargoArgs,
    /// Use verbose output
    #[clap(long, short)]
    verbose: bool,
}

#[derive(Parser)]
pub struct CargoArgs {
    /// Cargo package to build
    #[clap(long, short)]
    package: Option<String>,
    /// Path to Cargo.toml
    #[clap(long)]
    manifest_path: Option<PathBuf>,
    /// Directory for all generated artifacts
    #[clap(long)]
    target_dir: Option<PathBuf>,
    /// Run without accessing the network
    #[clap(long)]
    offline: bool,
    /// Space or comma separated list of features to activate
    #[clap(long, short = 'F')]
    features: Vec<String>,
}

impl CargoArgs {
    pub fn cargo(self) -> Result<Cargo> {
        Cargo::new(
            self.package.as_deref(),
            self.features,
            self.manifest_path,
            self.target_dir,
            self.offline,
        )
    }
}

#[derive(Parser)]
pub struct BuildTargetArgs {
    /// Build artifacts in debug mode, without optimizations
    #[clap(long, conflicts_with = "release")]
    debug: bool,
    /// Build artifacts in release mode, with optimizations
    #[clap(long, short, conflicts_with = "debug")]
    release: bool,
    /// Build artifacts for target platform.
    #[clap(long, conflicts_with = "device")]
    platform: Option<Platform>,
    /// Build artifacts for target arch.
    #[clap(long, requires = "platform")]
    arch: Option<Arch>,
    /// Build artifacts for target device. To find the device
    /// identifier of a connected device run `x devices`.
    #[clap(long, conflicts_with = "store")]
    device: Option<String>,
    /// Build artifacts with format.
    #[clap(long, conflicts_with = "store")]
    format: Option<Format>,
    /// Build artifacts for target app store.
    #[clap(long, conflicts_with = "device", conflicts_with = "format")]
    store: Option<Store>,
    /// Path to a PEM encoded RSA2048 signing key and certificate
    /// used to sign artifacts.
    #[clap(long)]
    pem: Option<PathBuf>,
    /// Path to an apple provisioning profile.
    #[clap(long)]
    provisioning_profile: Option<PathBuf>,
    /// Path to an api key.
    #[clap(long)]
    api_key: Option<PathBuf>,
}

impl BuildTargetArgs {
    pub fn build_target(self, config: &Config) -> Result<BuildTarget> {
        let signer = if let Some(pem) = self.pem.as_ref() {
            anyhow::ensure!(pem.exists(), "pem file doesn't exist {}", pem.display());
            Some(Signer::from_path(pem)?)
        } else if let Ok(pem) = std::env::var("X_PEM") {
            Some(Signer::new(&pem)?)
        } else {
            None
        };
        let store = self.store;
        let device = if self.platform.is_none() && store.is_none() && self.device.is_none() {
            Some(Device::host())
        } else {
            self.device
                .as_ref()
                .map(|device| device.parse())
                .transpose()?
        };
        let platform = if let Some(platform) = self.platform {
            platform
        } else if let Some(store) = store {
            match store {
                Store::Apple => anyhow::bail!("apple store requires platform arg"),
                Store::Microsoft => Platform::Windows,
                Store::Play => Platform::Android,
                Store::Sideload => anyhow::bail!("sideload store requires platform arg"),
            }
        } else if let Some(device) = device.as_ref() {
            device.platform()?
        } else {
            anyhow::bail!("--platform, --store or --device must be provided");
        };
        let archs = if let Some(arch) = self.arch {
            vec![arch]
        } else if let Some(store) = store {
            match store {
                Store::Apple => vec![Arch::X64, Arch::Arm64],
                Store::Microsoft => vec![Arch::X64],
                Store::Play => vec![Arch::Arm64],
                Store::Sideload => anyhow::bail!("sideload store requires arch arg"),
            }
        } else if let Some(device) = device.as_ref() {
            vec![device.arch()?]
        } else {
            anyhow::bail!("--arch, --store or --device must be provided");
        };
        let opt = if self.release || (!self.debug && self.store.is_some()) {
            Opt::Release
        } else {
            Opt::Debug
        };
        let format = if let Some(format) = self.format {
            format
        } else if store == Some(Store::Play) {
            Format::Aab
        } else {
            Format::platform_default(platform, opt, config.android().gradle)
        };
        let provisioning_profile = if let Some(profile) = self.provisioning_profile {
            anyhow::ensure!(
                profile.exists(),
                "provisioning profile doesn't exist {}",
                profile.display()
            );
            Some(std::fs::read(profile)?)
        } else if let Ok(mut profile) = std::env::var("X_PROVISIONING_PROFILE") {
            profile.retain(|c| !c.is_whitespace());
            Some(base64::decode(&profile)?)
        } else {
            None
        };
        let api_key = self.api_key;
        Ok(BuildTarget {
            opt,
            platform,
            archs,
            format,
            device,
            store,
            signer,
            provisioning_profile,
            api_key,
        })
    }
}

#[derive(Clone, Debug)]
pub struct BuildTarget {
    opt: Opt,
    platform: Platform,
    archs: Vec<Arch>,
    format: Format,
    device: Option<Device>,
    store: Option<Store>,
    signer: Option<Signer>,
    provisioning_profile: Option<Vec<u8>>,
    api_key: Option<PathBuf>,
}

impl BuildTarget {
    pub fn opt(&self) -> Opt {
        self.opt
    }

    pub fn platform(&self) -> Platform {
        self.platform
    }

    pub fn archs(&self) -> &[Arch] {
        &self.archs
    }

    pub fn format(&self) -> Format {
        self.format
    }

    pub fn device(&self) -> Option<&Device> {
        self.device.as_ref()
    }

    pub fn store(&self) -> Option<Store> {
        self.store
    }

    pub fn compile_targets(&self) -> impl Iterator<Item = CompileTarget> + '_ {
        self.archs
            .iter()
            .map(|arch| CompileTarget::new(self.platform, *arch, self.opt))
    }

    pub fn is_host(&self) -> bool {
        self.device
            .as_ref()
            .map(|device| device.is_host())
            .unwrap_or_default()
    }

    pub fn signer(&self) -> Option<&Signer> {
        self.signer.as_ref()
    }

    pub fn provisioning_profile(&self) -> Option<&[u8]> {
        self.provisioning_profile.as_deref()
    }

    pub fn api_key(&self) -> Option<&Path> {
        self.api_key.as_deref()
    }
}

pub struct BuildEnv {
    name: String,
    build_target: BuildTarget,
    build_dir: PathBuf,
    cache_dir: PathBuf,
    icon: Option<PathBuf>,
    cargo: Cargo,
    config: Config,
    verbose: bool,
    offline: bool,
}

impl BuildEnv {
    pub fn new(args: BuildArgs) -> Result<Self> {
        let verbose = args.verbose;
        let offline = args.cargo.offline;
        let cargo = args.cargo.cargo()?;
        let build_dir = cargo.target_dir().join("x");
        let cache_dir = dirs::cache_dir().unwrap().join("x");
        let package = cargo.manifest().package.as_ref().unwrap(); // Caller should guarantee that this is a valid package
        let manifest = cargo.package_root().join("manifest.yaml");
        let mut config = Config::parse(manifest)?;
        let build_target = args.build_target.build_target(&config)?;
        config.apply_rust_package(package, cargo.workspace_manifest(), build_target.opt())?;
        let icon = config
            .icon(build_target.platform())
            .map(|icon| cargo.package_root().join(icon));
        Ok(Self {
            name: package.name.clone(),
            build_target,
            icon,
            cargo,
            config,
            build_dir,
            cache_dir,
            verbose,
            offline,
        })
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn target(&self) -> &BuildTarget {
        &self.build_target
    }

    pub fn verbose(&self) -> bool {
        self.verbose
    }

    pub fn offline(&self) -> bool {
        self.offline
    }

    pub fn root_dir(&self) -> &Path {
        self.cargo.package_root()
    }

    pub fn build_dir(&self) -> &Path {
        &self.build_dir
    }

    pub fn cache_dir(&self) -> &Path {
        &self.cache_dir
    }

    pub fn opt_dir(&self) -> PathBuf {
        self.build_dir().join(self.target().opt().to_string())
    }

    pub fn platform_dir(&self) -> PathBuf {
        self.opt_dir().join(self.target().platform().to_string())
    }

    pub fn arch_dir(&self, arch: Arch) -> PathBuf {
        self.platform_dir().join(arch.to_string())
    }

    pub fn output(&self) -> PathBuf {
        let output_dir = if self.target().format().supports_multiarch() {
            self.platform_dir()
        } else {
            let target = self.target().compile_targets().next().unwrap();
            self.arch_dir(target.arch())
        };
        let output_name = format!("{}.{}", self.name(), self.target().format().extension());
        output_dir.join(output_name)
    }

    pub fn executable(&self) -> PathBuf {
        let out = self.output();
        match (self.target().format(), self.target().platform()) {
            (Format::Appdir, _) => out.join("AppRun"),
            (Format::Appbundle, Platform::Macos) => {
                out.join("Contents").join("MacOS").join(self.name())
            }
            _ => out,
        }
    }

    pub fn icon(&self) -> Option<&Path> {
        self.icon.as_deref()
    }

    pub fn cargo(&self) -> &Cargo {
        &self.cargo
    }

    pub fn config(&self) -> &Config {
        &self.config
    }

    pub fn target_sdk_version(&self) -> u32 {
        self.config()
            .android()
            .manifest
            .sdk
            .target_sdk_version
            .unwrap()
    }

    pub fn android_jar(&self) -> PathBuf {
        self.cache_dir()
            .join("Android.sdk")
            .join("platforms")
            .join(format!("android-{}", self.target_sdk_version()))
            .join("android.jar")
    }

    pub fn windows_sdk(&self) -> PathBuf {
        self.cache_dir().join("Windows.sdk")
    }

    pub fn macos_sdk(&self) -> PathBuf {
        self.cache_dir().join("MacOSX.sdk")
    }

    pub fn android_sdk(&self) -> PathBuf {
        self.cache_dir().join("Android.sdk")
    }

    pub fn android_ndk(&self) -> PathBuf {
        self.cache_dir().join("Android.ndk")
    }

    pub fn ios_sdk(&self) -> PathBuf {
        self.cache_dir().join("iPhoneOS.sdk")
    }

    pub fn developer_disk_image(&self, major: u32, minor: u32) -> PathBuf {
        self.cache_dir()
            .join("iPhoneOS.platform")
            .join("DeviceSupport")
            .join(format!("{}.{}", major, minor))
            .join("DeveloperDiskImage.dmg")
    }

    pub fn lldb_server(&self, target: CompileTarget) -> Result<PathBuf> {
        match target.platform() {
            Platform::Android => {
                let ndk = self.android_ndk();
                let lib_dir = ndk.join("usr").join("lib").join(target.ndk_triple());
                Ok(lib_dir.join("lldb-server"))
            }
            Platform::Ios => {
                todo!()
            }
            _ => Ok(which::which("lldb-server")?),
        }
    }

    pub fn cargo_build(&self, target: CompileTarget, target_dir: &Path) -> Result<CargoBuild> {
        let mut cargo = self.cargo.build(target, target_dir)?;
        if target.platform() == Platform::Linux {
            cargo.add_link_arg("-Wl,-rpath");
            cargo.add_link_arg("-Wl,$ORIGIN/lib");
        }
        if target.platform() == Platform::Android {
            let ndk = self.android_ndk();
            let target_sdk_version = self
                .config()
                .android()
                .manifest
                .sdk
                .target_sdk_version
                .unwrap();
            cargo.use_android_ndk(&ndk, target_sdk_version)?;
        }
        if target.platform() == Platform::Windows {
            let sdk = self.windows_sdk();
            if sdk.exists() {
                cargo.use_windows_sdk(&sdk)?;
            }
        }
        if target.platform() == Platform::Macos {
            let sdk = self.macos_sdk();
            if sdk.exists() {
                let minimum_version = self
                    .config()
                    .macos()
                    .info
                    .ls_minimum_system_version
                    .as_ref()
                    .unwrap();
                cargo.use_macos_sdk(&sdk, minimum_version)?;
            } else {
                cargo.add_link_arg("-rpath");
                cargo.add_link_arg("@executable_path/../Frameworks");
            }
        }
        if target.platform() == Platform::Ios {
            let sdk = self.ios_sdk();
            if sdk.exists() {
                let minimum_version = self
                    .config()
                    .ios()
                    .info
                    .minimum_os_version
                    .as_ref()
                    .unwrap();
                cargo.use_ios_sdk(&sdk, minimum_version)?;
            }
        }
        Ok(cargo)
    }

    pub fn cargo_test(&self, target: CompileTarget, target_dir: &Path) -> Result<CargoBuild> {
        let mut cargo = self.cargo.test(target, target_dir)?;
        if target.platform() == Platform::Linux {
            cargo.add_link_arg("-Wl,-rpath");
            cargo.add_link_arg("-Wl,$ORIGIN/lib");
        }
        if target.platform() == Platform::Android {
            let ndk = self.android_ndk();
            let target_sdk_version = self
                .config()
                .android()
                .manifest
                .sdk
                .target_sdk_version
                .unwrap();
            cargo.use_android_ndk(&ndk, target_sdk_version)?;
        }
        if target.platform() == Platform::Windows {
            let sdk = self.windows_sdk();
            if sdk.exists() {
                cargo.use_windows_sdk(&sdk)?;
            }
        }
        if target.platform() == Platform::Macos {
            let sdk = self.macos_sdk();
            if sdk.exists() {
                let minimum_version = self
                    .config()
                    .macos()
                    .info
                    .ls_minimum_system_version
                    .as_ref()
                    .unwrap();
                cargo.use_macos_sdk(&sdk, minimum_version)?;
            } else {
                cargo.add_link_arg("-rpath");
                cargo.add_link_arg("@executable_path/../Frameworks");
            }
        }
        if target.platform() == Platform::Ios {
            let sdk = self.ios_sdk();
            if sdk.exists() {
                let minimum_version = self
                    .config()
                    .ios()
                    .info
                    .minimum_os_version
                    .as_ref()
                    .unwrap();
                cargo.use_ios_sdk(&sdk, minimum_version)?;
            }
        }
        cargo.arg("--no-run");
        Ok(cargo)
    }

    pub fn cargo_artefact(
        &self,
        target_dir: &Path,
        target: CompileTarget,
        crate_type: CrateType,
    ) -> Result<PathBuf> {
        self.cargo.artifact(target_dir, target, None, crate_type)
    }
}
