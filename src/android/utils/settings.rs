//! The settings from "Local Desktop settings" in Android's App info (`SettingsActivity`), kept in
//! the app's SharedPreferences: only what differs from the defaults is stored there.

use crate::core::config::{parse_config, LocalConfig};
use jni::{
    objects::{JObject, JString, JValue},
    JNIEnv,
};
use std::{fs, path::Path};

const PREFERENCES: &str = "settings";
const DEFAULTS: &str = "defaults";
/// Set once the settings of `localdesktop.toml` have been carried over.
const MIGRATED: &str = "migrated_toml";

/// Write the defaults for the settings page, carry `localdesktop.toml` over once, and return the
/// settings to start with.
pub fn load(env: &mut JNIEnv, activity: &JObject, legacy_config: &Path) -> LocalConfig {
    let defaults = LocalConfig::default();
    let result = (|| -> jni::errors::Result<LocalConfig> {
        let stored = preferences(env, activity, DEFAULTS)?;
        let editor = env
            .call_method(
                &stored,
                "edit",
                "()Landroid/content/SharedPreferences$Editor;",
                &[],
            )?
            .l()?;
        for (key, value) in texts(&defaults) {
            put_string(env, &editor, key, value)?;
        }
        put_boolean(env, &editor, "android_keyboard", defaults.android_keyboard)?;
        env.call_method(&editor, "apply", "()V", &[])?;

        let settings = preferences(env, activity, PREFERENCES)?;
        if !get_boolean(env, &settings, MIGRATED, false)? {
            let editor = env
                .call_method(
                    &settings,
                    "edit",
                    "()Landroid/content/SharedPreferences$Editor;",
                    &[],
                )?
                .l()?;
            if legacy_config.exists() {
                let legacy = parse_config(legacy_config.to_string_lossy().into_owned());
                for ((key, value), (_, default)) in texts(&legacy).into_iter().zip(texts(&defaults))
                {
                    if value != default {
                        put_string(env, &editor, key, value)?;
                    }
                }
                retire(legacy_config);
            }
            put_boolean(env, &editor, MIGRATED, true)?;
            env.call_method(&editor, "commit", "()Z", &[])?;
        }

        let mut config = defaults.clone();
        config.user.username =
            get_string(env, &settings, "username")?.unwrap_or(config.user.username);
        config.command.check = get_string(env, &settings, "check")?.unwrap_or(config.command.check);
        config.command.install =
            get_string(env, &settings, "install")?.unwrap_or(config.command.install);
        config.command.launch =
            get_string(env, &settings, "launch")?.unwrap_or(config.command.launch);
        config.android_keyboard =
            get_boolean(env, &settings, "android_keyboard", config.android_keyboard)?;
        Ok(config)
    })();
    result.unwrap_or_else(|error| {
        log::error!("Failed to read the settings, using the defaults: {error}");
        let _ = env.exception_clear();
        defaults
    })
}

fn texts(config: &LocalConfig) -> [(&'static str, &str); 4] {
    [
        ("username", &config.user.username),
        ("check", &config.command.check),
        ("install", &config.command.install),
        ("launch", &config.command.launch),
    ]
}

/// Leave a note where the settings used to be, for anyone who opens the file to change them.
fn retire(legacy_config: &Path) {
    let old = fs::read_to_string(legacy_config).unwrap_or_default();
    let note = format!(
        "# Local Desktop no longer reads this file. Its settings moved to Android:\n# App info for Local Desktop > Additional settings in the app, where the values below were copied.\n#\n{}",
        old.lines().map(|line| format!("# {line}\n")).collect::<String>()
    );
    if let Err(error) = fs::write(legacy_config, note) {
        log::warn!("Failed to update {}: {error}", legacy_config.display());
    }
}

fn preferences<'local>(
    env: &mut JNIEnv<'local>,
    activity: &JObject,
    name: &str,
) -> jni::errors::Result<JObject<'local>> {
    let name = env.new_string(name)?;
    env.call_method(
        activity,
        "getSharedPreferences",
        "(Ljava/lang/String;I)Landroid/content/SharedPreferences;",
        &[(&name).into(), JValue::Int(0)],
    )?
    .l()
}

fn get_string(
    env: &mut JNIEnv,
    preferences: &JObject,
    key: &str,
) -> jni::errors::Result<Option<String>> {
    let key = env.new_string(key)?;
    let value = env
        .call_method(
            preferences,
            "getString",
            "(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;",
            &[(&key).into(), (&JObject::null()).into()],
        )?
        .l()?;
    if value.is_null() {
        return Ok(None);
    }
    Ok(Some(env.get_string(&JString::from(value))?.into()))
}

fn get_boolean(
    env: &mut JNIEnv,
    preferences: &JObject,
    key: &str,
    default: bool,
) -> jni::errors::Result<bool> {
    let key = env.new_string(key)?;
    env.call_method(
        preferences,
        "getBoolean",
        "(Ljava/lang/String;Z)Z",
        &[(&key).into(), JValue::Bool(default.into())],
    )?
    .z()
}

fn put_string(
    env: &mut JNIEnv,
    editor: &JObject,
    key: &str,
    value: &str,
) -> jni::errors::Result<()> {
    let key = env.new_string(key)?;
    let value = env.new_string(value)?;
    env.call_method(
        editor,
        "putString",
        "(Ljava/lang/String;Ljava/lang/String;)Landroid/content/SharedPreferences$Editor;",
        &[(&key).into(), (&value).into()],
    )?;
    Ok(())
}

fn put_boolean(
    env: &mut JNIEnv,
    editor: &JObject,
    key: &str,
    value: bool,
) -> jni::errors::Result<()> {
    let key = env.new_string(key)?;
    env.call_method(
        editor,
        "putBoolean",
        "(Ljava/lang/String;Z)Landroid/content/SharedPreferences$Editor;",
        &[(&key).into(), JValue::Bool(value.into())],
    )?;
    Ok(())
}
