import DashboardSkeleton from "@/components/dashboard-skeleton";

/**
 * The Suspense fallback for every route in the (dashboard) group.
 *
 * Its real job is prefetching, not the pixels. A dynamic route with no
 * `loading.tsx` is not prefetched at all, so a click sits on the old page with
 * no feedback until the server responds — the dead-click feel. With this file
 * the shared layout and this skeleton are fetched ahead of the click and the
 * transition starts immediately, per
 * node_modules/next/dist/docs/01-app/01-getting-started/04-linking-and-navigating.md
 * ("Dynamic Route: prefetching is skipped, or the route is partially prefetched
 * if `loading.tsx` is present").
 *
 * At group level this wraps the child pages only, not the sibling `layout.js`
 * (node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/loading.md,
 * "Behavior > Instant Loading States"). The layout still reads the session and
 * the workspace on a cold entry into the group and blocks until it resolves,
 * which is what the layout's own round trips are for; between dashboard routes
 * the layout is already mounted and the fallback shows at once.
 */
export default function Loading() {
  return <DashboardSkeleton />;
}
