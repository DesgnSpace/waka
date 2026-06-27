import type { MetadataRoute } from "next";

const baseUrl = "https://www.waka.com";

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();

  return [
    {
      url: baseUrl,
      lastModified: now,
      changeFrequency: "weekly",
      priority: 1,
    },
    {
      url: `${baseUrl}/tools/email-dns-checker`,
      lastModified: now,
      changeFrequency: "monthly",
      priority: 0.75,
    },
    {
      url: `${baseUrl}/tools/ses-production-request-helper`,
      lastModified: now,
      changeFrequency: "monthly",
      priority: 0.74,
    },
    {
      url: `${baseUrl}/guides/ses-production-readiness`,
      lastModified: now,
      changeFrequency: "monthly",
      priority: 0.72,
    },
  ];
}
