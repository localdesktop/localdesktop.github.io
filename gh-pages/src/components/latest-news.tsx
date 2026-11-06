import React, { useEffect, useState } from "react";
import { Feed, Item } from "../types";

export default function LatestNews() {
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

  return (
    <details className="site-bar__news">
      <summary className="button button--secondary" title="Latest news">
        News ▾
      </summary>
      <ul>
        {posts.slice(0, 5).map((post) => (
          <li key={post.id}>
            <a href={post.url}>
              {post.title}
              <small>{new Date(post.date_modified).toLocaleDateString()}</small>
            </a>
          </li>
        ))}
        <li>
          <a href="/blog/">All news →</a>
        </li>
      </ul>
    </details>
  );
}
