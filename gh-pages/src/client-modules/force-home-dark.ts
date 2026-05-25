function isHomePath(pathname: string): boolean {
  const path = pathname.replace(/\/$/, "") || "/";
  return path === "/";
}

if (typeof window !== "undefined" && isHomePath(window.location.pathname)) {
  document.documentElement.classList.add("home-force-dark");
}
