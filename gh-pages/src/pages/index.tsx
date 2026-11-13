import React, { type ReactNode } from "react";
import Head from "@docusaurus/Head";
import Link from "@docusaurus/Link";
import Layout from "@theme/Layout";
import Heading from "@theme/Heading";
import config from "@site/docusaurus.config";

const DESCRIPTION =
  "Local Desktop is a free, open-source Android app that runs a full Arch Linux desktop on phones and tablets, without root.";

const FEATURES = [
  {
    title: "No root required",
    body: "Local Desktop runs Linux inside the app's own storage with proot, so your phone keeps its warranty, its banking apps and its security updates. Nothing on the Android side is modified.",
  },
  {
    title: "One app, one tap",
    body: "There is no second app to install, no VNC viewer and no X server to configure. The first launch downloads Arch Linux ARM, installs the Xfce desktop and opens it, all from a single APK.",
  },
  {
    title: "Native Wayland compositor",
    body: "The desktop is drawn by a Wayland compositor written in Rust with Smithay and running inside the Android activity. Windows reach the screen without a network protocol in between, which keeps input latency low.",
  },
  {
    title: "GPU acceleration",
    body: "On Snapdragon devices, Vulkan runs on Mesa's Turnip driver and OpenGL runs on Zink, so Firefox, WebGL, games and 3D tools use the real GPU instead of software rendering.",
  },
  {
    title: "External display and trackpad",
    body: "Plug the phone into a monitor or TV and the Linux desktop moves to the big screen while the phone becomes a trackpad, much like a desktop mode, on any Android device.",
  },
  {
    title: "Sound, keyboards and mice",
    body: "PipeWire plays audio through Android's AAudio, physical keyboards and mice work with the usual shortcuts, and the Android keyboard can type straight into Linux apps.",
  },
];

const STEPS = [
  {
    title: "Arch Linux ARM in app storage",
    body: "On first launch the app extracts an Arch Linux ARM64 filesystem into its private data folder. It is a regular Arch system: pacman, the official repositories and the AUR all work.",
  },
  {
    title: "proot instead of chroot",
    body: "A real chroot needs root. proot gives the same view of the filesystem by intercepting system calls with ptrace, so Linux programs see /usr, /etc and /home as if they ran on a normal PC, while Android's own Linux kernel does the actual work.",
  },
  {
    title: "A compositor in the Android activity",
    body: "Linux desktops need a display server. Local Desktop ships its own Wayland compositor inside the Android app, and Xfce (or KDE, or any other Wayland desktop) connects to it as a normal Wayland client.",
  },
  {
    title: "Android input and audio bridged in",
    body: "Touch, mouse and keyboard events are translated into Wayland input, and a small PipeWire sink sends Linux audio to AAudio, so the desktop behaves like an ordinary Android app.",
  },
];

const USES = [
  "Write and run code with Visual Studio Code, Neovim, Python, Node.js, Rust or Go, directly on a tablet.",
  "Use full desktop Firefox or Chromium with extensions and developer tools, instead of a mobile browser.",
  "Edit images in GIMP, write documents in LibreOffice, or manage files with a real desktop file manager.",
  "Run local web servers, databases and command line tools to test projects without a laptop.",
  "Turn an old phone and a monitor into a small Linux computer for learning or light work.",
];

const FAQ = [
  {
    q: "Is Local Desktop free?",
    a: "Yes. The app is free, and its source code is published on GitHub under an open-source license. You can build the APK yourself.",
  },
  {
    q: "Which devices are supported?",
    a: "Any 64-bit ARM (arm64) Android device running Android 7.0 or newer. The Linux system and its apps need a few gigabytes of free storage. GPU acceleration currently needs a Qualcomm Adreno 6xx or newer GPU.",
  },
  {
    q: "Is it a virtual machine?",
    a: "No. There is no emulator and no second kernel. Linux programs run as normal Android processes on the phone's own kernel, which is why they start quickly and use little memory compared with a virtual machine.",
  },
  {
    q: "How is it different from Termux with a VNC or X11 viewer?",
    a: "Those setups combine several apps and send the screen through VNC or X11. Local Desktop is a single app with a built-in Wayland compositor, so setup is one tap and the desktop draws directly to the screen.",
  },
  {
    q: "Can it break my phone?",
    a: "No. Everything lives inside the app's private storage and runs with normal app permissions. Uninstalling the app removes the Linux system completely.",
  },
  {
    q: "Why does the app close in the background on Android 12 and newer?",
    a: "Android's phantom process killer stops apps that start many child processes. The Getting Started guide explains how to turn it off on Samsung and other devices.",
  },
];

const GUIDES = [
  { to: "/docs/user/getting-started", title: "Getting started", body: "Install apps with pacman and the AUR, fix tiny text and keep Android from killing the desktop." },
  { to: "/docs/user/creating-a-non-root-user", title: "Create a normal user", body: "Set up your own account with sudo instead of working as root." },
  { to: "/docs/user/custom-de", title: "Use another desktop", body: "Replace Xfce with KDE Plasma or another Wayland desktop environment." },
  { to: "/docs/user/gpu-acceleration", title: "GPU acceleration", body: "How Turnip and Zink work, how to check them and how to turn them off." },
  { to: "/docs/user/external-display", title: "External display", body: "Use a monitor with the phone as a trackpad, and every gesture it supports." },
  { to: "/docs/developer/how-it-works", title: "How it works", body: "A deeper tour of proot, Wayland and the Rust code behind the app." },
];

