import React, { type ReactNode } from "react";
import Head from "@docusaurus/Head";
import useDocusaurusContext from "@docusaurus/useDocusaurusContext";
import Layout from "@theme/Layout";
import config from "@site/docusaurus.config";

export default function Home(): ReactNode {
  const { siteConfig } = useDocusaurusContext();

  return (
    <Layout title="Home" description={siteConfig.tagline}>
      <Head>
        <meta
          name="description"
          content="Local Desktop helps you run a rootless desktop Linux environment on Android phones and tablets."
        />
        <meta property="og:title" content="Local Desktop | Linux on Android" />
        <meta
          property="og:description"
          content="Local Desktop helps you run a rootless desktop Linux environment on Android phones and tablets."
        />
        <meta property="og:type" content="website" />
        <meta property="og:url" content="https://localdesktop.github.io/" />
        <meta name="twitter:card" content="summary_large_image" />
        <script type="application/ld+json">
          {JSON.stringify({
            "@context": "https://schema.org",
            "@type": "SoftwareApplication",
            name: "Local Desktop",
            applicationCategory: "DeveloperApplication",
            operatingSystem: "Android",
            description:
              "Local Desktop helps you run a rootless desktop Linux environment on Android phones and tablets.",
            url: "https://localdesktop.github.io/",
            downloadUrl: config.customFields.downloadUrl,
            codeRepository: config.customFields.repositoryUrl,
            license: "https://github.com/localdesktop/localdesktop.github.io/blob/main/LICENSE",
            offers: {
              "@type": "Offer",
              price: "0",
              priceCurrency: "USD",
            },
          })}
        </script>
      </Head>

      <h1 className="sr-only">Local Desktop</h1>
      <iframe className="home-game" src="/bear-war/?attract" title="Bear War" />
    </Layout>
  );
}
