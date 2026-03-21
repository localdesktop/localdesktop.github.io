import type { ReactNode } from "react";
import Heading from "@theme/Heading";

type FeatureItem = {
  title: string;
  icon: string;
  description: ReactNode;
};

const FeatureList: FeatureItem[] = [
  {
    title: "Rootless",
    icon: require("@site/static/img/feature-rootless.webp").default,
    description: (
      <>
        Local Desktop does <b>not</b> require root access to run.
      </>
    ),
  },
  {
    title: "Standalone",
    icon: require("@site/static/img/feature-standalone.webp").default,
    description: (
      <>
        Local Desktop allows you to start Linux on your Android device with just{" "}
        <b>one</b> tap, all in <b>one</b> app.
      </>
    ),
  },
  {
    title: "Efficient",
    icon: require("@site/static/img/feature-efficient.webp").default,
    description: (
      <>
        Local Desktop is built with <b>Rust</b> and runs entirely in native
        code. By using the <b>Wayland</b> protocol, it incurs less overhead
        compared to X or VNC alternatives.
      </>
    ),
  },
  {
    title: "FOSS",
    icon: require("@site/static/img/feature-foss.webp").default,
    description: (
      <>
        Local Desktop is <b>free and open-source</b>, and will always be.
      </>
    ),
  },
];

function Feature({ title, icon, description }: FeatureItem) {
  return (
    <div className="w-full md:w-1/4 px-4">
      <div className="text-center">
        <img className="h-20 w-20 mx-auto" role="img" src={icon} alt={title} />
      </div>
      <div className="text-center px-4">
        <Heading as="h3" className="text-xl font-bold mt-4 mb-2">
          {title}
        </Heading>
        <p className="opacity-75">{description}</p>
      </div>
    </div>
  );
}

export default function Features(): ReactNode {
  return (
    <section className="flex items-center justify-center py-8 w-full">
      <div className="container mx-auto px-4">
        <div className="flex flex-wrap -mx-4">
          {FeatureList.map((props, idx) => (
            <Feature key={idx} {...props} />
          ))}
        </div>
      </div>
    </section>
  );
}
