import React, { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import Link from "@docusaurus/Link";
import Head from "@docusaurus/Head";
import useDocusaurusContext from "@docusaurus/useDocusaurusContext";
import Layout from "@theme/Layout";
import config from "@site/docusaurus.config";
import type { Feed, Item } from "../types";

type Stage = {
  label: string;
  mission: string;
  title: string;
  body: string;
  facts: string[];
  action: {
    label: string;
    to: string;
  };
};

const stages: Stage[] = [
  {
    label: "Base Camp",
    mission: "Wake the workstation",
    title: "Linux desktop power, launched from Android.",
    body: "Guide the polar bear through a tiny arctic command center and discover how Local Desktop turns phones and tablets into practical Linux work machines.",
    facts: ["Rootless Android app", "Desktop Linux environment", "Made for touch, keyboard, and larger screens"],
    action: {
      label: "Download APK",
      to: config.customFields.downloadUrl as string,
    },
  },
  {
    label: "No Root Ice",
    mission: "Cross without root",
    title: "No root access. No separate companion machine.",
    body: "Local Desktop keeps setup approachable: one app starts the environment and brings the desktop session to your Android device.",
    facts: ["Standalone launcher", "One-tap start path", "Works with everyday Android devices"],
    action: {
      label: "Getting Started",
      to: "/docs/user/getting-started",
    },
  },
  {
    label: "Wayland Cave",
    mission: "Light the display",
    title: "Native Rust and Wayland pieces keep the path lean.",
    body: "The project avoids a typical VNC-first feel by leaning on native code and Wayland, reducing avoidable display overhead.",
    facts: ["Rust core", "Wayland protocol", "Built for lower overhead than remote-desktop style paths"],
    action: {
      label: "How It Works",
      to: "/docs/developer/how-it-works",
    },
  },
  {
    label: "Open Floe",
    mission: "Share the map",
    title: "Free and open-source, with developer docs included.",
    body: "Read the code, build it locally, inspect the Android and Linux integration, and help shape the next version of mobile desktop computing.",
    facts: ["FOSS project", "Public source code", "Build and developer manuals"],
    action: {
      label: "Star on GitHub",
      to: `${config.customFields.repositoryUrl}/stargazers`,
    },
  },
  {
    label: "Tablet Ridge",
    mission: "Dock the screen",
    title: "Android hardware is ready for more desktop-grade work.",
    body: "Large tablets, keyboard cases, external displays, and Android desktop mode point toward a future where local Linux workflows fit in your bag.",
    facts: ["Coding on Android", "Image editing and debugging", "Local web servers and desktop apps"],
    action: {
      label: "Compatibility",
      to: "/docs/user/app-compatibility/gimp",
    },
  },
  {
    label: "Signal Tower",
    mission: "Catch the news",
    title: "Follow releases, compatibility work, and project notes.",
    body: "The project news feed covers release notes, contributor updates, technical decisions, and the broader roadmap for Linux desktop support on Android.",
    facts: ["Release notes", "Contributor updates", "Technical posts"],
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

function PolarBearGame({ activeStage }: { activeStage: number }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const activeRef = useRef(activeStage);
  const pointerRef = useRef({ x: 0, y: 0 });
  const hopRef = useRef(0);

  useEffect(() => {
    activeRef.current = activeStage;
    hopRef.current = 1;
  }, [activeStage]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    let disposed = false;
    let frame = 0;
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
      renderer.shadowMap.enabled = true;

      const scene = new THREE.Scene();
      scene.fog = new THREE.Fog(0xdbeafe, 8, 22);

      const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 100);
      camera.position.set(0, 4.6, 10.8);
      camera.lookAt(0, 0.8, 0);

      const world = new THREE.Group();
      scene.add(world);

      const materials = {
        snow: new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.76 }),
        ice: new THREE.MeshStandardMaterial({
          color: 0xbde9ff,
          emissive: 0x5cc8ff,
          emissiveIntensity: 0.08,
          roughness: 0.42,
          metalness: 0.08,
        }),
        bear: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.68 }),
        bearShade: new THREE.MeshStandardMaterial({ color: 0xd8e7ef, roughness: 0.78 }),
        nose: new THREE.MeshStandardMaterial({ color: 0x111827, roughness: 0.48 }),
        red: new THREE.MeshStandardMaterial({
          color: 0xff0000,
          emissive: 0x9f0000,
          emissiveIntensity: 0.1,
          roughness: 0.44,
        }),
        teal: new THREE.MeshStandardMaterial({
          color: 0x14b8a6,
          emissive: 0x0f766e,
          emissiveIntensity: 0.1,
          roughness: 0.5,
        }),
        dark: new THREE.MeshStandardMaterial({ color: 0x111827, roughness: 0.55 }),
        screen: new THREE.MeshStandardMaterial({
          color: 0x0f172a,
          emissive: 0x1d4ed8,
          emissiveIntensity: 0.38,
          roughness: 0.22,
        }),
      };

      const ground = new THREE.Mesh(new THREE.CylinderGeometry(6.7, 7.6, 0.5, 10), materials.snow);
      ground.position.y = -0.35;
      ground.receiveShadow = true;
      world.add(ground);

      const stageNodes: import("three").Mesh[] = [];
      for (let i = 0; i < stages.length; i += 1) {
        const angle = (i / stages.length) * Math.PI * 2 - Math.PI / 2;
        const floe = new THREE.Mesh(
          new THREE.CylinderGeometry(0.82, 0.98, 0.18, 7),
          i % 2 ? materials.ice : materials.snow,
        );
        floe.position.set(Math.cos(angle) * 4.35, -0.03, Math.sin(angle) * 3.4);
        floe.rotation.y = angle * 0.7;
        floe.castShadow = true;
        floe.receiveShadow = true;
        world.add(floe);
        stageNodes.push(floe);

        const marker = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.72, 8), materials.dark);
        marker.position.set(floe.position.x, 0.48, floe.position.z);
        marker.castShadow = true;
        world.add(marker);

        const flag = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.3, 0.04), materials.red);
        flag.position.set(floe.position.x + 0.2, 0.72, floe.position.z);
        flag.castShadow = true;
        world.add(flag);
      }

      const bear = new THREE.Group();
      bear.position.set(0, 0.18, 0.25);
      world.add(bear);

      const addPart = (
        geometry: import("three").BufferGeometry,
        material: import("three").Material,
        position: [number, number, number],
        scale: [number, number, number],
      ) => {
        const mesh = new THREE.Mesh(geometry, material);
        mesh.position.set(...position);
        mesh.scale.set(...scale);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        bear.add(mesh);
        return mesh;
      };

      const bodyGeometry = new THREE.SphereGeometry(1, 12, 10);
      addPart(bodyGeometry, materials.bear, [0, 0.68, 0], [1.38, 0.8, 0.78]);
      addPart(bodyGeometry, materials.bearShade, [-0.18, 0.44, 0.15], [0.86, 0.46, 0.48]);
      addPart(new THREE.SphereGeometry(0.68, 12, 10), materials.bear, [0.86, 1.28, 0.02], [0.92, 0.82, 0.78]);
      addPart(new THREE.SphereGeometry(0.18, 10, 8), materials.bear, [1.08, 1.86, 0.44], [1, 1, 1]);
      addPart(new THREE.SphereGeometry(0.18, 10, 8), materials.bear, [1.08, 1.86, -0.44], [1, 1, 1]);
      addPart(new THREE.SphereGeometry(0.3, 10, 8), materials.bearShade, [1.5, 1.2, 0.02], [1.1, 0.7, 0.68]);
      addPart(new THREE.SphereGeometry(0.1, 8, 6), materials.nose, [1.78, 1.22, 0.02], [1, 0.72, 0.8]);
      addPart(new THREE.SphereGeometry(0.045, 8, 6), materials.nose, [1.42, 1.42, 0.28], [1, 1, 1]);
      addPart(new THREE.SphereGeometry(0.045, 8, 6), materials.nose, [1.42, 1.42, -0.28], [1, 1, 1]);

      for (const z of [-0.46, 0.46]) {
        addPart(new THREE.SphereGeometry(0.32, 10, 8), materials.bear, [-0.76, 0.12, z], [1.25, 0.45, 0.72]);
        addPart(new THREE.SphereGeometry(0.3, 10, 8), materials.bear, [0.62, 0.1, z], [1.18, 0.42, 0.7]);
      }

      const scarf = new THREE.Mesh(new THREE.TorusGeometry(0.44, 0.055, 8, 20), materials.red);
      scarf.position.set(0.76, 1.17, 0.02);
      scarf.rotation.set(Math.PI / 2, 0.18, 0);
      scarf.scale.set(1.16, 0.82, 1);
      scarf.castShadow = true;
      bear.add(scarf);

      const laptop = new THREE.Group();
      laptop.position.set(-1.4, 0.5, -1.15);
      laptop.rotation.set(-0.2, 0.75, 0);
      world.add(laptop);
      const base = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.08, 0.78), materials.dark);
      const screen = new THREE.Mesh(new THREE.BoxGeometry(1.16, 0.78, 0.08), materials.screen);
      screen.position.set(0, 0.43, -0.35);
      screen.rotation.x = -0.25;
      laptop.add(base, screen);

      const terminalLines: import("three").Mesh[] = [];
      for (let i = 0; i < 4; i += 1) {
        const line = new THREE.Mesh(
          new THREE.BoxGeometry(0.62 - i * 0.08, 0.035, 0.02),
          i % 2 ? materials.ice : materials.teal,
        );
        line.position.set(-0.12, 0.52 - i * 0.13, -0.41);
        laptop.add(line);
        terminalLines.push(line);
      }

      const aurora = new THREE.Group();
      aurora.position.set(0, 3.2, -5.6);
      scene.add(aurora);
      for (let i = 0; i < 5; i += 1) {
        const ribbon = new THREE.Mesh(
          new THREE.BoxGeometry(1.2, 0.08, 0.04),
          i % 2 ? materials.teal : materials.ice,
        );
        ribbon.position.set(-2.4 + i * 1.2, Math.sin(i) * 0.22, 0);
        ribbon.rotation.z = Math.sin(i * 1.3) * 0.38;
        aurora.add(ribbon);
      }

      const ambient = new THREE.HemisphereLight(0xffffff, 0x8fb3c8, 2.4);
      const key = new THREE.DirectionalLight(0xffffff, 2.8);
      key.position.set(4, 7, 5);
      key.castShadow = true;
      key.shadow.mapSize.set(1024, 1024);
      const redBeacon = new THREE.PointLight(0xff0000, 2.5, 8);
      redBeacon.position.set(-2.7, 2.1, 2.4);
      scene.add(ambient, key, redBeacon);

      const resize = () => {
        const rect = canvas.getBoundingClientRect();
        const width = Math.max(1, rect.width);
        const height = Math.max(1, rect.height);
        renderer.setSize(width, height, false);
        camera.aspect = width / height;
        camera.position.set(width < 720 ? 0 : 0.25, width < 720 ? 5.2 : 4.6, width < 720 ? 12.4 : 10.8);
        camera.lookAt(0, 0.76, 0);
        world.scale.setScalar(width < 520 ? 0.82 : 1);
        camera.updateProjectionMatrix();
      };

      const observer = new ResizeObserver(resize);
      observer.observe(canvas);
      resize();

      const animate = () => {
        const time = performance.now() * 0.001;
        const stageAngle = (activeRef.current / stages.length) * Math.PI * 2;
        const targetRotation = -stageAngle + Math.PI / 2 + pointerRef.current.x * 0.16;

        world.rotation.y += (targetRotation - world.rotation.y) * 0.045;
        aurora.rotation.z = Math.sin(time * 0.8) * 0.06;
        redBeacon.intensity = 2 + Math.sin(time * 3) * 0.6;

        hopRef.current *= 0.9;
        bear.position.y = 0.18 + Math.abs(Math.sin(time * 2.6)) * 0.08 + hopRef.current * 0.45;
        bear.rotation.y = Math.sin(time * 1.2) * 0.08 + pointerRef.current.x * 0.14;
        bear.rotation.z = Math.sin(time * 2.1) * 0.025;

        stageNodes.forEach((node, index) => {
          const selected = index === activeRef.current;
          const pulse = selected ? 1.08 + Math.sin(time * 4) * 0.05 : 1;
          node.scale.set(pulse, selected ? 1.18 : 1, pulse);
          node.position.y = (selected ? 0.04 : -0.03) + Math.sin(time * 1.5 + index) * 0.025;
        });

        terminalLines.forEach((line, index) => {
          line.scale.x = 0.65 + Math.sin(time * 3 + index + activeRef.current) * 0.18;
        });

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

  return <canvas ref={canvasRef} className="ldGameScene" aria-label="A playful 3D polar bear exploring Local Desktop features" />;
}

