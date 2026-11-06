import React, { type ReactNode } from "react";
import clsx from "clsx";
import Link from "@docusaurus/Link";
import { useLocation } from "@docusaurus/router";
import NavbarMobileSidebarToggle from "@theme/Navbar/MobileSidebar/Toggle";
import config from "@site/docusaurus.config";
import LatestNews from "@site/src/components/latest-news";

const TABS = [
  { label: "User Manual", to: "/docs/user/getting-started", base: "/docs/user" },
  { label: "Developer Manual", to: "/docs/developer/how-to-build", base: "/docs/developer" },
];

export default function NavbarContent(): ReactNode {
  const { pathname } = useLocation();

  return (
    <div className="site-bar">
      <div className="site-bar__left">
        <NavbarMobileSidebarToggle />
        <nav className="site-bar__panel site-bar__nav">
          <div className="site-bar__row">
            {TABS.map((tab) => (
              <Link
                key={tab.to}
                className={clsx("button button--secondary site-bar__tab", pathname.startsWith(tab.base) && "is-active")}
                to={tab.to}
              >
                {tab.label}
              </Link>
            ))}
          </div>
          <div className="site-bar__row">
            <LatestNews />
            <Link className="button button--secondary" to={config.customFields.repositoryUrl as string} title="Star us on GitHub">
              ★ Star
            </Link>
            <Link className="button button--secondary" to="/support-us" title="Support us">
              ♥ Support
            </Link>
          </div>
        </nav>
      </div>

      <Link className="site-bar__emblem" to="/" title="Local Desktop">
        <img src="/img/logo.png" alt="Local Desktop" />
      </Link>

      <div className="site-bar__panel site-bar__card">
        <div className="site-bar__title">
          <b>Local Desktop</b>
          <span>Linux on Android</span>
        </div>
        <div className="site-bar__actions">
          <Link className="button button--primary" to={config.customFields.downloadUrl as string}>
            Download APK
          </Link>
          <Link className="button button--secondary" to={config.customFields.repositoryUrl as string}>
            Source Code
          </Link>
        </div>
      </div>
    </div>
  );
}
