import React, { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import Link from "@docusaurus/Link";
import Head from "@docusaurus/Head";
import useDocusaurusContext from "@docusaurus/useDocusaurusContext";
import Layout from "@theme/Layout";
import config from "@site/docusaurus.config";
import type { Feed, Item } from "../types";

type BlogPost = {
  title: string;
  summary: string;
  url: string;
  date: string;
  image: string;
};

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

const specs = [
  ["runtime", "Android + Linux"],
  ["display", "Wayland-first"],
  ["access", "rootless"],
  ["core", "Rust"],
];

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

        const latest = (data.items || [])
          .slice(0, 3)
          .map((post, index) => normalizePost(post, FALLBACK_POSTS[index] || FALLBACK_POSTS[0]));

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

function TerminalScene() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pointerRef = useRef({ x: 0, y: 0 });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    let disposed = false;
    let frame = 0;
    let cleanup = () => {};

    import("three").then(async (THREE) => {
      const { GLTFLoader } = await import("three/addons/loaders/GLTFLoader.js");
      if (disposed) {
        return;
      }

      const loader = new GLTFLoader();
      const loadModel = (url: string) => new Promise<import("three").Group>((resolve) => {
        loader.load(
          url,
          (gltf) => {
            const group = new THREE.Group();
            group.add(gltf.scene);
            resolve(group);
          },
          undefined,
          () => resolve(new THREE.Group()),
        );
      });

      const androidModel = await loadModel("/models/android.glb");
      const linuxModel = await loadModel("/models/linux.glb");

      if (disposed) {
        return;
      }

      const renderer = new THREE.WebGLRenderer({
        canvas,
        alpha: true,
        antialias: true,
        powerPreference: "high-performance",
      });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.shadowMap.enabled = true;

      const scene = new THREE.Scene();
      scene.fog = new THREE.Fog(0xdbeafe, 8, 28);

      const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
      camera.position.set(0, 4.9, 10.6);

      const root = new THREE.Group();
      scene.add(root);

      const arctic = new THREE.Group();
      root.add(arctic);

      const walkers: Array<{
        group: import("three").Group;
        speed: number;
        phase: number;
        bob: number;
        direction: 1 | -1;
      }> = [];

      const addWalker = (
        group: import("three").Group,
        speed: number,
        phase: number,
        scale: number,
        direction: 1 | -1,
      ) => {
        group.scale.setScalar(scale);
        arctic.add(group);
        walkers.push({ group, speed, phase, bob: 0.05 + scale * 0.04, direction });
      };

      const generateWalkers = () => {
        const models = [
          { model: androidModel, direction: 1 as const },
          { model: linuxModel, direction: -1 as const },
        ];
        for (let i = 0; i < 55; i++) {
          const { model, direction } = models[i % models.length];
          const speed = 0.2 + Math.random() * 0.4;
          const phase = Math.random() * Math.PI * 2;
          addWalker(model.clone(), speed, phase, 0.5 + Math.random() * 0.5, direction);
        }
      };
      generateWalkers();

      const ambient = new THREE.HemisphereLight(0xffffff, 0x8fb3c8, 2.1);
      const key = new THREE.DirectionalLight(0xffffff, 2.7);
      key.position.set(4, 6.4, 4.8);
      key.castShadow = true;
      key.shadow.mapSize.set(1024, 1024);
      const redBeacon = new THREE.PointLight(0xff0000, 7, 11);
      redBeacon.position.set(-2.5, 1.3, 2.6);
      const spotTarget = new THREE.Object3D();
      spotTarget.position.set(0, -0.45, 0);
      scene.add(spotTarget);
      const spotlight = new THREE.SpotLight(0xffffff, 9, 16, Math.PI / 4.5, 0.62, 1.1);
      spotlight.position.set(0, 5.2, 4.2);
      spotlight.target = spotTarget;
      spotlight.castShadow = true;
      scene.add(ambient, key, redBeacon, spotlight);

      const resize = () => {
        const rect = canvas.getBoundingClientRect();
        const width = Math.max(1, rect.width);
        const height = Math.max(1, rect.height);
        renderer.setSize(width, height, false);
        camera.aspect = width / height;
        camera.position.set(0, 5, 12);
        camera.lookAt(0, 0, 0);
        root.scale.setScalar(width < 520 ? 1.4 : 1.2);
        camera.updateProjectionMatrix();
      };

      const observer = new ResizeObserver(resize);
      observer.observe(canvas);
      resize();

      const animate = () => {
        const time = performance.now() * 0.001;
        root.rotation.y += (pointerRef.current.x * 0.12 + Math.sin(time * 0.22) * 0.05 - root.rotation.y) * 0.05;
        arctic.rotation.y = Math.sin(time * 0.18) * 0.04;
        walkers.forEach((walker, index) => {
          const speed = walker.speed * 2.5;
          const x = ((((time * speed * walker.direction) + walker.phase * 8) % 24) + 24) % 24 - 12;
          const z = Math.sin(walker.phase + index) * 3;
          walker.group.position.set(x, -0.76 + Math.abs(Math.sin(time * 5 + index)) * walker.bob, z);
          walker.group.rotation.y = walker.direction === 1 ? -Math.PI / 2 : Math.PI / 2;
          walker.group.rotation.z = Math.sin(time * 4 + index) * 0.045;
        });
        redBeacon.intensity = 5.5 + Math.sin(time * 2.4) * 1.6;
        spotlight.position.x = Math.sin(time * 0.8) * 2.2;
        spotlight.position.z = 3.6 + Math.cos(time * 0.7) * 0.8;
        spotlight.intensity = 7.5 + Math.sin(time * 2.8) * 1.4;

        renderer.render(scene, camera);
        frame = window.requestAnimationFrame(animate);
      };

      animate();

      cleanup = () => {
        window.cancelAnimationFrame(frame);
        observer.disconnect();
        scene.traverse((object) => {
          const mesh = object as import("three").Mesh;
          mesh.geometry?.dispose();
          const material = mesh.material as import("three").Material | import("three").Material[] | undefined;
          if (Array.isArray(material)) {
            material.forEach((item) => item.dispose());
          } else {
            material?.dispose();
          }
        });
        renderer.dispose();
      };
    });

    const onPointerMove = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      pointerRef.current = {
        x: ((event.clientX - rect.left) / rect.width - 0.5) * 2,
        y: ((event.clientY - rect.top) / rect.height - 0.5) * 2,
      };
    };

    canvas.addEventListener("pointermove", onPointerMove);

    return () => {
      disposed = true;
      canvas.removeEventListener("pointermove", onPointerMove);
      cleanup();
    };
  }, []);

  return <canvas ref={canvasRef} className="ldScene" aria-label="Animated arctic 3D scene with Android mascots and Linux penguins" />;
}

