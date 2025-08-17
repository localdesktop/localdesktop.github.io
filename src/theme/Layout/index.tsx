import React, { type ReactNode } from "react";
import Layout from "@theme-original/Layout";
import type LayoutType from "@theme/Layout";
import type { WrapperProps } from "@docusaurus/types";
import useRouteContext from "@docusaurus/useRouteContext";
import { useLocation } from "@docusaurus/router";
import Head from "@docusaurus/Head";
import ExecutionEnvironment from "@docusaurus/ExecutionEnvironment";

type Props = WrapperProps<typeof LayoutType>;

export default function LayoutWrapper(props: Props): ReactNode {
  const routes = useRouteContext();
  const location = useLocation();

  const pathname = location.pathname.replace(/\/$/, ""); // strip the trailing /
  const noAdsense =
    (typeof window !== "undefined" && window.self !== window.top) || // in iframe
    ["/privacy", "/support-us"].includes(pathname) || // excluded pages
    routes.plugin.name === "native"; // 404 pages

  if (noAdsense && !ExecutionEnvironment.canUseDOM) {
    console.log("🛑 Excluded AdSense on page ", location.pathname);
  }

  return (
    <>
      {!noAdsense && (
        <Head>
          <script
            src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-4231427019106835"
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
