import Link from "next/link";
import PublicSiteHeader from "@/components/public-site-header";

export interface SeoPageSection {
  title: string;
  body: string;
}

export interface SeoPageConfig {
  eyebrow: string;
  title: string;
  description: string;
  primaryCta: string;
  secondaryCta?: string;
  bullets: string[];
  sections: SeoPageSection[];
  comparisonTitle: string;
  comparisons: Array<{
    label: string;
    ours: string;
    other: string;
  }>;
  templateLinks: Array<{
    label: string;
    href: string;
  }>;
  faqs: SeoPageSection[];
}

export default function SeoPageShell({ config }: { config: SeoPageConfig }) {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <PublicSiteHeader />

      <section className="border-b border-border bg-surface">
        <div className="mx-auto grid w-full max-w-7xl gap-10 px-5 py-20 sm:px-6 lg:grid-cols-[1.05fr_0.95fr] lg:px-8">
          <div>
            <p className="text-sm font-bold uppercase text-muted">
              {config.eyebrow}
            </p>
            <h1 className="mt-4 text-5xl font-black leading-tight text-foreground sm:text-6xl">
              {config.title}
            </h1>
            <p className="mt-6 max-w-2xl text-lg leading-8 text-muted">
              {config.description}
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Link
                href="/login"
                className="inline-flex items-center justify-center bg-accent px-6 py-3 text-sm font-bold text-white transition hover:bg-accent-hover"
              >
                {config.primaryCta}
              </Link>
              <Link
                href="/templates"
                className="inline-flex items-center justify-center border border-border bg-background px-6 py-3 text-sm font-bold text-foreground transition hover:border-border-hover hover:bg-surface-hover"
              >
                {config.secondaryCta ?? "Browse templates"}
              </Link>
            </div>
          </div>

          <div className="border border-border bg-surface p-6">
            <p className="text-xs font-bold uppercase tracking-wide text-muted">
              Campaign OS checklist
            </p>
            <ul className="mt-5 space-y-4">
              {config.bullets.map((bullet) => (
                <li key={bullet} className="flex gap-3 text-sm leading-6 text-muted">
                  {bullet}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <section className="mx-auto w-full max-w-7xl px-5 py-16 sm:px-6 lg:px-8">
        <div className="grid gap-4 md:grid-cols-3">
          {config.sections.map((section) => (
            <article key={section.title} className="border border-border bg-surface p-6">
              <h2 className="text-2xl font-black text-foreground">{section.title}</h2>
              <p className="mt-4 text-sm leading-7 text-muted">{section.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="border-y border-border bg-surface py-16">
        <div className="mx-auto w-full max-w-7xl px-5 sm:px-6 lg:px-8">
          <h2 className="text-4xl font-black text-foreground">{config.comparisonTitle}</h2>
          <div className="mt-8 overflow-hidden border border-border">
            <div className="grid grid-cols-[0.8fr_1fr_1fr] border-b border-border bg-surface text-xs font-bold uppercase tracking-wide text-muted">
              <div className="p-4">Need</div>
              <div className="p-4 text-muted">OpenReply</div>
              <div className="p-4">Generic automation</div>
            </div>
            {config.comparisons.map((item) => (
              <div
                key={item.label}
                className="grid grid-cols-1 border-b border-border last:border-0 md:grid-cols-[0.8fr_1fr_1fr]"
              >
                <div className="bg-surface p-4 text-sm font-semibold text-foreground">
                  {item.label}
                </div>
                <div className="p-4 text-sm leading-6 text-muted">
                  {item.ours}
                </div>
                <div className="p-4 text-sm leading-6 text-muted">
                  {item.other}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto grid w-full max-w-7xl gap-8 px-5 py-16 sm:px-6 lg:grid-cols-[0.9fr_1.1fr] lg:px-8">
        <div>
          <p className="text-sm font-bold uppercase text-muted">
            Start from a template
          </p>
          <h2 className="mt-3 text-4xl font-black text-foreground">
            Launch a campaign faster than building a chatbot flow
          </h2>
          <p className="mt-5 text-sm leading-7 text-muted">
            Use a campaign template, connect the right Instagram account, pick
            the post, and ship a measurable comment-to-DM loop.
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {config.templateLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="border border-border bg-surface p-5 text-sm font-semibold text-foreground transition hover:border-accent/30 hover:bg-accent/10"
            >
              {link.label}
            </Link>
          ))}
        </div>
      </section>

      <section className="border-t border-border bg-surface py-16">
        <div className="mx-auto grid w-full max-w-7xl gap-8 px-5 sm:px-6 lg:grid-cols-[0.8fr_1.2fr] lg:px-8">
          <div>
            <p className="text-sm font-bold uppercase text-muted">FAQ</p>
            <h2 className="mt-3 text-4xl font-black text-foreground">
              Search questions, answered clearly
            </h2>
          </div>
          <div className="grid gap-3">
            {config.faqs.map((faq) => (
              <article key={faq.title} className="border border-border bg-surface p-5">
                <h3 className="text-lg font-bold text-foreground">{faq.title}</h3>
                <p className="mt-2 text-sm leading-6 text-muted">{faq.body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto w-full max-w-7xl px-5 py-16 sm:px-6 lg:px-8">
        <div className="border border-accent/20 bg-accent/10 p-8 text-center">
          <h2 className="text-4xl font-black text-foreground">
            Turn the next high-intent comment into a private reply
          </h2>
          <p className="mx-auto mt-4 max-w-2xl text-sm leading-7 text-foreground">
            OpenReply is built for Instagram professional accounts, official
            Meta private replies, and campaign reporting teams can show clients.
          </p>
          <Link
            href="/login"
            className="mt-8 inline-flex items-center justify-center bg-accent px-6 py-3 text-sm font-bold text-white transition hover:bg-accent-hover"
          >
            Start free
          </Link>
        </div>
      </section>
    </main>
  );
}

