import React, { type ReactNode } from "react";
import Layout from "@theme-original/Layout";
import type LayoutType from "@theme/Layout";
import type { WrapperProps } from "@docusaurus/types";
import useRouteContext from "@docusaurus/useRouteContext";
import { useLocation } from "@docusaurus/router";
import Head from "@docusaurus/Head";

type Props = WrapperProps<typeof LayoutType>;

export default function LayoutWrapper(props: Props): ReactNode {
  const routes = useRouteContext();
  const location = useLocation();

  const pathname = location.pathname.replace(/\/$/, "") || "/";
  const noAdsense =
    (typeof window !== "undefined" && window.self !== window.top) || // in iframe
    ["/privacy", "/support-us"].includes(pathname) || // excluded pages
    routes.plugin.name === "native"; // 404 pages

  return (
    <>
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
