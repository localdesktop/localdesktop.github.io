import Layout from "@theme/Layout";
import Heading from "@theme/Heading";
import BuyMeACoffee from "../components/buy-me-a-coffee";
import Future from "../components/future";
import Link from "@docusaurus/Link";
import config from "@site/docusaurus.config";

function SupportUs() {
  return (
    <Layout title="Support us" description="">
      <main className="container">
        <section className="py-8 lg:py-16 text-center relative">
          <Heading as="h1" className="hero__title">
            We need your support!
          </Heading>
          <p className="hero__subtitle">
            Making Linux work on Android takes time, energy, and support. Your
            support helps us continue building and improving this open-source
            tool.
          </p>
          <div className="flex flex-col md:flex-row gap-4 items-center justify-center">
            <Link
              className="button button--primary button--lg"
              to={config.customFields.repositoryUrl as string}
            >
              ⭐️ Star us on GitHub
            </Link>
            <Link
              className="button button--secondary button--lg"
              to="/docs/developer/how-to-build"
            >
              Join us as a developer
            </Link>
          </div>
        </section>
        <div className="flex justify-center items-center">
          <BuyMeACoffee />
        </div>
      </main>
    </Layout>
  );
}

export default SupportUs;
