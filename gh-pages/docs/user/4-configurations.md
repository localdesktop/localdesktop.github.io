---
title: Configurations
---

## Config file

On launch, Local Desktop looks for the config file at:

```text
/etc/localdesktop/localdesktop.toml
```

The file is optional. When it is missing, Local Desktop uses its built-in defaults. Create the path from the default root session when you need custom settings:

```bash
mkdir -p /etc/localdesktop
touch /etc/localdesktop/localdesktop.toml
```

If the file is malformed, Local Desktop uses the built-in defaults for that launch. The current implementation does not repair the file or create a backup automatically, so correct or remove the invalid file before trying again.

Important rules:

- Each setting must fit on a **single line**. Use `\n` inside a quoted value when a command needs an embedded newline.
- Config keys are **lowercase**.
- Config values are case-sensitive.
- Do not repeat a key in the same TOML table. Duplicate keys are invalid TOML and must not be used to list alternative commands.

## Config schema

The schema is defined in [`src/core/config.rs`](https://github.com/localdesktop/localdesktop.github.io/blob/main/src/core/config.rs#L44-L78). The main groups are `[user]` and `[command]`.

## Special `try_*` configs

A bad user or launch setting can leave a session on a black screen. The `try_*` variant of a setting provides a one-launch recovery mechanism.

Clone a normal setting and prefix its key with `try_`:

```toml
[user]
username = "root"
try_username = "teddy"
```

On the next launch, `try_username` overrides `username`, so Local Desktop attempts to launch as `teddy`. While reading the file, Local Desktop comments out the one-shot line:

```toml
[user]
username = "root"
# try_username = "teddy"
```

If the test fails, restart Local Desktop and the normal `username` value is used again. If the test succeeds, replace the normal value and remove the `try_` prefix to make the change persistent.

Important rules:

- This mechanism applies to every supported setting.
- A `try_*` setting overrides its corresponding normal setting for one launch.
- A `try_*` key and its normal key are different keys; for example, `try_launch` and `launch` may coexist.
- The same key must not appear more than once. In particular, a table may contain only one `try_launch` entry.
- Keep each `try_*` setting directly below its normal counterpart when both are present.

See [Using other Desktop Environments](/docs/user/custom-de) for safe KDE examples and recovery instructions.
