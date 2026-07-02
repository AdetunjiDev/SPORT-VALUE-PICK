/** Normalized item every adapter yields, before code extraction. */
export interface RawItem {
  title: string;
  content: string; // description / selftext / body
  url?: string;
  author?: string;
  publishedAt?: string; // ISO
  imageUrl?: string; // set for image messages; OCR'd into `content` by the crawler
}

export interface SourceLike {
  id: string;
  type: string;
  url: string;
  config: unknown;
}
