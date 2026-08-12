---
title: Creating a Non-root User
---

For a simple setup process, Local Desktop does not prompt for user registration and logs in as root by default.

Some applications are recommended or required to run as a normal user. For example:

- Chrome and Electron-based applications such as VS Code work better or are safer without root.
- AUR helpers such as Paru or Yay require a non-root user and do not run as root.

:::info
Follow the instructions below carefully. You can continue to use Xfce as root when a separate user is not required.
:::

## Create your user

Open a terminal and create an account. Replace `teddy` with your preferred username:

```bash
useradd -m teddy
```

The `-m` flag creates the user's home directory.

## Create your password

Set a password for the new user. It will be required by `sudo`:

```bash
passwd teddy
```

## Set up `sudo`

After logging in as a non-root user, use `sudo` for commands that require root privileges. Without this step, the account cannot install new packages interactively.

Install `sudo`:

```bash
pacman -S sudo
```

Edit the sudoers file safely:

```bash
EDITOR=nano visudo
```

Append a line for the account:

```text
teddy ALL=(ALL) ALL
```

Replace `teddy` with the username you created, then save and exit.

Test the configuration by temporarily logging in:

```bash
su teddy
sudo ls /root
```

The second command must not report that the user is absent from the sudoers file.

## Tell Local Desktop which user to launch

Local Desktop must be told which account should own the desktop session. Create or edit the configuration file:

```bash
mkdir -p /etc/localdesktop
nano /etc/localdesktop/localdesktop.toml
```

Add:

```toml title="/etc/localdesktop/localdesktop.toml"
[user]
username = "teddy"
```

Replace `teddy` with the account you created. The change takes effect on the next launch.

:::note What this setting changes
The `[user].username` setting controls the account used for the desktop `launch` command. Local Desktop still runs dependency `check` and `install` commands as root, so desktop packages are installed system-wide while application settings and files belong to the selected user.
:::

For a custom desktop such as KDE Plasma, keep this `[user]` table and add exactly one tested `[command]` template from [Using other Desktop Environments](/docs/user/custom-de#kde-plasma).

If the account or configuration is incorrect, remove or fix `/etc/localdesktop/localdesktop.toml` and restart Local Desktop to return to the built-in root default.
