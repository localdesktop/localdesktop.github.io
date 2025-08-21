import { themes as prismThemes } from "prism-react-renderer";
import type { Config } from "@docusaurus/types";
import type * as Preset from "@docusaurus/preset-classic";

// This runs in Node.js - Don't use client-side code here (browser APIs, JSX...)

const downloadUrl = "https://github.com/localdesktop/localdesktop/releases";
const repositoryUrl = "https://github.com/localdesktop/localdesktop";

const config: Config = {
  title: "Local Desktop | Linux on Android",
  tagline:
    "Local Desktop helps you run a desktop Linux environment on your Android device.",
  favicon: "img/favicon.ico",

  // Set the production url of your site here
  url: "https://localdesktop.github.io",
  // Set the /<baseUrl>/ pathname under which your site is served
  // For GitHub pages deployment, it is often '/<projectName>/'
  baseUrl: "/",

  // GitHub pages deployment config.
  // If you aren't using GitHub pages, you don't need these.
  organizationName: "facebook", // Usually your GitHub org/user name.
  projectName: "docusaurus", // Usually your repo name.

  onBrokenLinks: "throw",
  onBrokenMarkdownLinks: "warn",

  // Even if you don't use internationalization, you can use this field to set
  // useful metadata like html lang. For example, if your site is Chinese, you
  // may want to replace "en" with "zh-Hans".
  i18n: {
    defaultLocale: "en",
    locales: ["en"],
  },

  presets: [
    [
      "classic",
      {
        docs: {
          sidebarPath: "./sidebars.ts",
          // Please change this to your repo.
          // Remove this to remove the "edit this page" links.
          editUrl:
            "https://github.com/localdesktop/localdesktop.github.io/tree/main/",
        },
        blog: {
          showReadingTime: true,
          feedOptions: {
            type: ["rss", "atom", "json"],
            xslt: true,
          },
          // Please change this to your repo.
          // Remove this to remove the "edit this page" links.
          editUrl:
            "https://github.com/facebook/docusaurus/tree/main/packages/create-docusaurus/templates/shared/",
          // Useful options to enforce blogging best practices
          onInlineTags: "warn",
          onInlineAuthors: "warn",
          onUntruncatedBlogPosts: "warn",
        },
        theme: {
          customCss: "./src/css/custom.css",
        },
        gtag: {
          trackingID: "G-0NQ9P761VB",
        },
        sitemap: {
          changefreq: "always",
          priority: 0.5,
          ignorePatterns: ["/tags/**"],
          filename: "sitemap.xml",
        },
      } satisfies Preset.Options,
    ],
  ],

  scripts: [],

  themeConfig: {
    // Replace with your project's social card
    image: "img/logo.png",
    metadata: [
      {
        name: "keywords",
        content:
          "linux on android, android desktop environment, mobile linux, android virtualization, linux desktop mobile, android linux app, desktop environment android, run linux android, mobile desktop, android terminal, linux mobile app",
      },
    ],
    navbar: {
      title: "Local Desktop",
      logo: {
        alt: "Local Desktop Logo",
        src: "img/logo.png",
      },
      items: [
        {
          type: "docSidebar",
          sidebarId: "userSidebar",
          position: "left",
          label: "User Manual",
        },
        {
          type: "docSidebar",
          sidebarId: "developerSidebar",
          position: "left",
          label: "Developer Manual",
        },
        { to: "/blog", label: "News", position: "left" },
        {
          href: repositoryUrl,
          label: "GitHub",
          position: "right",
        },
      ],
    },
    footer: {
      style: "dark",
      links: [
        {
          label: "User Manual",
          to: "/docs/user/getting-started",
        },
        {
          label: "Developer Manual",
          to: "/docs/developer/how-to-build",
        },
        {
          label: "Support us 🎗️",
          to: "/support-us",
        },
        {
          label: "Download",
          href: downloadUrl,
        },
        {
          label: "Source Code",
          href: repositoryUrl,
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} Local Desktop.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
    },
    mermaid: {
      theme: { light: "forest" },
    },
  } satisfies Preset.ThemeConfig,

  plugins: [
    [
      "@gracefullight/docusaurus-plugin-microsoft-clarity",
      { projectId: "r0gcnlvoyw" },
    ],
    () => ({
      name: "@tailwindcss/postcss",
      configurePostCss(options) {
        // Setup TailwindCSS via PostCSS
        options.plugins.push({
          "@tailwindcss/postcss": {},
        });
        return options;
      },
    }),
  ],

  markdown: {
    mermaid: true,
  },

  themes: ["@docusaurus/theme-mermaid"],

  customFields: {
    downloadUrl,
    repositoryUrl,
    emailCollectForm: "https://forms.gle/UDrYH9xwhznT2u8Y9",
  },
};

export default config;
