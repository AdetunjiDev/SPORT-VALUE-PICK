/** Normalized item every adapter yields, before code extraction. */
export interface RawItem {
  title: string;
  content: string; // description / selftext / body
  url?: string;
  author?: string;
  publishedAt?: string; // ISO
}

export interface SourceLike {
  id: string;
  type: string;
  url: string;
  config: unknown;
}
