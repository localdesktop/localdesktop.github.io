use crate::cargo::manifest::{Inheritable, Manifest, Package};
use crate::{Opt, Platform};
use anyhow::{Context, Result};
use apk::manifest::{Activity, AndroidManifest, IntentFilter, MetaData};
use apk::VersionCode;
use appbundle::InfoPlist;
use msix::AppxManifest;
use serde::Deserialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use xcommon::ZipFileOptions;

#[derive(Clone, Debug, Default)]
pub struct Config {
    generic: GenericConfig,
    android: AndroidConfig,
    ios: IosConfig,
    linux: LinuxConfig,
    macos: MacosConfig,
    windows: WindowsConfig,
}

impl Config {
    pub fn parse<P: AsRef<Path>>(path: P) -> Result<Self> {
        if !path.as_ref().exists() {
            return Ok(Default::default());
        }
        let contents = std::fs::read_to_string(path.as_ref())?;
        let config: RawConfig = serde_yaml::from_str(&contents)?;
        Ok(Self {
            generic: config.generic.unwrap_or_default(),
            android: config.android.unwrap_or_default(),
            ios: config.ios.unwrap_or_default(),
            linux: config.linux.unwrap_or_default(),
            macos: config.macos.unwrap_or_default(),
            windows: config.windows.unwrap_or_default(),
        })
    }

    /// Selects a generic config value from [`GenericConfig`], platform-specific
    /// overrides first and otherwise falls back to a shared option in the root.
    pub fn select_generic<T: ?Sized>(
        &self,
        platform: Platform,
        select: impl Fn(&GenericConfig) -> Option<&T>,
    ) -> Option<&T> {
        let generic = match platform {
            Platform::Android => &self.android.generic,
            Platform::Ios => &self.ios.generic,
            Platform::Macos => &self.macos.generic,
            Platform::Linux => &self.linux.generic,
            Platform::Windows => &self.windows.generic,
        };
        select(generic).or_else(|| select(&self.generic))
    }

    pub fn icon(&self, platform: Platform) -> Option<&Path> {
        self.select_generic(platform, |g| g.icon.as_deref())
    }

    pub fn runtime_libs(&self, platform: Platform) -> Vec<PathBuf> {
        let generic = match platform {
            Platform::Android => &self.android.generic,
            Platform::Ios => &self.ios.generic,
            Platform::Macos => &self.macos.generic,
            Platform::Linux => &self.linux.generic,
            Platform::Windows => &self.windows.generic,
        };

        generic
            .runtime_libs
            .iter()
            .chain(&self.generic.runtime_libs)
            .cloned()
            .collect()
    }

