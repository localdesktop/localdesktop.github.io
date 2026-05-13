import React, { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import Link from "@docusaurus/Link";
import Head from "@docusaurus/Head";
import useDocusaurusContext from "@docusaurus/useDocusaurusContext";
import Layout from "@theme/Layout";
import config from "@site/docusaurus.config";
import type { Feed, Item } from "../types";

type Stage = {
  eyebrow: string;
  title: string;
  body: string;
  facts: string[];
  action?: {
    label: string;
    to: string;
  };
};

const stages: Stage[] = [
  {
    eyebrow: "Linux on Android",
    title: "Local Desktop turns an Android device into a Linux workstation.",
    body: "Start a desktop Linux environment directly from your phone or tablet, then use the screen, keyboard, monitor, and storage you already have.",
    facts: ["Rootless setup", "One-tap launch", "Desktop apps on mobile hardware"],
    action: {
      label: "Download APK",
      to: config.customFields.downloadUrl as string,
    },
  },
  {
    eyebrow: "Simple Setup",
    title: "No root access and no separate companion app.",
    body: "Local Desktop is built to run as a standalone Android app. It handles the Linux environment, display stack, and launch path from one place.",
    facts: ["Rootless", "Standalone", "Made for phones and tablets"],
    action: {
      label: "Getting Started",
      to: "/docs/user/getting-started",
    },
  },
  {
    eyebrow: "Native Performance",
    title: "Rust, Wayland, and native code keep overhead low.",
    body: "The app avoids the usual VNC-style path. It uses Wayland and native components so desktop sessions feel closer to the device.",
    facts: ["Rust core", "Wayland display", "Less protocol overhead"],
    action: {
      label: "How It Works",
      to: "/docs/developer/how-it-works",
    },
  },
  {
    eyebrow: "Open Source",
    title: "Free software that stays inspectable and hackable.",
    body: "Local Desktop is free and open-source. Developers can read the internals, build it locally, and help improve Android desktop workflows.",
    facts: ["FOSS", "Public source", "Developer docs included"],
    action: {
      label: "Star on GitHub",
      to: `${config.customFields.repositoryUrl}/stargazers`,
    },
  },
  {
    eyebrow: "Why It Matters",
    title: "Android devices are ready for more desktop-grade work.",
    body: "Large tablets, keyboard cases, external monitors, and Android desktop mode all point in the same direction: mobile devices are becoming practical local work machines.",
    facts: ["Coding", "Image editing", "Local servers and debugging"],
    action: {
      label: "App Compatibility",
      to: "/docs/user/app-compatibility/gimp",
    },
  },
  {
    eyebrow: "Project Updates",
    title: "Follow the roadmap, releases, and technical notes.",
    body: "The news page tracks release notes, contributor updates, compatibility work, and the larger direction for Linux desktop support on Android.",
    facts: ["Release news", "Community updates", "Technical notes"],
    action: {
      label: "Read News",
      to: "/blog",
    },
  },
];

function useLatestPosts() {
  const [posts, setPosts] = useState<Item[]>([]);

  useEffect(() => {
    let cancelled = false;

    fetch("/blog/feed.json")
      .then<Feed>((res) => res.json())
      .then((data) => {
        if (!cancelled) {
          setPosts(data.items?.slice(0, 3) || []);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPosts([]);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return posts;
}

function DesktopScene({ activeStage }: { activeStage: number }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pointerRef = useRef({ x: 0, y: 0 });
  const activeRef = useRef(activeStage);

  useEffect(() => {
    activeRef.current = activeStage;
  }, [activeStage]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    let disposed = false;
    let animationFrame = 0;
    let cleanup = () => {};

    import("three").then((THREE) => {
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

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100);
      camera.position.set(0, 0.55, 8.4);

      const group = new THREE.Group();
      scene.add(group);

      const shell = new THREE.Mesh(
        new THREE.BoxGeometry(3.8, 5.6, 0.34),
        new THREE.MeshStandardMaterial({
          color: 0x111827,
          metalness: 0.35,
          roughness: 0.38,
        }),
      );
      shell.rotation.x = -0.05;
      group.add(shell);

      const screen = new THREE.Mesh(
        new THREE.BoxGeometry(3.34, 4.82, 0.04),
        new THREE.MeshStandardMaterial({
          color: 0x0b1020,
          emissive: 0x0a2342,
          emissiveIntensity: 0.55,
          roughness: 0.22,
        }),
      );
      screen.position.z = 0.2;
      screen.rotation.x = -0.05;
      group.add(screen);

      const desktop = new THREE.Group();
      desktop.position.set(0, 0, 0.26);
      desktop.rotation.x = -0.05;
      group.add(desktop);

      const palette = [0x14b8a6, 0x60a5fa, 0xf59e0b, 0xf43f5e, 0xa78bfa, 0x22c55e];

      for (let row = 0; row < 3; row += 1) {
        for (let col = 0; col < 3; col += 1) {
          const tile = new THREE.Mesh(
            new THREE.BoxGeometry(0.62, 0.46, 0.035),
            new THREE.MeshStandardMaterial({
              color: palette[(row * 3 + col) % palette.length],
              emissive: palette[(row * 3 + col) % palette.length],
              emissiveIntensity: 0.13,
              roughness: 0.5,
            }),
          );
          tile.position.set(-1.05 + col * 1.05, 1.3 - row * 0.72, 0.05 + row * 0.01);
          desktop.add(tile);
        }
      }

      const terminal = new THREE.Mesh(
        new THREE.BoxGeometry(2.6, 1.16, 0.055),
        new THREE.MeshStandardMaterial({
          color: 0x050816,
          emissive: 0x003f3f,
          emissiveIntensity: 0.3,
          roughness: 0.35,
        }),
      );
      terminal.position.set(0, -1.36, 0.08);
      desktop.add(terminal);

      for (let i = 0; i < 5; i += 1) {
        const line = new THREE.Mesh(
          new THREE.BoxGeometry(1.7 - i * 0.18, 0.045, 0.02),
          new THREE.MeshStandardMaterial({
            color: i % 2 ? 0x93c5fd : 0x5eead4,
            emissive: i % 2 ? 0x1d4ed8 : 0x0f766e,
            emissiveIntensity: 0.5,
          }),
        );
        line.position.set(-0.27, -1.04 - i * 0.16, 0.13);
        desktop.add(line);
      }

      const orbit = new THREE.Group();
      scene.add(orbit);
      for (let i = 0; i < stages.length; i += 1) {
        const node = new THREE.Mesh(
          new THREE.IcosahedronGeometry(0.12, 1),
          new THREE.MeshStandardMaterial({
            color: palette[i % palette.length],
            emissive: palette[i % palette.length],
            emissiveIntensity: 0.25,
            roughness: 0.4,
          }),
        );
        const angle = (Math.PI * 2 * i) / stages.length;
        node.position.set(Math.cos(angle) * 3.15, Math.sin(angle) * 1.85, -0.45);
        orbit.add(node);
      }

      const ambient = new THREE.AmbientLight(0xffffff, 1.8);
      const key = new THREE.DirectionalLight(0xffffff, 2.2);
      key.position.set(2.8, 4.4, 5.6);
      const rim = new THREE.PointLight(0x5eead4, 2.8, 8);
      rim.position.set(-2.6, -1.4, 2.8);
      scene.add(ambient, key, rim);

      const resize = () => {
        const rect = canvas.getBoundingClientRect();
        const width = Math.max(1, rect.width);
        const height = Math.max(1, rect.height);
        renderer.setSize(width, height, false);
        camera.aspect = width / height;
        camera.position.z = width < 680 ? 9.6 : 8.4;
        group.scale.setScalar(width < 680 ? 0.78 : 1);
        camera.updateProjectionMatrix();
      };

      const observer = new ResizeObserver(resize);
      observer.observe(canvas);
      resize();

      const animate = () => {
        const time = performance.now() * 0.001;
        const stageAngle = (activeRef.current / stages.length) * Math.PI * 2;
        const pointerX = pointerRef.current.x * 0.18;
        const pointerY = pointerRef.current.y * 0.12;

        group.rotation.y += (Math.sin(stageAngle) * 0.34 + pointerX - group.rotation.y) * 0.055;
        group.rotation.x += (Math.cos(stageAngle) * 0.1 - pointerY - group.rotation.x) * 0.055;
        group.position.y = Math.sin(time * 1.4) * 0.08;
        desktop.position.z = 0.26 + Math.sin(time * 1.7 + activeRef.current) * 0.035;
        orbit.rotation.z = time * 0.18 + stageAngle;
        orbit.rotation.y = Math.sin(time * 0.45) * 0.25;

        orbit.children.forEach((node, index) => {
          const mesh = node as import("three").Mesh;
          const selected = index === activeRef.current;
          const scale = selected ? 1.75 + Math.sin(time * 3) * 0.08 : 1;
          mesh.scale.setScalar(scale);
        });

        renderer.render(scene, camera);
        animationFrame = window.requestAnimationFrame(animate);
      };

      animate();

      cleanup = () => {
        window.cancelAnimationFrame(animationFrame);
        observer.disconnect();
        scene.traverse((object) => {
          const mesh = object as import("three").Mesh;
          mesh.geometry?.dispose();
          const material = mesh.material as
            | import("three").Material
            | import("three").Material[]
            | undefined;
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

  return <canvas ref={canvasRef} className="ldHomeScene" aria-hidden="true" />;
}

export default function Home(): ReactNode {
  const { siteConfig } = useDocusaurusContext();
  const [activeStage, setActiveStage] = useState(0);
  const posts = useLatestPosts();
  const stage = stages[activeStage];

  useEffect(() => {
    document.body.classList.add("ldHomeBodyLock");

    return () => {
      document.body.classList.remove("ldHomeBodyLock");
    };
  }, []);

  const newsFacts = useMemo(() => {
    if (!posts.length) {
      return stage.facts;
    }

    return posts.map((post) => post.title);
  }, [posts, stage.facts]);

  const displayedFacts = activeStage === stages.length - 1 ? newsFacts : stage.facts;

  const moveStage = (offset: number) => {
    setActiveStage((current) => (current + offset + stages.length) % stages.length);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (["ArrowRight", "ArrowDown"].includes(event.key)) {
      event.preventDefault();
      moveStage(1);
    }

    if (["ArrowLeft", "ArrowUp"].includes(event.key)) {
      event.preventDefault();
      moveStage(-1);
    }

    const numeric = Number(event.key);
    if (numeric >= 1 && numeric <= stages.length) {
      setActiveStage(numeric - 1);
    }
  };

  return (
    <Layout title="Home" description={siteConfig.tagline}>
      <Head>
        <meta
          name="description"
          content="Run a desktop Linux environment on Android with Local Desktop."
        />
        <meta
          property="og:title"
          content="Local Desktop | Linux on Android"
        />
        <meta
          property="og:description"
          content="Local Desktop helps you run a rootless desktop Linux environment on Android phones and tablets."
        />
        <meta property="og:type" content="website" />
        <meta property="og:url" content="https://localdesktop.github.io/" />
        <meta
          name="twitter:card"
          content="summary_large_image"
        />
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
      <main
        className="ldHome"
        tabIndex={0}
        onKeyDown={handleKeyDown}
        aria-label="Interactive Local Desktop homepage. Use arrow keys to change sections."
      >
        <DesktopScene activeStage={activeStage} />
        <div className="ldHomeBackdrop" />

        <section className="ldHomeCopy" aria-live="polite">
          <p className="ldHomeEyebrow">{stage.eyebrow}</p>
          <h1>{activeStage === 0 ? "Local Desktop" : stage.title}</h1>
          <p className="ldHomeBody">{activeStage === 0 ? siteConfig.tagline : stage.body}</p>
          <div className="ldHomeActions">
            {stage.action && (
              <Link className="button button--primary" to={stage.action.to}>
                {stage.action.label}
              </Link>
            )}
            <Link className="button button--secondary" to="/docs/user/getting-started">
              User Manual
            </Link>
          </div>
        </section>

        <aside className="ldHomePanel">
          <div className="ldHomePanelHeader">
            <span>0{activeStage + 1}</span>
            <strong>{stage.eyebrow}</strong>
          </div>
          <div className="ldHomeFacts">
            {displayedFacts.map((fact) => (
              <span key={fact}>{fact}</span>
            ))}
          </div>
          <div className="ldHomeLinks" aria-label="Helpful links">
            <Link to="/docs/user/getting-started">Start</Link>
            <Link to="/docs/developer/how-to-build">Build</Link>
            <Link to="/support-us">Support</Link>
          </div>
        </aside>

        <nav className="ldHomeStages" aria-label="Homepage sections">
          {stages.map((item, index) => (
            <button
              key={item.eyebrow}
              type="button"
              className={index === activeStage ? "isActive" : ""}
              onClick={() => setActiveStage(index)}
              aria-pressed={index === activeStage}
            >
              <span>{index + 1}</span>
              {item.eyebrow}
            </button>
          ))}
        </nav>

        <section className="ldHomeSeo" aria-label="Local Desktop overview">
          <h2>Local Desktop for Android</h2>
          <p>{siteConfig.tagline}</p>
          {stages.map((item) => (
            <article key={item.eyebrow}>
              <h3>{item.title}</h3>
              <p>{item.body}</p>
              <ul>
                {item.facts.map((fact) => (
                  <li key={fact}>{fact}</li>
                ))}
              </ul>
              {item.action && <Link to={item.action.to}>{item.action.label}</Link>}
            </article>
          ))}
          <nav aria-label="Homepage reference links">
            <Link to="/docs/user/getting-started">User Manual</Link>
            <Link to="/docs/developer/how-to-build">Developer Manual</Link>
            <Link to="/blog">News</Link>
            <Link to="/support-us">Support Local Desktop</Link>
          </nav>
        </section>
      </main>
    </Layout>
  );
}

const homeStyles = `
body.ldHomeBodyLock {
  overflow: hidden;
}

body.ldHomeBodyLock .footer {
  display: none;
}

.ldHome {
  position: relative;
  height: calc(100dvh - var(--ifm-navbar-height));
  min-height: 560px;
  overflow: hidden;
  background:
    radial-gradient(circle at 18% 22%, rgba(20, 184, 166, 0.18), transparent 30%),
    radial-gradient(circle at 82% 74%, rgba(245, 158, 11, 0.16), transparent 28%),
    linear-gradient(135deg, #f8fafc 0%, #dfe8f0 48%, #f4efe6 100%);
  color: #101827;
  isolation: isolate;
}

html[data-theme="dark"] .ldHome {
  background:
    radial-gradient(circle at 20% 18%, rgba(45, 212, 191, 0.18), transparent 32%),
    radial-gradient(circle at 82% 76%, rgba(245, 158, 11, 0.12), transparent 30%),
    linear-gradient(135deg, #020617 0%, #0f172a 52%, #17110a 100%);
  color: #f8fafc;
}

.ldHome:focus {
  outline: none;
}

.ldHomeBackdrop {
  position: absolute;
  inset: 0;
  z-index: 1;
  background:
    linear-gradient(90deg, rgba(248, 250, 252, 0.96) 0%, rgba(248, 250, 252, 0.78) 36%, rgba(248, 250, 252, 0) 68%),
    linear-gradient(0deg, rgba(248, 250, 252, 0.86) 0%, rgba(248, 250, 252, 0) 28%);
  pointer-events: none;
}

html[data-theme="dark"] .ldHomeBackdrop {
  background:
    linear-gradient(90deg, rgba(2, 6, 23, 0.94) 0%, rgba(2, 6, 23, 0.7) 34%, rgba(2, 6, 23, 0) 70%),
    linear-gradient(0deg, rgba(2, 6, 23, 0.86) 0%, rgba(2, 6, 23, 0) 30%);
}

.ldHomeScene {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  z-index: 0;
  touch-action: none;
}

.ldHomeSeo {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: normal;
}

.ldHomeCopy {
  position: relative;
  z-index: 2;
  display: flex;
  flex-direction: column;
  justify-content: center;
  width: min(650px, calc(100% - 48px));
  height: calc(100% - 118px);
  margin-left: clamp(24px, 7vw, 108px);
  padding-bottom: 34px;
}

.ldHomeEyebrow {
  margin: 0 0 12px;
  color: #0f766e;
  font-size: 0.82rem;
  font-weight: 800;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

html[data-theme="dark"] .ldHomeEyebrow {
  color: #5eead4;
}

.ldHomeCopy h1 {
  max-width: 12ch;
  margin: 0;
  color: inherit;
  font-size: clamp(2.55rem, 7.2vw, 6.6rem);
  line-height: 0.92;
  letter-spacing: 0;
}

.ldHomeBody {
  max-width: 620px;
  margin: 20px 0 0;
  color: rgba(15, 23, 42, 0.78);
  font-size: clamp(1rem, 2vw, 1.22rem);
  line-height: 1.55;
}

html[data-theme="dark"] .ldHomeBody {
  color: rgba(248, 250, 252, 0.78);
}

.ldHomeActions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 26px;
}

.ldHomeActions .button {
  border-radius: 8px;
}

.ldHomePanel {
  position: absolute;
  right: clamp(18px, 5vw, 76px);
  bottom: 96px;
  z-index: 3;
  width: min(390px, 36vw);
  padding: 18px;
  border: 1px solid rgba(15, 23, 42, 0.13);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.72);
  box-shadow: 0 24px 70px rgba(15, 23, 42, 0.16);
  backdrop-filter: blur(18px);
}

html[data-theme="dark"] .ldHomePanel {
  border-color: rgba(255, 255, 255, 0.14);
  background: rgba(15, 23, 42, 0.58);
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.36);
}

.ldHomePanelHeader {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;
  font-size: 0.88rem;
}

.ldHomePanelHeader span {
  color: #0f766e;
  font-weight: 800;
}

html[data-theme="dark"] .ldHomePanelHeader span {
  color: #5eead4;
}

.ldHomeFacts {
  display: grid;
  gap: 8px;
}

.ldHomeFacts span {
  display: block;
  padding: 9px 11px;
  border: 1px solid rgba(15, 23, 42, 0.12);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.48);
  color: rgba(15, 23, 42, 0.82);
  font-size: 0.92rem;
  line-height: 1.25;
}

html[data-theme="dark"] .ldHomeFacts span {
  border-color: rgba(255, 255, 255, 0.13);
  background: rgba(255, 255, 255, 0.06);
  color: rgba(248, 250, 252, 0.82);
}

.ldHomeLinks {
  display: flex;
  gap: 12px;
  margin-top: 16px;
  font-size: 0.9rem;
  font-weight: 700;
}

.ldHomeStages {
  position: absolute;
  right: clamp(18px, 5vw, 76px);
  bottom: 26px;
  left: clamp(18px, 7vw, 108px);
  z-index: 4;
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 8px;
}

.ldHomeStages button {
  min-width: 0;
  height: 44px;
  padding: 0 10px;
  border: 1px solid rgba(15, 23, 42, 0.16);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.62);
  color: rgba(15, 23, 42, 0.72);
  cursor: pointer;
  font: inherit;
  font-size: 0.78rem;
  font-weight: 800;
  text-align: left;
  backdrop-filter: blur(14px);
  transition: transform 160ms ease, background 160ms ease, color 160ms ease;
}

.ldHomeStages button:hover,
.ldHomeStages button:focus-visible,
.ldHomeStages button.isActive {
  background: #0f766e;
  color: white;
  transform: translateY(-2px);
}

.ldHomeStages button span {
  margin-right: 8px;
  opacity: 0.72;
}

html[data-theme="dark"] .ldHomeStages button {
  border-color: rgba(255, 255, 255, 0.15);
  background: rgba(15, 23, 42, 0.58);
  color: rgba(248, 250, 252, 0.74);
}

html[data-theme="dark"] .ldHomeStages button:hover,
html[data-theme="dark"] .ldHomeStages button:focus-visible,
html[data-theme="dark"] .ldHomeStages button.isActive {
  background: #14b8a6;
  color: #031311;
}

@media (max-width: 960px) {
  .ldHome {
    min-height: 620px;
  }

  .ldHomeBackdrop {
    background:
      linear-gradient(180deg, rgba(248, 250, 252, 0.92) 0%, rgba(248, 250, 252, 0.58) 50%, rgba(248, 250, 252, 0.92) 100%);
  }

  html[data-theme="dark"] .ldHomeBackdrop {
    background:
      linear-gradient(180deg, rgba(2, 6, 23, 0.9) 0%, rgba(2, 6, 23, 0.48) 50%, rgba(2, 6, 23, 0.9) 100%);
  }

  .ldHomeCopy {
    justify-content: flex-start;
    width: calc(100% - 36px);
    height: auto;
    margin-left: 18px;
    padding-top: clamp(20px, 5dvh, 54px);
  }

  .ldHomeCopy h1 {
    max-width: 13ch;
  }

  .ldHomeBody {
    max-width: 560px;
  }

  .ldHomePanel {
    right: 18px;
    bottom: 104px;
    left: 18px;
    width: auto;
    padding: 14px;
  }

  .ldHomeFacts {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .ldHomeStages {
    right: 12px;
    bottom: 16px;
    left: 12px;
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

@media (max-width: 560px) {
  .ldHome {
    min-height: 0;
  }

  .ldHomeCopy {
    padding-top: 18px;
  }

  .ldHomeCopy h1 {
    max-width: 11.5ch;
    font-size: clamp(2.08rem, 12vw, 3.45rem);
  }

  .ldHomeBody {
    display: -webkit-box;
    margin-top: 12px;
    overflow: hidden;
    font-size: 0.96rem;
    line-height: 1.42;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 3;
  }

  .ldHomeActions {
    gap: 8px;
    margin-top: 14px;
  }

  .ldHomeActions .button {
    padding: 0.48rem 0.64rem;
    font-size: 0.85rem;
  }

  .ldHomePanel {
    bottom: 100px;
  }

  .ldHomePanelHeader {
    margin-bottom: 10px;
  }

  .ldHomeFacts {
    grid-template-columns: 1fr;
    gap: 6px;
  }

  .ldHomeFacts span {
    padding: 7px 9px;
    font-size: 0.82rem;
  }

  .ldHomeLinks {
    margin-top: 10px;
  }

  .ldHomeStages {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 6px;
  }

  .ldHomeStages button {
    height: 34px;
    padding: 0 8px;
    overflow: hidden;
    font-size: 0.72rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}
`;
