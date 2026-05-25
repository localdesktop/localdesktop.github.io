import React, { type ReactNode } from "react";
import clsx from "clsx";
import useIsBrowser from "@docusaurus/useIsBrowser";
import IconChart from "@site/src/components/icon-chart";
import { toggleChartInteractive, useChartInteractive } from "@site/src/hooks/use-chart-interactive";

type Props = {
  className?: string;
  buttonClassName?: string;
};

export default function HomeChartToggle({ className, buttonClassName }: Props): ReactNode {
  const isBrowser = useIsBrowser();
  const interactive = useChartInteractive();
  const label = interactive ? "Close audience map" : "Open audience map";

  return (
    <div className={clsx("home-chart-toggle", className)}>
      <button
        className={clsx(
          "clean-btn",
          "home-chart-toggle__button",
          !isBrowser && "home-chart-toggle__button--disabled",
          interactive && "home-chart-toggle--active",
          buttonClassName,
        )}
        type="button"
        onClick={toggleChartInteractive}
        disabled={!isBrowser}
        title={label}
        aria-label={label}
        aria-pressed={interactive}
      >
        <IconChart className="home-chart-toggle__icon" />
      </button>
    </div>
  );
}
