import Link from "@docusaurus/Link";
import useDocusaurusContext from "@docusaurus/useDocusaurusContext";
import Heading from "@theme/Heading";
import config from "@site/docusaurus.config";
import GitHubButton from "react-github-btn";

export const COMPONENTS = [
  {
    name: "Rust",
    image: "https://avatars.githubusercontent.com/u/5430905?s=48&v=4",
    link: "https://github.com/rust-lang/rust",
  },
  {
    name: "Smithay",
    image: "https://avatars.githubusercontent.com/u/29117271?s=48&v=4",
    link: "https://github.com/Smithay/smithay",
  },
  {
    name: "winit",
    image: "https://avatars.githubusercontent.com/u/49372933?s=48&v=4",
    link: "https://github.com/rust-windowing/winit",
  },
  {
    name: "xbuild",
    image: "https://avatars.githubusercontent.com/u/118470275?s=200&v=4",
    link: "https://github.com/rust-mobile/xbuild",
  },
  {
    name: "Arch Linux",
    image: "https://avatars.githubusercontent.com/u/4673648?s=200&v=4",
    link: "https://github.com/archlinux",
  },
  {
    name: "XFCE",
    image: "https://avatars.githubusercontent.com/u/9962578?s=200&v=4",
    link: "https://github.com/xfce-mirror",
  },
  {
    name: "Wayland",
    image: "https://avatars.githubusercontent.com/u/16206747?s=200&v=4",
    link: "https://wayland.app/protocols/",
  },
];

export default function Hero() {
  const { siteConfig } = useDocusaurusContext();

  return (
    <header className="py-8 lg:py-16 text-center relative overflow-hidden">
      <div className="container">
        <Heading as="h1" className="hero__title">
          {siteConfig.title}
        </Heading>
        <p className="hero__subtitle">{siteConfig.tagline}</p>
        <p>
          <span>Built with love and </span>
          <span className="inline-flex">
            {COMPONENTS.map((component) => (
              <a
                key={component.name}
                title={component.name}
                href={component.link}
                target="_blank"
                rel="noopener noreferrer"
              >
                <img
                  key={component.name}
                  src={component.image}
                  alt={component.name}
                  style={{ verticalAlign: "middle" }}
                  className="h-6"
                />
              </a>
            ))}
          </span>
        </p>
        <div className="flex items-center justify-center gap-4 ">
          <Link
            className="button button--secondary !p-[5px_10px] !text-xs !rounded-[.25em]"
            to={config.customFields.downloadUrl as string}
          >
            Download APK
          </Link>
          <div className="flex justify-center items-center [&>span>span]:flex">
            <GitHubButton
              href={config.customFields.repositoryUrl as string}
              data-color-scheme="no-preference: light; light: light; dark: dark;"
              data-size="large"
              data-show-count="true"
              aria-label="Star us on GitHub"
            >
              Star
            </GitHubButton>
          </div>
        </div>
      </div>
    </header>
  );
}
