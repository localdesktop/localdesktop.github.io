import React, { type ReactNode } from "react";
import { useLocation } from "@docusaurus/router";
import OriginalNavbarColorModeToggle from "@theme-original/Navbar/ColorModeToggle";
import type { Props } from "@theme/Navbar/ColorModeToggle";
import HomeChartToggle from "@site/src/components/home-chart-toggle";

function isHomePath(pathname: string): boolean {
  const path = pathname.replace(/\/$/, "") || "/";
  return path === "/";
}

export default function NavbarColorModeToggle(props: Props): ReactNode {
  const location = useLocation();

  if (isHomePath(location.pathname)) {
    return <HomeChartToggle className={props.className} buttonClassName={props.buttonClassName} />;
  }

  return <OriginalNavbarColorModeToggle {...props} />;
}
