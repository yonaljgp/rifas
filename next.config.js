/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    optimizePackageImports: ["@mantine/core", "@mantine/hooks"],
    missingSuspenseWithCSRBailout: false,
  },
};

module.exports = nextConfig;
