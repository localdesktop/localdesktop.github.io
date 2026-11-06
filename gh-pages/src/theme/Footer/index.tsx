import React, { type ReactNode, useEffect, useState } from "react";
import { useThemeConfig } from "@docusaurus/theme-common";

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
      <a className="button button--primary" href="/bear-war/" target="_blank">
        ▶ Play<span className="site-footer__long"> the game to support the developers</span>
      </a>
      <span>{footer?.copyright}</span>
      <b className="site-footer__clock">{time}</b>
    </footer>
  );
}
