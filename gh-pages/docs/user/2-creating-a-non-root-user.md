---
title: Creating a Non-root User
---

For a simple setup process, Local Desktop won't prompt for a user registration form, that's why **it is login as root by default**.

However, some applications are **recommended** or **required** to run as a normal user. For example:

- Chrome and Electron-based applications like VS Code **work better or are safer** without root.
- AUR helpers like Paru or Yay require a non-root user and **won't work as root**.

:::info

Please follow the instructions below carefully, or you can continue to use XFCE with root if you prefer.

:::

## Create your user

Open a terminal and run the following command:

_(Replace `teddy` with your preferred username)_

```bash
useradd -m teddy
```

The `-m` flag creates a home directory for the user.

## Create your password

Set a password for your new user (you'll need this for `sudo`):

```bash
passwd teddy
```

## Set up `sudo`

Once you have logged in as a non-root user, you **must** use `sudo` to run commands with root privileges. If you skip this step, you **won't** be able to install new packages.

Install `sudo`:

```bash
pacman -S sudo
```

Allow your user to use `sudo` by editing the sudoers file:

```bash
EDITOR=nano visudo
```

Append a new line:

```
teddy ALL=(ALL) ALL
```

_(Replace `teddy` with the username you created [previously](#create-your-user))_

Save and exit.

You can test whether the account is resolvable and can use `sudo` by temporarily logging in:

```bash
getent passwd teddy # Change to your username
su - teddy
sudo ls /root # Make sure it does not output something like: "teddy is not in the sudoers file"
exit
```

If `su` displays `I have no name`, close and reopen Local Desktop, then repeat the test. Local Desktop repairs the account database permissions during startup so non-root processes can resolve users and groups.

## [Important] Tell Local Desktop

You must tell Local Desktop who to log in as, or it will log in as root. To (create and) edit the config file:

```
nano /etc/localdesktop/localdesktop.toml
```

Test the new account for one launch while keeping root as the persistent fallback:

```toml title="/etc/localdesktop/localdesktop.toml"
[user]
username = "root"
try_username = "teddy"
```

_(Replace `teddy` with the username you created [previously](#create-your-user))_

The changes will take effect the next time you launch Local Desktop. After that launch, `try_username` is commented out automatically. If the desktop works, change `username = "root"` to `username = "teddy"` and remove the commented `try_username` line. If the configured account is missing, Local Desktop falls back to root so you can repair the account or config without clearing the app's storage.
