import config from "@site/docusaurus.config";
import GitHubButton from "react-github-btn";

export default function () {
  return (
    <GitHubButton
      href={config.customFields.repositoryUrl as string}
      data-color-scheme="no-preference: light; light: light; dark: dark;"
      data-size="large"
      data-show-count="true"
      aria-label="Star us on GitHub"
    >
      Star
    </GitHubButton>
  );
}