export default function Home(): ReactNode {
  const downloadUrl = config.customFields.downloadUrl as string;
  const repositoryUrl = config.customFields.repositoryUrl as string;

  return (
    <Layout title="Linux desktop on Android, without root" description={DESCRIPTION}>
      <Head>
        <meta property="og:type" content="website" />
        <meta property="og:url" content="https://localdesktop.github.io/" />
        <script type="application/ld+json">
          {JSON.stringify({
            "@context": "https://schema.org",
            "@type": "SoftwareApplication",
            name: "Local Desktop",
            applicationCategory: "DeveloperApplication",
            operatingSystem: "Android",
            description: DESCRIPTION,
            url: "https://localdesktop.github.io/",
            downloadUrl,
            codeRepository: repositoryUrl,
            license: "https://github.com/localdesktop/localdesktop.github.io/blob/main/LICENSE",
            offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
          })}
        </script>
        <script type="application/ld+json">
          {JSON.stringify({
            "@context": "https://schema.org",
            "@type": "FAQPage",
            mainEntity: FAQ.map(({ q, a }) => ({
              "@type": "Question",
              name: q,
              acceptedAnswer: { "@type": "Answer", text: a },
            })),
          })}
        </script>
      </Head>

      <main className="container home">
        <section className="home__hero">
          <p className="site-label">Free and open source</p>
          <Heading as="h1">Run a real Linux desktop on your Android phone</Heading>
          <p className="home__lead">
            Local Desktop turns an Android phone or tablet into a Linux computer. It installs Arch Linux ARM
            with the Xfce desktop and shows it on your screen through its own Wayland compositor. You get
            desktop Firefox, VS Code, GIMP, LibreOffice and the whole Arch package collection. It needs no root,
            no extra apps and no computer to set up.
          </p>
          <div className="home__actions">
            <Link className="button button--primary button--lg" to={downloadUrl}>
              Download the APK
            </Link>
            <Link className="button button--secondary button--lg" to="/docs/user/getting-started">
              Read the user manual
            </Link>
          </div>
        </section>

        <section>
          <Heading as="h2">Why Local Desktop</Heading>
          <p>
            Phones and tablets now have more memory and faster processors than many laptops from a few years
            ago, and more of them connect to keyboards and monitors. What they lack is desktop software. Local
            Desktop fills that gap with an ordinary Linux distribution, so the tools you already know work the
            same way they do on a PC.
          </p>
          <div className="home__grid">
            {FEATURES.map((f) => (
              <article key={f.title} className="home__card">
                <Heading as="h3">{f.title}</Heading>
                <p>{f.body}</p>
              </article>
            ))}
          </div>
        </section>

        <section>
          <Heading as="h2">How it works</Heading>
          <p>
            Android already runs on the Linux kernel, but it has a different filesystem, different libraries and
            a different graphics stack. Local Desktop adds the missing pieces in four steps.
          </p>
          <ol className="home__steps">
            {STEPS.map((s) => (
              <li key={s.title}>
                <strong>{s.title}.</strong> {s.body}
              </li>
            ))}
          </ol>
          <p>
            The app itself is written in Rust and runs as native code. The{" "}
            <Link to="/docs/developer/how-it-works">developer manual</Link> covers each part in detail, and the
            code is on <Link to={repositoryUrl}>GitHub</Link>.
          </p>
        </section>

        <section>
          <Heading as="h2">What you can do with it</Heading>
          <ul>
            {USES.map((u) => (
              <li key={u}>{u}</li>
            ))}
          </ul>
          <p>
            Installing software works like on any Arch system. <code>pacman -S firefox</code> installs Firefox,
            and an AUR helper such as <code>yay</code> adds proprietary apps like Google Chrome or Visual Studio
            Code. The <Link to="/docs/user/app-compatibility/firefox">app compatibility</Link> pages list tested
            apps and the tweaks they need.
          </p>
        </section>

        <section>
          <Heading as="h2">Guides</Heading>
          <div className="home__grid">
            {GUIDES.map((g) => (
              <Link key={g.to} to={g.to} className="home__card home__card--link">
                <Heading as="h3">{g.title}</Heading>
                <p>{g.body}</p>
              </Link>
            ))}
          </div>
        </section>

        <section>
          <Heading as="h2">Frequently asked questions</Heading>
          {FAQ.map(({ q, a }) => (
            <details key={q} className="home__faq" open>
              <summary>{q}</summary>
              <p>{a}</p>
            </details>
          ))}
        </section>

        <section>
          <Heading as="h2">Follow the project</Heading>
          <p>
            Local Desktop is built in the open by <Link to="/about">a small team of volunteers</Link>. Release
            notes, deep dives and community milestones are published in the <Link to="/blog">news</Link>. Bug
            reports and feature requests go to{" "}
            <Link to={`${repositoryUrl}/issues`}>GitHub issues</Link>, and other questions can be sent through
            the <Link to="/contact">contact page</Link>.
          </p>
          <p>
            Want a break? <a href="/bear-war/">Bear War</a> is a small real-time strategy game made by the
            same team. It runs in the browser and works offline.
          </p>
        </section>
      </main>
    </Layout>
  );
}
