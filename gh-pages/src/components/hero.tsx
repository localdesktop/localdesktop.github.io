import Link from "@docusaurus/Link";
import useDocusaurusContext from "@docusaurus/useDocusaurusContext";
import Heading from "@theme/Heading";
import config from "@site/docusaurus.config";

export default function Hero() {
  const { siteConfig } = useDocusaurusContext();

  return (
    <header className="py-8 lg:py-16 text-center relative overflow-hidden">
      <div className="container">
        <Heading as="h1" className="hero__title">
          {siteConfig.title}
        </Heading>
        <p className="hero__subtitle">{siteConfig.tagline}</p>
        <div className="flex flex-wrap items-center justify-center gap-4">
          <Link
            className="button button--primary button--lg"
            to={config.customFields.downloadUrl as string}
          >
            Download APK
          </Link>
          <Link
            className="button button--secondary button--lg"
            to={`${config.customFields.repositoryUrl}//stargazers`}
          >
            ⭐️ Star us on GitHub
          </Link>
        </div>
      </div>
    </header>
  );
}
