---
title: Configurations
---

## Config file

On launch, Local Desktop reads the config file located at:

```
/etc/localdesktop/localdesktop.toml
```

If the content of the config file is invalid (for example, invalid TOML format), it will be **replaced** with the default config. You can still view its original content in:

```
/etc/localdesktop/localdesktop.bak
```

Some important notes:
- Although TOML does support multi-line strings, Local Desktop requires each config to fit in a **single line**. You can use `\n` for multi-line config values if needed.
- We use **all lowercase** for config **keys**. For config **values**, the content is **case-sensitive**.

## Config schema

We might draw a table or have a mechanism to generate the config schema automatically here. But for now, please check the code for the schema: [localdesktop/src/utils/config.rs#L32-L88](https://github.com/localdesktop/localdesktop/blob/a581c45943fcfd97d1292ed1847f5a1556de4632/src/utils/config.rs#L32-L88).

## Special `try_*` configs

Some configs are so important that a misconfiguration can leave you stuck on a black screen. So we support a special `try_*` variant of each config. These configs have **higher priority**, but only get applied **once**.

For example, you just have to clone a config and prefix it with `try_`:

```toml
[user]
username="root"
try_username="teddy"
```

The next time Local Desktop starts, it will log in as `teddy` instead of `root`. But then the `try_` configs will be commented out like this:

```toml
[user]
username="root"
# try_username="teddy"
```

So if the config didn't work, and you got stuck on a black screen, you can just restart Local Desktop, and things will go back to normal. Then you can uncomment the config and try with another value. If the config does work, you just have to remove the `try_` prefix to persist the config.

Some important notes:
- This rule applies to **all** configs.
- It is not required for the `try_` config to be inside the same group as the normal config. But it is strongly recommended to do so, and to put the `try_` variant right under its normal variant.
- If a normal config appears multiple times, the **first** entry is applied. If a `try_` config appears multiple times, the **last** entry is applied. This behavior is not guaranteed, and is subject to change. But in general, it is **invalid** to have duplicate config keys inside a TOML file.
- If both the `try_` and normal configs exist, the `try_` config will always be applied.