export default function Home(): ReactNode {
  const { siteConfig } = useDocusaurusContext();
  const [activeStage, setActiveStage] = useState(0);
  const posts = useLatestPosts();
  const stage = stages[activeStage];

  useEffect(() => {
    document.body.classList.add("ldGameBodyLock");

    return () => {
      document.body.classList.remove("ldGameBodyLock");
    };
  }, []);

  const facts = useMemo(() => {
    if (activeStage !== stages.length - 1 || !posts.length) {
      return stage.facts;
    }

    return posts.map((post) => post.title);
  }, [activeStage, posts, stage.facts]);

  const moveStage = (offset: number) => {
    setActiveStage((current) => (current + offset + stages.length) % stages.length);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (["ArrowRight", "ArrowDown", "d", "D", "s", "S"].includes(event.key)) {
      event.preventDefault();
      moveStage(1);
    }

    if (["ArrowLeft", "ArrowUp", "a", "A", "w", "W"].includes(event.key)) {
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
          content="Play through Local Desktop, a rootless Linux desktop environment for Android phones and tablets."
        />
        <meta property="og:title" content="Local Desktop | Linux on Android" />
        <meta
          property="og:description"
          content="A playful polar-bear tour of Local Desktop, the rootless Linux desktop environment for Android."
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
      <main
        className="ldGame"
        tabIndex={0}
        onKeyDown={handleKeyDown}
        aria-label="Playable Local Desktop homepage. Use arrow keys or WASD to change missions."
      >
        <PolarBearGame activeStage={activeStage} />
        <div className="ldGameVignette" />

        <section className="ldGameHero" aria-live="polite">
          <p className="ldGameKicker">app.polarbear</p>
          <h1>Local Desktop</h1>
          <p>{siteConfig.tagline}</p>
          <div className="ldGameActions">
            <Link className="button button--primary" to={stage.action.to}>
              {stage.action.label}
            </Link>
            <Link className="button button--secondary" to="/docs/user/getting-started">
              User Manual
            </Link>
          </div>
        </section>

        <aside className="ldGameCard">
          <div className="ldGameCardTop">
            <span>Mission {activeStage + 1}</span>
            <strong>{stage.label}</strong>
          </div>
          <h2>{stage.mission}</h2>
          <p>{stage.title}</p>
          <p>{stage.body}</p>
          <div className="ldGameBadges">
            {facts.map((fact) => (
              <span key={fact}>{fact}</span>
            ))}
          </div>
        </aside>

        <nav className="ldGameControls" aria-label="Polar bear mission controls">
          <button
            type="button"
            className="ldGameArrow"
            onClick={() => moveStage(-1)}
            aria-label="Previous mission"
          >
            <span aria-hidden="true">‹</span>
          </button>
          {stages.map((item, index) => (
            <button
              key={item.label}
              type="button"
              className={index === activeStage ? "isActive" : ""}
              onClick={() => setActiveStage(index)}
              aria-pressed={index === activeStage}
            >
              <span>{index + 1}</span>
              {item.label}
            </button>
          ))}
          <button
            type="button"
            className="ldGameArrow"
            onClick={() => moveStage(1)}
            aria-label="Next mission"
          >
            <span aria-hidden="true">›</span>
          </button>
        </nav>

        <section className="ldGameSeo" aria-label="Local Desktop overview">
          <h2>Local Desktop for Android</h2>
          <p>{siteConfig.tagline}</p>
          {stages.map((item) => (
            <article key={item.label}>
              <h3>{item.title}</h3>
              <p>{item.body}</p>
              <ul>
                {item.facts.map((fact) => (
                  <li key={fact}>{fact}</li>
                ))}
              </ul>
              <Link to={item.action.to}>{item.action.label}</Link>
            </article>
          ))}
        </section>
      </main>
    </Layout>
  );
}

const homeStyles = `
body.ldGameBodyLock {
  overflow: hidden;
}

body:has(.ldGame) {
  overflow: hidden;
}

body.ldGameBodyLock .footer {
  display: none;
}

body:has(.ldGame) .footer {
  display: none;
}

.ldGame {
  position: relative;
  height: calc(100dvh - var(--ifm-navbar-height));
  min-height: 560px;
  overflow: hidden;
  background:
    radial-gradient(circle at 16% 20%, rgba(255, 0, 0, 0.16), transparent 28%),
    radial-gradient(circle at 82% 68%, rgba(20, 184, 166, 0.24), transparent 28%),
    linear-gradient(135deg, #f8fafc 0%, #dbeafe 48%, #f4f7f8 100%);
  color: #111827;
  isolation: isolate;
}

html[data-theme="dark"] .ldGame {
  background:
    radial-gradient(circle at 16% 20%, rgba(255, 0, 0, 0.18), transparent 30%),
    radial-gradient(circle at 80% 72%, rgba(20, 184, 166, 0.18), transparent 28%),
    linear-gradient(135deg, #020617 0%, #0f172a 54%, #111827 100%);
  color: #f8fafc;
}

.ldGame:focus {
  outline: none;
}

.ldGameScene {
  position: absolute;
  inset: 0;
  z-index: 0;
  width: 100%;
  height: 100%;
  touch-action: none;
}

.ldGameVignette {
  position: absolute;
  inset: 0;
  z-index: 1;
  background:
    linear-gradient(90deg, rgba(248, 250, 252, 0.96) 0%, rgba(248, 250, 252, 0.55) 36%, rgba(248, 250, 252, 0.04) 70%),
    linear-gradient(0deg, rgba(248, 250, 252, 0.92) 0%, rgba(248, 250, 252, 0) 30%);
  pointer-events: none;
}

html[data-theme="dark"] .ldGameVignette {
  background:
    linear-gradient(90deg, rgba(2, 6, 23, 0.94) 0%, rgba(2, 6, 23, 0.62) 34%, rgba(2, 6, 23, 0.06) 70%),
    linear-gradient(0deg, rgba(2, 6, 23, 0.94) 0%, rgba(2, 6, 23, 0) 32%);
}

.ldGameHero {
  position: relative;
  z-index: 2;
  display: flex;
  flex-direction: column;
  justify-content: center;
  width: min(590px, calc(100% - 48px));
  height: calc(100% - 122px);
  margin-left: clamp(22px, 7vw, 104px);
  padding-bottom: 28px;
}

.ldGameKicker {
  margin: 0 0 12px;
  color: #ff0000;
  font-size: 0.82rem;
  font-weight: 900;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.ldGameHero h1 {
  max-width: 9ch;
  margin: 0;
  color: inherit;
  font-size: clamp(3.3rem, 9vw, 7.4rem);
  line-height: 0.86;
  letter-spacing: 0;
}

.ldGameHero p:not(.ldGameKicker) {
  max-width: 540px;
  margin: 20px 0 0;
  color: rgba(17, 24, 39, 0.74);
  font-size: clamp(1rem, 2vw, 1.2rem);
  line-height: 1.5;
}

html[data-theme="dark"] .ldGameHero p:not(.ldGameKicker) {
  color: rgba(248, 250, 252, 0.76);
}

.ldGameActions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 24px;
}

.ldGame .button {
  border-radius: 8px;
  font-weight: 850;
}

.ldGame .button--primary,
.ldGame .button--primary:hover,
.ldGame .button--primary:focus {
  border-color: #ff0000;
  background: #ff0000;
  color: #ffffff;
}

.ldGame .button--secondary {
  border-color: rgba(17, 24, 39, 0.14);
  background: rgba(255, 255, 255, 0.72);
  color: #111827;
}

html[data-theme="dark"] .ldGame .button--secondary {
  border-color: rgba(255, 255, 255, 0.16);
  background: rgba(15, 23, 42, 0.66);
  color: #f8fafc;
}

.ldGameCard {
  position: absolute;
  right: clamp(18px, 5vw, 76px);
  bottom: 104px;
  z-index: 3;
  width: min(420px, 37vw);
  padding: 18px;
  border: 1px solid rgba(17, 24, 39, 0.13);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.74);
  box-shadow: 0 24px 70px rgba(15, 23, 42, 0.16);
  backdrop-filter: blur(18px);
}

html[data-theme="dark"] .ldGameCard {
  border-color: rgba(255, 255, 255, 0.14);
  background: rgba(15, 23, 42, 0.62);
  box-shadow: 0 24px 70px rgba(0, 0, 0, 0.38);
}

.ldGameCardTop {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  color: #ff0000;
  font-size: 0.84rem;
  font-weight: 900;
  text-transform: uppercase;
}

.ldGameCard h2 {
  margin: 10px 0 8px;
  color: inherit;
  font-size: clamp(1.28rem, 2.2vw, 1.75rem);
  line-height: 1.06;
}

.ldGameCard p {
  margin: 8px 0 0;
  color: rgba(17, 24, 39, 0.74);
  font-size: 0.96rem;
  line-height: 1.42;
}

html[data-theme="dark"] .ldGameCard p {
  color: rgba(248, 250, 252, 0.76);
}

.ldGameBadges {
  display: grid;
  gap: 8px;
  margin-top: 14px;
}

.ldGameBadges span {
  display: block;
  padding: 8px 10px;
  border: 1px solid rgba(17, 24, 39, 0.12);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.58);
  color: rgba(17, 24, 39, 0.82);
  font-size: 0.88rem;
  line-height: 1.25;
}

html[data-theme="dark"] .ldGameBadges span {
  border-color: rgba(255, 255, 255, 0.13);
  background: rgba(255, 255, 255, 0.06);
  color: rgba(248, 250, 252, 0.82);
}

.ldGameControls {
  position: absolute;
  right: clamp(12px, 5vw, 76px);
  bottom: 18px;
  left: clamp(12px, 7vw, 104px);
  z-index: 4;
  display: grid;
  grid-template-columns: 0.48fr repeat(6, minmax(0, 1fr)) 0.48fr;
  gap: 8px;
}

.ldGameControls button {
  min-width: 0;
  height: 44px;
  padding: 0 10px;
  border: 1px solid rgba(17, 24, 39, 0.16);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.68);
  color: rgba(17, 24, 39, 0.76);
  cursor: pointer;
  font: inherit;
  font-size: 0.76rem;
  font-weight: 900;
  text-align: left;
  backdrop-filter: blur(14px);
  transition: transform 160ms ease, background 160ms ease, color 160ms ease;
}

.ldGameControls button:hover,
.ldGameControls button:focus-visible,
.ldGameControls button.isActive {
  border-color: #ff0000;
  background: #ff0000;
  color: white;
  transform: translateY(-2px);
}

.ldGameControls button span {
  margin-right: 7px;
  opacity: 0.72;
}

.ldGameControls .ldGameArrow {
  text-align: center;
}

.ldGameControls .ldGameArrow span {
  margin-right: 0;
  font-size: 1.65rem;
  line-height: 1;
  opacity: 1;
}

html[data-theme="dark"] .ldGameControls button {
  border-color: rgba(255, 255, 255, 0.15);
  background: rgba(15, 23, 42, 0.66);
  color: rgba(248, 250, 252, 0.78);
}

.ldGameSeo {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: normal;
}

@media (max-width: 1020px) {
  .ldGame {
    min-height: 640px;
  }

  .ldGameVignette {
    background:
      linear-gradient(180deg, rgba(248, 250, 252, 0.94) 0%, rgba(248, 250, 252, 0.42) 48%, rgba(248, 250, 252, 0.94) 100%);
  }

  html[data-theme="dark"] .ldGameVignette {
    background:
      linear-gradient(180deg, rgba(2, 6, 23, 0.92) 0%, rgba(2, 6, 23, 0.46) 48%, rgba(2, 6, 23, 0.92) 100%);
  }

  .ldGameHero {
    justify-content: flex-start;
    width: calc(100% - 36px);
    height: auto;
    margin-left: 18px;
    padding-top: clamp(18px, 4dvh, 44px);
  }

  .ldGameHero h1 {
    font-size: clamp(2.9rem, 12vw, 5.2rem);
  }

  .ldGameCard {
    right: 18px;
    bottom: 110px;
    left: 18px;
    width: auto;
    padding: 14px;
  }

  .ldGameBadges {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .ldGameControls {
    right: 12px;
    left: 12px;
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
}

@media (max-width: 560px) {
  .ldGame {
    min-height: 0;
  }

  .ldGameHero {
    padding-top: 16px;
  }

  .ldGameKicker {
    margin-bottom: 8px;
    font-size: 0.72rem;
  }

  .ldGameHero h1 {
    font-size: clamp(2.65rem, 15vw, 4.05rem);
  }

  .ldGameHero p:not(.ldGameKicker) {
    display: -webkit-box;
    margin-top: 10px;
    overflow: hidden;
    font-size: 0.94rem;
    line-height: 1.38;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
  }

  .ldGameActions {
    gap: 8px;
    margin-top: 12px;
  }

  .ldGameActions .button {
    padding: 0.48rem 0.64rem;
    font-size: 0.84rem;
  }

  .ldGameCard {
    bottom: 100px;
  }

  .ldGameCardTop {
    font-size: 0.72rem;
  }

  .ldGameCard h2 {
    margin-top: 7px;
    font-size: 1.08rem;
  }

  .ldGameCard p {
    display: -webkit-box;
    overflow: hidden;
    font-size: 0.82rem;
    line-height: 1.32;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
  }

  .ldGameBadges {
    grid-template-columns: 1fr;
    gap: 6px;
    margin-top: 9px;
  }

  .ldGameBadges span {
    padding: 7px 8px;
    font-size: 0.78rem;
  }

  .ldGameControls {
    bottom: 14px;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 6px;
  }

  .ldGameControls button {
    height: 34px;
    padding: 0 8px;
    overflow: hidden;
    font-size: 0.7rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}
`;
