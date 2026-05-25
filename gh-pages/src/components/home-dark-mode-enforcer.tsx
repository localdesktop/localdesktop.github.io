import { useHomeDarkMode } from "../hooks/use-home-dark-mode";

/** Applies landing-page-only dark mode. Must render inside `@theme/Layout`. */
export default function HomeDarkModeEnforcer(): null {
  useHomeDarkMode();
  return null;
}
