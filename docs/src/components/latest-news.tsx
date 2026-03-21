import React, { useEffect, useState } from "react";
import { Feed, Item } from "../types";

const pastelColors = [
  "bg-red-50 dark:bg-red-950",
  "bg-yellow-50 dark:bg-yellow-950",
  "bg-green-50 dark:bg-green-950",
  "bg-blue-50 dark:bg-blue-950",
  "bg-purple-50 dark:bg-purple-950",
  "bg-pink-50 dark:bg-pink-950",
  "bg-indigo-50 dark:bg-indigo-950",
];

export default function BlogFeed() {
  const [posts, setPosts] = useState<Item[]>([]);

  useEffect(() => {
    fetch("/blog/feed.json")
      .then<Feed>((res) => res.json())
      .then((data) => {
        setPosts(data.items || []);
      })
      .catch((err) => {
        console.error("Failed to load blog feed:", err);
      });
  }, []);

  if (!posts.length) {
    return <></>;
  }

  return (
    <section className="flex items-center justify-center py-8 w-full">
      <div className="container mx-auto !space-y-8">
        <h2 className="text-3xl font-bold text-center">
          <a href="/blog">Latest News</a>
        </h2>
        <div className="flex flex-wrap gap-6">
          {posts.length > 0 && (
            <>
              {/* Left: Featured latest post */}
              <div className="flex-grow lg:flex-shrink-0 lg:basis-[640px] overflow-hidden">
                <article
                  className={`p-6 rounded-2xl h-full space-y-2 ${
                    pastelColors[0 % pastelColors.length]
                  }`}
                >
                  <h3 className="text-2xl font-semibold">
                    <a href={posts[0].url}>{posts[0].title}</a>
                  </h3>
                  <p className="text-sm opacity-50">
                    {new Date(posts[0].date_modified).toLocaleDateString()}{" "}
                    &middot; By{" "}
                    <a
                      href={posts[0].author?.url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {posts[0].author?.name}
                    </a>
                  </p>
                  <div
                    className="prose prose-zinc max-w-none dark:prose-invert"
                    dangerouslySetInnerHTML={{ __html: posts[0].content_html }}
                  />
                </article>
              </div>

              {/* Right: List of other posts */}
              <div className="lg:flex-none lg:basis-96 space-y-6">
                {posts.slice(1).map((post, i) => (
                  <a
                    href={post.url}
                    className="block hover:no-underline hover:[&_h4]:underline"
                  >
                    <article
                      key={post.id}
                      className={`p-4 rounded-2xl ${
                        pastelColors[(i + 1) % pastelColors.length]
                      }`}
                    >
                      <h4 className="text-lg font-semibold">{post.title}</h4>
                      <p className="text-sm opacity-50 !mb-0">
                        {new Date(post.date_modified).toLocaleDateString()}{" "}
                        &middot; {post.author?.name}
                      </p>
                    </article>
                  </a>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
