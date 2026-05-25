import React, { type ReactNode, useEffect } from "react";
import clsx from "clsx";
import Link from "@docusaurus/Link";
import Head from "@docusaurus/Head";
import useDocusaurusContext from "@docusaurus/useDocusaurusContext";
import Layout from "@theme/Layout";
import Heading from "@theme/Heading";
import config from "@site/docusaurus.config";
import AudienceChart from "../components/audience-chart";
import HomeDarkModeEnforcer from "../components/home-dark-mode-enforcer";
import LatestNews from "../components/latest-news";
import { setChartInteractive, useChartInteractive } from "../hooks/use-chart-interactive";

type FeatureItem = {
  title: string;
  description: ReactNode;
};

const FEATURES: FeatureItem[] = [
  {
    title: "Rootless",
    description: (
      <>
        Local Desktop does <strong>not</strong> require root access to run.
      </>
    ),
  },
  {
    title: "Standalone",
    description: (
      <>
        Local Desktop allows you to start Linux on your Android device with just <strong>one</strong> tap,
        all in <strong>one</strong> app.
      </>
    ),
  },
  {
    title: "Efficient",
    description: (
      <>
        Local Desktop is built with <strong>Rust</strong> and runs entirely in native code. By using the{" "}
        <strong>Wayland</strong> protocol, it incurs less overhead compared to X or VNC alternatives.
      </>
    ),
  },
  {
    title: "FOSS",
    description: (
      <>
        Local Desktop is <strong>free and open-source</strong>, and will always be.
      </>
    ),
  },
];

function Feature({ title, description }: FeatureItem) {
  return (
    <div className="home-feature">
      <Heading as="h3" className="home-feature__title">
        {title}
      </Heading>
      <p className="home-feature__description">{description}</p>
    </div>
  );
}

export default function Home(): ReactNode {
  const { siteConfig } = useDocusaurusContext();
  const repositoryUrl = config.customFields.repositoryUrl as string;
  const chartInteractive = useChartInteractive();

  useEffect(() => {
    return () => setChartInteractive(false);
  }, []);

  useEffect(() => {
    if (!chartInteractive) {
      return undefined;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setChartInteractive(false);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [chartInteractive]);

  return (
    <Layout title="Home" description={siteConfig.tagline}>
      <HomeDarkModeEnforcer />
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

      <div className="home">
        <div
          className={clsx("home-bg", chartInteractive && "home-bg--interactive")}
          aria-hidden={chartInteractive ? undefined : "true"}
        >
          <button
            type="button"
            className="home-bg__scrim"
            aria-label="Close audience map"
            tabIndex={chartInteractive ? 0 : -1}
            onClick={() => setChartInteractive(false)}
          />
          <AudienceChart />
        </div>

        <div className={clsx("home-foreground", chartInteractive && "home-foreground--inactive")}>
          <section className="home-hero">
            <div className="home-hero__inner">
              <Heading as="h1" className="home-hero__title">
                {siteConfig.title}
              </Heading>
              <p className="home-hero__subtitle">{siteConfig.tagline}</p>
              <div className="home-hero__actions">
                <Link className="button button--primary button--lg" to={config.customFields.downloadUrl as string}>
                  Download APK
                </Link>
                <Link className="button button--secondary button--lg" to={`${repositoryUrl}/stargazers`}>
                  ⭐️ Star us on GitHub
                </Link>
              </div>
            </div>
          </section>

          <section className="home-section" aria-label="Features">
            <div className="home-features">
              {FEATURES.map((feature) => (
                <Feature key={feature.title} {...feature} />
              ))}
            </div>
          </section>

          <section className="home-section" aria-label="Vision">
            <blockquote className="home-quote">
              <p>
                "Android devices are becoming more powerful and capable of running desktop-grade
                applications. Android tablet manufacturers are making their screens bigger and packaging them
                with keyboards. Google is developing an in-house desktop mode in Android 16, adopting the
                trend that allows your phone to be plugged into a monitor and become a mini PC. These are signs
                of a positive future where you can perform work such as image editing, video production, running
                local web servers, inspecting the web, debugging the code, and doing software development - what
                you usually do on Linux - on Android.
              </p>
              <p>
                Software support is the missing piece, and Local Desktop provides just that. I believe this is
                the beginning of something super useful in the future. There is so much potential, so much more to
                develop."
              </p>
              <footer className="home-quote__attribution">- Mister Teddy</footer>
            </blockquote>
          </section>

          <LatestNews />
        </div>
      </div>
    </Layout>
  );
}
