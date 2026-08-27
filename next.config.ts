import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,
  turbopack: {
    root: process.cwd(),
  },

  // `pg` requires `pg-cloudflare` at runtime on Workers: its `isCloudflareRuntime()`
  // check passes, so it takes the CloudflareSocket path rather than node:net.
  // File tracing resolves `pg-cloudflare` through its `default` export condition
  // and copies only `dist/empty.js`, while the Worker bundler resolves through
  // the `workerd` condition and wants `dist/index.js`. Forcing the whole package
  // into the trace makes both conditions resolvable.
  outputFileTracingIncludes: {
    "**": ["./node_modules/pg-cloudflare/**/*"],
  },
};

export default nextConfig;
