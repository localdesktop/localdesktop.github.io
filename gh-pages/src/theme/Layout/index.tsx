import React, { type ReactNode } from "react";
import Layout from "@theme-original/Layout";
import type LayoutType from "@theme/Layout";
import type { WrapperProps } from "@docusaurus/types";
import useRouteContext from "@docusaurus/useRouteContext";
import { useLocation } from "@docusaurus/router";
import Head from "@docusaurus/Head";

type Props = WrapperProps<typeof LayoutType>;

const THIN_PAGE_PATHS = new Set([
  "/blog/2025/07/08/thank-you-for-100-github-stars",
  "/blog/2026/04/07/thank-you-new-contributors",
  "/docs/developer/bug-cheat-sheet/android-debug",
  "/docs/developer/bug-cheat-sheet/egl-context",
  "/docs/developer/bug-cheat-sheet/pacman-progress",
  "/docs/developer/bug-cheat-sheet/random-crashes",
  "/docs/developer/bug-cheat-sheet/xkb-error",
  "/docs/user/android-storage",
  "/docs/user/app-compatibility/gimp",
  "/docs/user/app-compatibility/visual-studio-code",
]);

const GENERATED_LISTING_PAGE_PATHS = new Set([
  "/blog/archive",
  "/blog/authors",
  "/blog/tags",
]);

const GENERATED_LISTING_PAGE_PREFIXES = ["/blog/tags/"];

export default function LayoutWrapper(props: Props): ReactNode {
  const routes = useRouteContext();
  const location = useLocation();

  const pathname = location.pathname.replace(/\/$/, "") || "/";
  const isNoindexPage =
    THIN_PAGE_PATHS.has(pathname) ||
    GENERATED_LISTING_PAGE_PATHS.has(pathname) ||
    GENERATED_LISTING_PAGE_PREFIXES.some((prefix) => pathname.startsWith(prefix));
  const noAdsense =
    (typeof window !== "undefined" && window.self !== window.top) ||
    ["/privacy", "/support-us"].includes(pathname) ||
    isNoindexPage ||
    routes.plugin.name === "native";

  return (
    <>
      {isNoindexPage && (
        <Head>
          <meta name="robots" content="noindex" />
        </Head>
      )}
      {!noAdsense && (
        <Head>
          <meta
            name="google-adsense-account"
            content="ca-pub-8496762857844623"
          />
          <script
            src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-8496762857844623"
            type="text/javascript"
            crossOrigin="anonymous"
            async
          />
        </Head>
      )}
      <Layout {...props} />
    </>
  );
}
