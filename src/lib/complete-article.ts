import type { Post } from "@/data/posts";
import { articleBodies } from "@/data/articles";

export function completeArticle(post: Post): string {
  const body = articleBodies[post.slug];
  if (body) return body.trim();
  return [post.excerpt, post.content.trim()].filter(Boolean).join("\n\n");
}

export function estimateReadTime(markdown: string): string {
  const chars = markdown.replace(/[`#*\-\[\]()>]/g, "").length;
  const minutes = Math.max(8, Math.min(40, Math.round(chars / 380)));
  return `${minutes} min`;
}
