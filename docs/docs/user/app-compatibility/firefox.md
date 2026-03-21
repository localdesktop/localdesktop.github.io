---
title: Firefox
---

Firefox works well on Local Desktop. This is one of the ways to use Browser DevTools on your phone.

![Firefox on Local Desktop](/img/firefox.webp)

You can install it using `pacman`:

```bash
pacman -S firefox
```

## Compatibility note

### Reduced security

In order to fix issue [#139](https://github.com/termux/proot/issues/139), Local Desktop follows [@ZhymabekRoman](https://github.com/termux/proot/issues/139#issuecomment-751988264)'s solution by:

- Setting `media.cubeb.sandbox` to `false`.
- Setting `security.sandbox.content.level` to `0`.

These tweaks are applied automatically using [Firefox AutoConfig](https://support.mozilla.org/en-US/kb/customizing-firefox-using-autoconfig) [on each startup](https://github.com/localdesktop/localdesktop/commit/e4781875f767cb311452a254f329ba2e1566f885).

<details>
<summary>Consequences</summary>

**Note**: The content below is AI-generated, but the sources are taken from Mozilla documentation, GitHub issues, and community discussions.

Setting `media.cubeb.sandbox` to `false` and `security.sandbox.content.level` to `0` disables key sandboxing mechanisms in Firefox, which are designed to protect the system from malicious content. These changes have the following consequences:

- **Increased Vulnerability to Exploits**:

  - Disabling `security.sandbox.content.level` removes restrictions on web content, allowing malicious websites to exploit vulnerabilities in Firefox's rendering engine or JavaScript engine to execute arbitrary code on the host system.
  - Setting `media.cubeb.sandbox` to `false` removes sandboxing for audio processing, potentially allowing malicious code to access system resources through audio-related vulnerabilities.

- **Exposure to Malicious Websites**:

  - Without content sandboxing, web content can more easily access system resources, increasing the risk of attacks from untrusted or compromised websites.

- **Reduced Isolation**:

  - Sandboxing isolates web content and audio processes from the host system. Disabling these sandboxes weakens this isolation, increasing the overall attack surface.

- **Potential for Privilege Escalation**:

  - The lack of audio sandboxing could enable privilege escalation, where malicious processes gain unauthorized access to system-level components.

</details>
