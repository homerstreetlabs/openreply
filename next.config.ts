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

  // Next 16.4 traces every package.json dependency into any route that reaches
  // a wasm import, and the Prisma client is one
  // (https://github.com/vercel/next.js/issues/100314). OpenNext then attaches
  // every traced .wasm as a Worker module, which took the web Worker from
  // 3.4 MB to 19 MB gzipped against a 10 MB ceiling. No route loads wasm from
  // node_modules: the query compiler is emitted into .next/server chunks. The
  // og directory goes whole, because OpenNext bundles next/og's wasm whenever
  // that directory is traced at all, and nothing here renders images.
  // Drop this once that issue's fix ships in a 16.4.x release.
  outputFileTracingExcludes: {
    "**": ["./node_modules/**/*.wasm", "./node_modules/**/next/dist/compiled/@vercel/og/**"],
  },
};

export default nextConfig;
