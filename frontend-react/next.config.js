/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  // Unikátní build ID zabrání Server Action cache konfliktům
  generateBuildId: async () => {
    return `build-${Date.now()}`;
  },
};

module.exports = nextConfig;
