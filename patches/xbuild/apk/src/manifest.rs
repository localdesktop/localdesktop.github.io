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
    #[serde(rename(serialize = "service"))]
    #[serde(default)]
    pub services: Vec<Service>,
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

/// Android [service element](https://developer.android.com/guide/topics/manifest/service-element).
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Service {
    #[serde(rename(serialize = "android:permission"))]
    pub permission: Option<String>,
    #[serde(rename(serialize = "android:name"))]
    pub name: Option<String>,
    #[serde(rename(serialize = "android:label"))]
    pub label: Option<String>,
    #[serde(rename(serialize = "android:enabled"))]
    pub enabled: Option<bool>,
    #[serde(rename(serialize = "android:exported"))]
    pub exported: Option<bool>,
    #[serde(rename(serialize = "meta-data"))]
    #[serde(default)]
    pub meta_data: Vec<MetaData>,
    #[serde(rename(serialize = "intent-filter"))]
    #[serde(default)]
    pub intent_filters: Vec<IntentFilter>,
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
    pub value: Option<String>,
    #[serde(rename(serialize = "android:resource"))]
    pub resource: Option<String>,
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
