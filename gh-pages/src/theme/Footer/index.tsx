import React, { type ReactNode, useEffect, useState } from "react";
import Link from "@docusaurus/Link";
import { useThemeConfig } from "@docusaurus/theme-common";

const LINKS = [
  { to: "/about", label: "About" },
  { to: "/contact", label: "Contact" },
  { to: "/privacy", label: "Privacy" },
  { to: "/blog", label: "News" },
];

export default function Footer(): ReactNode {
  const { footer } = useThemeConfig();
  const [time, setTime] = useState("");

  useEffect(() => {
    const tick = () => setTime(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
    tick();
    const id = setInterval(tick, 10000);
    return () => clearInterval(id);
  }, []);

  return (
    <footer className="site-footer">
      <nav className="site-footer__links">
        {LINKS.map((l) => (
          <Link key={l.to} to={l.to}>
            {l.label}
          </Link>
        ))}
        <a href="/bear-war/">Bear War</a>
      </nav>
      <span>{footer?.copyright}</span>
      <b className="site-footer__clock">{time}</b>
    </footer>
  );
}
