/**
 * Dashboard Skeleton
 *
 * The placeholder a dashboard route shows before its data arrives. Shared by
 * `app/(dashboard)/loading.tsx` and the dashboard page's own client-side
 * loading state, so a navigation and the fetch that follows it hold the same
 * shape instead of swapping one placeholder for a different one.
 */

export default function DashboardSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3 sm:gap-4">
        {[...Array(6)].map((_, i) => (
          <div key={i} className="panel rounded p-5 h-32">
            <div className="w-10 h-10 rounded bg-surface-hover" />
            <div className="mt-4 h-6 w-16 bg-surface-hover rounded" />
            <div className="mt-2 h-4 w-24 bg-surface-hover/60 rounded" />
          </div>
        ))}
      </div>
    </div>
  );
}
