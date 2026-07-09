import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Prevent the App Router from automatically revalidating dynamic routes.
    // Dynamic routes (using cookies/headers) default to staleTime=0, which can
    // cause unexpected router refreshes in development.
    staleTimes: {
      dynamic: 30,
      static: 180,
    },
  },
};

export default nextConfig;
