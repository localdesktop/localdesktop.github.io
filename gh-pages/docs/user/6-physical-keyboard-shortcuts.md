---
title: Physical Keyboard Shortcuts
---

If Android intercepts hardware shortcuts like `Ctrl+C`, `Ctrl+V`, `Ctrl+L`, or other desktop-style combinations before they reach the Linux session, enable Local Desktop's physical-keyboard accessibility service.

:::warning Android Shows A Generic Warning
Android uses the same "full control of your device" warning for every accessibility service. Local Desktop uses this service only to forward physical keyboard events into the Linux desktop session.
:::

## Enable the service

1. Open Android **Settings** > **Accessibility** and find **Local Desktop Physical Keyboard** under **Downloaded apps**.

   ![Accessibility settings with Local Desktop listed](/img/accessibility-physical-keyboard-list.png#boxed)

1. Open **Local Desktop Physical Keyboard** and turn on **Use Local Desktop Physical Keyboard**.

   ![Local Desktop accessibility service details page](/img/accessibility-physical-keyboard-service.png#boxed)

1. Android will show a generic accessibility warning. Read it, then tap **Allow** if you want Local Desktop to receive physical keyboard shortcuts.

   ![Android accessibility permission warning dialog](/img/accessibility-physical-keyboard-warning.png#boxed)

1. When the setup is complete, the Accessibility list should show **On / Local Desktop Physical Keyboard**.

   ![Accessibility settings after the service has been enabled](/img/accessibility-physical-keyboard-enabled.png#boxed)

## When should I use this?

Enable it only if Android steals physical keyboard shortcuts before they reach Local Desktop. If shortcuts already work correctly on your device, leave it off.

## Turn it off again

Go back to the same settings page and switch **Use Local Desktop Physical Keyboard** off.
