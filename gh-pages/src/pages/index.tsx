import type { ReactNode } from "react";
import useDocusaurusContext from "@docusaurus/useDocusaurusContext";
import Layout from "@theme/Layout";
import Hero from "@site/src/components/hero";
import Features from "@site/src/components/features";
import Future from "../components/future";
import LatestNews from "../components/latest-news";

export default function Home(): ReactNode {
  const { siteConfig } = useDocusaurusContext();
  return (
    <Layout title="Home" description={siteConfig.tagline}>
      <Hero />
      <main>
        <Features />
        <Future />
        <LatestNews />
      </main>
    </Layout>
  );
}
