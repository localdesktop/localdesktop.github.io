---
title: Settings
---

## Open the settings

Local Desktop's settings are in Android, so you can change them even when the desktop doesn't start:

1. Touch and hold the Local Desktop icon, then tap **App info**. Or open Android's **Settings** > **Apps** > **Local Desktop**.
2. Tap **Additional settings in the app** (on some phones, a gear icon).

<img src="/img/settings-step-1.webp" width="32%" alt="Touch and hold the Local Desktop icon, then tap App info" /> <img src="/img/settings-step-2.webp" width="32%" alt="Tap Additional settings in the app" /> <img src="/img/settings.webp" width="32%" alt="Local Desktop settings" />

Changes apply the next time Local Desktop starts. **Restart Local Desktop** at the bottom applies them right away.

## What you can change

| Setting | What it does | Default |
|---|---|---|
| **Use the Android keyboard** | Your phone's keyboard comes up when a text field takes focus, and the desktop fits above it. Turn it off to use Squeekboard, the desktop's own on-screen keyboard. With an external display, the Android keyboard always types. | On |
| **User** | The Linux user the desktop runs as. Create the user first, see [Creating a non-root user](/docs/user/creating-a-non-root-user). | `root` |
| **Check** | A command that succeeds when the desktop environment is installed. | Checks for Xfce |
| **Install** | Installs the desktop environment when **Check** fails. | Installs Xfce |
| **Launch** | Starts the desktop environment. | Starts Xfce |

See [Using other Desktop Environments](/docs/user/custom-de) for other **Check**, **Install** and **Launch** commands.

If a setting leaves you with a black screen, change it back here, or tap **Restore defaults**.
