import React, { useEffect, useState } from "react";
import { Feed, Item } from "../types";

const pastelColors = [
  "bg-red-50 dark:bg-zinc-950",
  "bg-yellow-50 dark:bg-zinc-950",
  "bg-green-50 dark:bg-zinc-950",
  "bg-blue-50 dark:bg-zinc-950",
  "bg-purple-50 dark:bg-zinc-950",
  "bg-pink-50 dark:bg-zinc-950",
  "bg-indigo-50 dark:bg-zinc-950",
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
      <div className="container mx-auto px-4">
        <h2 className="text-3xl font-bold mb-8 text-center">Latest News</h2>
        <div className="flex flex-wrap -mx-4">
          {posts.length > 0 && (
            <>
              {/* Left: Featured latest post */}
              <div className="w-full lg:w-2/3 px-4 mb-8 lg:mb-0">
                <article
                  className={`p-6 rounded-2xl h-full ${
                    pastelColors[0 % pastelColors.length]
                  }`}
                >
                  <h3 className="text-2xl font-semibold mb-2">
                    <a
                      href={posts[0].url}
                      className="hover:underline"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {posts[0].title}
                    </a>
                  </h3>
                  <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-4">
                    {new Date(posts[0].date_modified).toLocaleDateString()}{" "}
                    &middot; By{" "}
                    <a href={posts[0].author?.url} className="underline">
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
              <div className="w-full lg:w-1/3 px-4">
                <div className="space-y-6">
                  {posts.slice(1).map((post, i) => (
                    <article
                      key={post.id}
                      className={`p-4 rounded-2xl ${
                        pastelColors[(i + 1) % pastelColors.length]
                      }`}
                    >
                      <h4 className="text-lg font-semibold">
                        <a
                          href={post.url}
                          className="hover:underline"
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {post.title}
                        </a>
                      </h4>
                      <p className="text-sm text-zinc-600 dark:text-zinc-400">
                        {new Date(post.date_modified).toLocaleDateString()}{" "}
                        &middot;{" "}
                        <a href={post.author?.url} className="underline">
                          {post.author?.name}
                        </a>
                      </p>
                    </article>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
