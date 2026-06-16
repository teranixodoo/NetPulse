/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  generateBuildId: async () => {
    return `build-${Date.now()}`;
  },
  async rewrites() {
    // Backend URL pro server-side proxy
    // host.docker.internal → Docker host gateway (backend v host network)
    const backendUrl = process.env.API_URL ||
                       "http://host.docker.internal:8000";
    console.log(`[next.config] API proxy → ${backendUrl}`);
    return [
      {
        source: "/api/backend/:path*",
        destination: `${backendUrl}/:path*`,
      },
    ];
  },
};

module.exports = nextConfig;