export default function Home(): ReactNode {
  const { siteConfig } = useDocusaurusContext();
  const posts = useLatestPosts();
  const featuredPost = posts[0];
  const secondaryPosts = useMemo(() => posts.slice(1), [posts]);

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
          content="A hacker-style landing page for Local Desktop, the rootless Linux desktop environment for Android."
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
      <style>{homeStyles}</style>
      <TerminalScene />
      <main className="ldHome">
        <section className="ldHero">
          <div className="ldHeroCopy">
            <p className="ldPrompt">app.polarbear</p>
            <h1>Local Desktop</h1>
            <p className="ldHeroText">{siteConfig.tagline}</p>
            <div className="ldActions">
              <Link className="button button--primary" to={config.customFields.downloadUrl as string}>
                Download APK
              </Link>
              <Link className="button button--secondary" to="/docs/user/getting-started">
                Read Manual
              </Link>
            </div>
          </div>
        </section>

        <section className="ldBlog" aria-labelledby="latest-news">
          <div className="ldSectionHeader">
            <h2 id="latest-news">Latest posts</h2>
            <Link to="/blog">View all posts</Link>
          </div>

          <div className="ldPostGrid">
            <Link className="ldFeaturedPost" to={featuredPost.url}>
              <img src={featuredPost.image} alt="" loading="lazy" />
              <div>
                <span>{featuredPost.date}</span>
                <h3>{featuredPost.title}</h3>
                <p>{featuredPost.summary}</p>
              </div>
            </Link>

            <div className="ldPostList">
              {secondaryPosts.map((post) => (
                <Link className="ldPostItem" to={post.url} key={post.url}>
                  <img src={post.image} alt="" loading="lazy" />
                  <div>
                    <span>{post.date}</span>
                    <h3>{post.title}</h3>
                    <p>{post.summary}</p>
                  </div>
                </Link>
              ))}
            </div>
          </div>
        </section>

        <section className="ldSpecs" aria-label="Local Desktop technical profile">
          {specs.map(([label, value]) => (
            <div className="ldSpec" key={label}>
              <span>{label}</span>
              <strong>{value}</strong>
            </div>
          ))}
        </section>

        <section className="ldAbout">
          <div>
            <h2>Desktop Linux, running locally on Android hardware.</h2>
          </div>
          <p>
            Local Desktop packages the rough pieces of an Android Linux workstation into one open-source app:
            rootless setup, a desktop session, Wayland-oriented display work, and practical docs for people who
            want to build, debug, and run real tools from a phone, tablet, or docked device.
          </p>
        </section>
      </main>
    </Layout>
  );
}

