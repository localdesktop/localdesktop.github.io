import React, { type ReactNode } from "react";
import config from "@site/docusaurus.config";

/** Dark Looker report — landing page only; ignores site color mode. */
const EMBED_URL = config.customFields.audienceChartEmbedUrlDark as string;

export default function AudienceChart(): ReactNode {
  return (
    <iframe
      className="audience-chart__iframe"
      title="Active users by country"
      src={EMBED_URL}
      loading="lazy"
      scrolling="no"
      tabIndex={-1}
      referrerPolicy="no-referrer-when-downgrade"
    />
  );
}
