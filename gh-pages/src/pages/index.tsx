import React, { type ReactNode, useEffect, useMemo, useState } from "react";
import Link from "@docusaurus/Link";
import Head from "@docusaurus/Head";
import useDocusaurusContext from "@docusaurus/useDocusaurusContext";
import Layout from "@theme/Layout";
import Heading from "@theme/Heading";
import config from "@site/docusaurus.config";
import AudienceChart from "../components/audience-chart";
import HomeDarkModeEnforcer from "../components/home-dark-mode-enforcer";
import type { Feed, Item } from "../types";

type BlogPost = {
  title: string;
  summary: string;
  url: string;
  date: string;
  image: string;
};

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

const FALLBACK_POSTS: BlogPost[] = [
  {
    title: "Googlebook makes Local Desktop more useful",
    summary: "A look at how Android desktop hardware makes local Linux workflows more practical.",
    url: "/blog/2026/05/13/googlebook-and-local-desktop",
    date: "2026-05-13",
    image: "/img/blog/googlebook-cast-my-apps.webp",
  },
  {
    title: "A Big Thank You to Our New Contributors",
    summary: "Recent contributor work, project momentum, and what changed in Local Desktop.",
    url: "/blog/2026/04/07/thank-you-new-contributors",
    date: "2026-04-07",
    image: "/img/blog/thank-you-new-contributors.png",
  },
  {
    title: "Anyone Can Code",
    summary: "Project notes on coding from Android, modern tooling, and building in public.",
    url: "/blog/2026/02/28/anyone-can-code",
    date: "2026-02-28",
    image: "/img/blog/anyone-can-code.webp",
  },
];

const POST_IMAGE_BY_SLUG: Record<string, string> = {
  "googlebook-and-local-desktop": "/img/blog/googlebook-cast-my-apps.webp",
  "thank-you-new-contributors": "/img/blog/thank-you-new-contributors.png",
  "anyone-can-code": "/img/blog/anyone-can-code.webp",
  "thank-you-for-1000-github-stars": "/img/blog/personal-pain.jpg",
  "kde-support": "/img/kde.webp",
  "built-in-gui-linux-support-on-android-canary": "/img/blog/codex-on-termux.webp",
};

function stripHtml(value?: string) {
  return (value || "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

function postSlug(url: string) {
  return url.split("/").filter(Boolean).pop() || "";
}

function normalizePost(post: Item, fallback: BlogPost): BlogPost {
  const slug = postSlug(post.url);

  return {
    title: post.title || fallback.title,
    summary: stripHtml(post.summary || post.content_html).slice(0, 150) || fallback.summary,
    url: post.url || fallback.url,
    date: String(post.date_modified || fallback.date).slice(0, 10),
    image: POST_IMAGE_BY_SLUG[slug] || fallback.image,
  };
}

function useLatestPosts() {
  const [posts, setPosts] = useState<BlogPost[]>(FALLBACK_POSTS);

  useEffect(() => {
    let cancelled = false;

    fetch("/blog/feed.json")
      .then<Feed>((res) => res.json())
      .then((data) => {
        if (cancelled) {
          return;
        }

        const latest = (data.items || []).map((post, index) =>
          normalizePost(post, FALLBACK_POSTS[index] || FALLBACK_POSTS[0]),
        );

        setPosts(latest.length ? latest : FALLBACK_POSTS);
      })
      .catch(() => {
        if (!cancelled) {
          setPosts(FALLBACK_POSTS);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return posts;
}

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

function BlogCard({ post, featured = false }: { post: BlogPost; featured?: boolean }) {
  return (
    <Link to={post.url} className={`home-post-card${featured ? " home-post-card--featured" : ""}`}>
      <img src={post.image} alt="" className="home-post-card__image" loading="lazy" />
      <div className="home-post-card__body">
        <p className="home-post-card__meta">{post.date}</p>
        <Heading as={featured ? "h3" : "h4"} className="home-post-card__title">
          {post.title}
        </Heading>
        {featured && <p className="home-post-card__summary">{post.summary}</p>}
      </div>
    </Link>
  );
}

export default function Home(): ReactNode {
  const { siteConfig } = useDocusaurusContext();
  const posts = useLatestPosts();
  const featuredPost = posts[0];
  const secondaryPosts = useMemo(() => posts.slice(1), [posts]);
  const repositoryUrl = config.customFields.repositoryUrl as string;

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
        <div className="home-bg" aria-hidden="true">
          <AudienceChart />
          <div className="home-bg__scrim" />
        </div>

        <div className="home-foreground">
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

          <section className="home-section" aria-labelledby="latest-news">
            <div className="home-section__header home-section__header--center">
              <Heading as="h2" id="latest-news">
                <Link to="/blog">Latest News</Link>
              </Heading>
            </div>

            <div className="home-blog-grid">
              <BlogCard post={featuredPost} featured />
              <div className="home-post-list">
                {secondaryPosts.map((post) => (
                  <BlogCard post={post} key={post.url} />
                ))}
              </div>
            </div>
          </section>
        </div>
      </div>
    </Layout>
  );
}