    pub fn apply_rust_package(
        &mut self,
        manifest_package: &Package,
        workspace_manifest: Option<&Manifest>,
        opt: Opt,
    ) -> Result<()> {
        // android
        let wry = self.android.wry;
        if wry {
            self.android
                .dependencies
                .push("androidx.appcompat:appcompat:1.4.1".into());
        }
        let manifest = &mut self.android.manifest;
        manifest.package.get_or_insert_with(|| {
            format!("com.example.{}", manifest_package.name.replace('-', "_"))
        });

        let inherit_package_field = || {
            let workspace = workspace_manifest
                .context("`workspace=true` requires a workspace")?
                .workspace
                .as_ref()
                // Unreachable:
                .expect("Caller-provided workspace lacks `[workspace]` table");

            workspace.package.as_ref().context("Failed to inherit field: `workspace.package` was not defined in workspace root manifest")
        };

        let package_version = match &manifest_package.version {
            Inheritable::Value(v) => v.clone(),
            Inheritable::Inherited { workspace: true } => inherit_package_field()?
                .version
                .clone()
                .context("Failed to inherit field: `workspace.package.version` was not defined in workspace root manifest")?,
            Inheritable::Inherited { workspace: false } => {
                anyhow::bail!("`workspace=false` is unsupported")
            }
        };

        let package_description = match &manifest_package.description {
            Some(Inheritable::Value(v)) => v.clone(),
            Some(Inheritable::Inherited { workspace: true }) => inherit_package_field()?
                .description
                .clone()
                .context("Failed to inherit field: `workspace.package.description` was not defined in workspace root manifest")?,
            Some(Inheritable::Inherited { workspace: false }) => {
                anyhow::bail!("`workspace=false` is unsupported")
            }
            None => "".into(),
        };

        manifest
            .version_name
            .get_or_insert_with(|| package_version.clone());
        if let Ok(code) = VersionCode::from_semver(&package_version) {
            manifest.version_code.get_or_insert_with(|| code.to_code(1));
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

        let application = &mut manifest.application;
        application
            .label
            .get_or_insert_with(|| manifest_package.name.clone());
        if wry {
            application
                .theme
                .get_or_insert_with(|| "@style/Theme.AppCompat.Light.NoActionBar".into());
        }
        application
            .debuggable
            .get_or_insert_with(|| opt == Opt::Debug);
        application.has_code.get_or_insert(wry);

        if application.activities.is_empty() {
            application.activities.push(Activity::default());
        }

        let activity = application.activities.get_mut(0).unwrap();
        activity.config_changes.get_or_insert_with(|| {
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
            .join("|")
        });
        activity
            .launch_mode
            .get_or_insert_with(|| "singleTop".into());
        activity.name.get_or_insert_with(|| {
            if wry {
                ".MainActivity".into()
            } else {
                "android.app.NativeActivity".into()
            }
        });
        activity
            .window_soft_input_mode
            .get_or_insert_with(|| "adjustResize".into());
        activity.hardware_accelerated.get_or_insert(true);
        activity.exported.get_or_insert(true);
        if !wry {
            activity.meta_data.push(MetaData {
                name: "android.app.lib_name".into(),
                value: Some(manifest_package.name.replace('-', "_")),
                resource: None,
            });
        }
        activity.intent_filters.push(IntentFilter {
            actions: vec!["android.intent.action.MAIN".into()],
            categories: vec!["android.intent.category.LAUNCHER".into()],
            data: vec![],
        });

        // ios
        let info = &mut self.ios.info;
        info.cf_bundle_identifier
            .get_or_insert_with(|| manifest_package.name.clone());
        info.cf_bundle_name
            .get_or_insert_with(|| manifest_package.name.clone());
        info.cf_bundle_package_type
            .get_or_insert_with(|| "APPL".into());
        info.cf_bundle_short_version_string
            .get_or_insert_with(|| package_version.clone());
        info.cf_bundle_version
            .get_or_insert_with(|| package_version.clone());
        info.cf_bundle_supported_platforms
            .get_or_insert_with(|| vec!["iPhoneOS".into()]);

        info.dt_compiler
            .get_or_insert_with(|| "com.apple.compilers.llvm.clang.1_0".into());
        info.dt_platform_build.get_or_insert_with(|| "19C51".into());
        info.dt_platform_name
            .get_or_insert_with(|| "iphoneos".into());
        info.dt_platform_version
            .get_or_insert_with(|| "15.2".into());
        info.dt_sdk_build.get_or_insert_with(|| "19C51".into());
        info.dt_sdk_name
            .get_or_insert_with(|| "iphoneos15.2".into());
        info.dt_xcode.get_or_insert_with(|| "1321".into());
        info.dt_xcode_build.get_or_insert_with(|| "13C100".into());

        info.ls_requires_ios.get_or_insert(true);

        info.minimum_os_version
            .get_or_insert_with(|| "14.0".to_string());

        info.ui_device_family.get_or_insert_with(|| vec![1, 2]);
        info.ui_launch_storyboard_name
            .get_or_insert_with(|| "".into());
        info.ui_required_device_capabilities
            .get_or_insert_with(|| vec!["arm64".into()]);
        let ipad_orientations = &mut info.ui_supported_interface_orientations_ipad;
        ipad_orientations.push("UIInterfaceOrientationPortrait".into());
        ipad_orientations.push("UIInterfaceOrientationPortraitUpsideDown".into());
        ipad_orientations.push("UIInterfaceOrientationLandscapeLeft".into());
        ipad_orientations.push("UIInterfaceOrientationLandscapeRight".into());
        let iphone_orientations = &mut info.ui_supported_interface_orientations_iphone;
        iphone_orientations.push("UIInterfaceOrientationPortrait".into());
        iphone_orientations.push("UIInterfaceOrientationLandscapeLeft".into());
        iphone_orientations.push("UIInterfaceOrientationLandscapeRight".into());

        // macos
        let info = &mut self.macos.info;
        info.cf_bundle_name
            .get_or_insert_with(|| manifest_package.name.clone());
        info.cf_bundle_short_version_string
            .get_or_insert_with(|| package_version.clone());
        info.ls_minimum_system_version
            .get_or_insert_with(|| "10.11".to_string());

        // windows
        self.windows
            .manifest
            .properties
            .display_name
            .get_or_insert_with(|| manifest_package.name.clone());
        self.windows
            .manifest
            .identity
            .version
            .get_or_insert(package_version);
        self.windows
            .manifest
            .properties
            .description
            .get_or_insert(package_description);

        Ok(())
    }

    pub fn android(&self) -> &AndroidConfig {
        &self.android
    }

    pub fn linux(&self) -> &LinuxConfig {
        &self.linux
    }

    pub fn ios(&self) -> &IosConfig {
        &self.ios
    }

    pub fn macos(&self) -> &MacosConfig {
        &self.macos
    }

    pub fn windows(&self) -> &WindowsConfig {
        &self.windows
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UnalignedCompressed {
    /// Don't align this file
    Unaligned,
    /// Compressed files do not need to be aligned, as they have to be unpacked and decompressed anyway
    #[default]
    Compressed,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(untagged)]
pub enum ZipAlignmentOptions {
    /// Align this file to the given number of bytes
    Aligned(u16),
    /// Used to wrap a tagged enum with an untagged alignment value
    UnalignedCompressed(UnalignedCompressed),
}

impl Default for ZipAlignmentOptions {
    fn default() -> Self {
        Self::UnalignedCompressed(UnalignedCompressed::Compressed)
    }
}

impl ZipAlignmentOptions {
    pub fn to_zip_file_options(self) -> ZipFileOptions {
        match self {
            Self::Aligned(a) => ZipFileOptions::Aligned(a),
            Self::UnalignedCompressed(UnalignedCompressed::Unaligned) => ZipFileOptions::Unaligned,
            Self::UnalignedCompressed(UnalignedCompressed::Compressed) => {
                ZipFileOptions::Compressed
            }
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(untagged, deny_unknown_fields)]
pub enum AssetPath {
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
    #[inline]
    pub fn path(&self) -> &Path {
        match self {
            AssetPath::Path(path) => path,
            AssetPath::Extended { path, .. } => path,
        }
    }

    #[inline]
    pub fn optional(&self) -> bool {
        match self {
            AssetPath::Path(_) => false,
            AssetPath::Extended { optional, .. } => *optional,
        }
    }

    #[inline]
    pub fn alignment(&self) -> ZipAlignmentOptions {
        match self {
            AssetPath::Path(_) => Default::default(),
            AssetPath::Extended { alignment, .. } => *alignment,
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawConfig {
    #[serde(flatten)]
    generic: Option<GenericConfig>,
    android: Option<AndroidConfig>,
    linux: Option<LinuxConfig>,
    ios: Option<IosConfig>,
    macos: Option<MacosConfig>,
    windows: Option<WindowsConfig>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GenericConfig {
    icon: Option<PathBuf>,
    #[serde(default)]
    runtime_libs: Vec<PathBuf>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AndroidDebugConfig {
    /// Forward remote (phone) socket connection to local (host)
    #[serde(default)]
    pub forward: HashMap<String, String>,
    /// Forward local (host) socket connection to remote (phone)
    #[serde(default)]
    pub reverse: HashMap<String, String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AndroidConfig {
    #[serde(flatten)]
    generic: GenericConfig,
    #[serde(default)]
    pub manifest: AndroidManifest,
    #[serde(default)]
    pub dependencies: Vec<String>,
    #[serde(default)]
    pub gradle: bool,
    #[serde(default)]
    pub wry: bool,
    #[serde(default)]
    pub assets: Vec<AssetPath>,
    /// Debug configuration for `x run`
    #[serde(default)]
    pub debug: AndroidDebugConfig,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IosConfig {
    #[serde(flatten)]
    generic: GenericConfig,
    pub assets_car: Option<PathBuf>,
    pub info: InfoPlist,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MacosConfig {
    #[serde(flatten)]
    generic: GenericConfig,
    pub info: InfoPlist,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LinuxConfig {
    #[serde(flatten)]
    generic: GenericConfig,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WindowsConfig {
    #[serde(flatten)]
    generic: GenericConfig,
    pub manifest: AppxManifest,
}
