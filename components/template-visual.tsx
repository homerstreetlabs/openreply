import type { CampaignTemplate } from "@/lib/templates/campaign-templates";

interface TemplateVisualProps {
  template: CampaignTemplate;
  compact?: boolean;
}

export default function TemplateVisual({
  template,
  compact = false,
}: TemplateVisualProps) {
  return (
    <div className="border border-border p-4">
      <div className="border border-border bg-surface p-4">
        <div className="flex items-center justify-between gap-3 border-b border-border pb-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">
              Comment trigger
            </p>
            <p className="mt-1 text-sm font-bold text-foreground">
              {template.triggerExample}
            </p>
          </div>
          <span className="border border-border bg-background px-3 py-1 text-xs font-semibold text-muted">
            {template.category}
          </span>
        </div>

        <div className={`grid gap-3 pt-4 ${compact ? "" : "sm:grid-cols-2"}`}>
          <div className="border border-border bg-surface p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">
              Keywords
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {template.keywords.map((keyword) => (
                <span
                  key={keyword}
                  className="border border-border bg-background px-2 py-1 text-xs font-bold text-foreground"
                >
                  {keyword}
                </span>
              ))}
            </div>
          </div>
          <div className="border border-border bg-surface p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">
              Private reply
            </p>
            <p className="mt-3 text-sm leading-6 text-muted">
              {template.privateReplyPreview}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