const homeStyles = `
.ldHome {
  min-height: 100vh;
  background: transparent;
  color: var(--ld-ink);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
}
.ldHero {
  display: flex;
  flex-direction: column;
  gap: 32px;
  width: min(1180px, calc(100% - 36px));
  min-height: auto;
  margin: 0 auto;
  padding: clamp(20px, 4vw, 38px) 0 14px;
}

.ldHeroCopy,
.ldAbout,
.ldBlog {
  position: relative;
  z-index: 1;
}

.ldPrompt {
  color: var(--ld-accent-bright);
  font-size: 0.84rem;
  font-weight: 800;
  line-height: 1.45;
  margin: 0 0 14px;
}

.ldHero h1,
.ldAbout h2,
.ldSectionHeader h2 {
  margin: 0;
  color: var(--ld-ink);
  font-family: inherit;
  letter-spacing: 0;
}

.ldHero h1 {
  max-width: 10.5ch;
  font-size: clamp(3.3rem, 7vw, 5.8rem);
  line-height: 0.86;
  text-transform: uppercase;
  text-shadow: 3px 3px 0 var(--ld-shadow-accent);
}

.ldHeroText {
  max-width: 610px;
  margin: 16px 0 0;
  color: var(--ld-muted);
  font-size: clamp(1rem, 2vw, 1.22rem);
  line-height: 1.55;
}

.ldActions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 18px;
}

.ldHome .button {
  border-radius: 8px;
  font-family: inherit;
  font-weight: 900;
}

.ldHome .button--secondary {
  border-color: var(--ld-border);
  background: var(--ld-surface);
  color: var(--ld-ink);
}

.ldScene {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  z-index: 0;
  pointer-events: none;
}

.ldSpecs {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 1px;
  width: min(1180px, calc(100% - 36px));
  margin: clamp(28px, 5vw, 56px) auto 0;
  border: 1px solid var(--ld-border);
  background: var(--ld-border);
}

.ldSpec {
  padding: 20px;
  background: var(--ld-surface-strong);
}

.ldSpec span,
.ldPostGrid span {
  display: block;
  color: var(--ld-accent-bright);
  font-size: 0.76rem;
  font-weight: 900;
  text-transform: uppercase;
}

.ldSpec strong {
  display: block;
  margin-top: 8px;
  color: var(--ld-ink);
  font-size: clamp(1rem, 2vw, 1.3rem);
}

.ldAbout,
.ldBlog {
  width: min(1180px, calc(100% - 36px));
  margin: 0 auto;
  padding: clamp(34px, 5vw, 58px) 0;
}

.ldAbout {
  display: grid;
  grid-template-columns: minmax(0, 0.85fr) minmax(0, 1fr);
  gap: clamp(24px, 5vw, 64px);
  align-items: start;
}

.ldAbout h2,
.ldSectionHeader h2 {
  font-size: clamp(2rem, 4vw, 4rem);
  line-height: 0.98;
}

.ldAbout > p {
  margin: 4px 0 0;
  color: var(--ld-muted);
  font-size: clamp(1rem, 1.6vw, 1.14rem);
  line-height: 1.75;
}

.ldSectionHeader {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 10px 20px;
  align-items: end;
  margin-bottom: 24px;
}

.ldSectionHeader a {
  color: var(--ld-accent-bright);
  font-weight: 900;
}

.ldPostGrid {
  display: grid;
  grid-template-columns: minmax(0, 1.12fr) minmax(320px, 0.88fr);
  gap: 18px;
}

.ldFeaturedPost,
.ldPostItem {
  border: 1px solid var(--ld-border);
  border-radius: 8px;
  background: var(--ld-surface-strong);
  color: var(--ld-ink);
  overflow: hidden;
  text-decoration: none;
  transition: border-color 160ms ease, transform 160ms ease, box-shadow 160ms ease;
}

.ldFeaturedPost:hover,
.ldPostItem:hover {
  border-color: var(--ld-accent-bright);
  color: var(--ld-ink);
  text-decoration: none;
  transform: translateY(-3px);
  box-shadow: 0 20px 54px var(--ld-shadow-accent);
}

.ldFeaturedPost {
  display: grid;
  grid-template-rows: minmax(220px, 0.72fr) auto;
}

.ldFeaturedPost img,
.ldPostItem img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  background: #111827;
}

.ldFeaturedPost > div,
.ldPostItem > div {
  padding: 18px;
}

.ldFeaturedPost h3,
.ldPostItem h3 {
  margin: 10px 0 0;
  color: var(--ld-ink);
  font-family: inherit;
  letter-spacing: 0;
  line-height: 1.08;
}

.ldFeaturedPost h3 {
  font-size: clamp(1.55rem, 2.8vw, 2.7rem);
}

.ldPostItem h3 {
  font-size: 1.2rem;
}

.ldFeaturedPost p,
.ldPostItem p {
  margin: 12px 0 0;
  color: var(--ld-muted);
  line-height: 1.55;
}

.ldPostList {
  display: grid;
  gap: 18px;
}

.ldPostItem {
  display: grid;
  grid-template-columns: 148px minmax(0, 1fr);
}

@media (max-width: 960px) {
  .ldHero,
  .ldAbout,
  .ldPostGrid {
    grid-template-columns: 1fr;
  }

  .ldHero {
    min-height: auto;
  }

  .ldScene {
    height: 310px;
  }

  .ldSpecs {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 620px) {
  .ldHero {
    width: min(100% - 28px, 1180px);
    padding-top: 22px;
  }

  .ldHero h1 {
    font-size: clamp(2.8rem, 15vw, 4rem);
  }

  .ldSpecs,
  .ldAbout,
  .ldBlog {
    width: min(100% - 28px, 1180px);
  }

  .ldSpecs {
    grid-template-columns: 1fr;
  }

  .ldSectionHeader {
    grid-template-columns: 1fr;
  }

  .ldFeaturedPost {
    grid-template-rows: 220px auto;
  }

  .ldPostItem {
    grid-template-columns: 112px minmax(0, 1fr);
  }

  .ldPostItem > div {
    padding: 14px;
  }

  .ldPostItem p {
    display: none;
  }
}
`;
