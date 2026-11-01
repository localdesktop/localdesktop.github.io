//! The settings from "Additional settings in the app" in Android's App info (`SettingsActivity`), kept in
//! the app's SharedPreferences: only what differs from the defaults is stored there.

use crate::core::config::LocalConfig;
use jni::{
    objects::{JObject, JString, JValue},
    JNIEnv,
};

const PREFERENCES: &str = "settings";
const DEFAULTS: &str = "defaults";

/// Write the defaults for the settings page, and return the settings to start with.
pub fn load(env: &mut JNIEnv, activity: &JObject) -> LocalConfig {
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
        put_string(env, &editor, "username", &defaults.user.username)?;
        put_string(env, &editor, "check", &defaults.command.check)?;
        put_string(env, &editor, "install", &defaults.command.install)?;
        put_string(env, &editor, "launch", &defaults.command.launch)?;
        put_boolean(env, &editor, "android_keyboard", defaults.android_keyboard)?;
        env.call_method(&editor, "apply", "()V", &[])?;

        let settings = preferences(env, activity, PREFERENCES)?;
        let mut config = defaults.clone();
        if let Some(username) = get_string(env, &settings, "username")? {
            config.user.username = username;
        }
        if let Some(check) = get_string(env, &settings, "check")? {
            config.command.check = check;
        }
        if let Some(install) = get_string(env, &settings, "install")? {
            config.command.install = install;
        }
        if let Some(launch) = get_string(env, &settings, "launch")? {
            config.command.launch = launch;
        }
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
