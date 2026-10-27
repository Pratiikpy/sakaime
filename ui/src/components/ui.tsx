import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Icon } from "./Icon";
import { useAnnounce } from "./feedback";

export function PageHeader({ eyebrow, title, lead, badges, actions }: { eyebrow?: string; title: ReactNode; lead?: ReactNode; badges?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-header">
      {eyebrow && <p className="eyebrow">{eyebrow}</p>}
      <div className="page-header__row">
        <h1 className="page-title" id="page-title" tabIndex={-1}>
          {title}
        </h1>
        {actions && <div className="page-header__actions">{actions}</div>}
      </div>
      {badges && <div className="badge-row">{badges}</div>}
      {lead && <div className="lead">{lead}</div>}
    </header>
  );
}

export function Section({ id, title, aside, children, level = 2 }: { id?: string; title: ReactNode; aside?: ReactNode; children: ReactNode; level?: 2 | 3 }) {
  const H = level === 2 ? "h2" : "h3";
  return (
    <section className="section" aria-labelledby={id ? `${id}-h` : undefined} id={id}>
      <div className="section__head">
        <H className="section__title" id={id ? `${id}-h` : undefined}>
          {title}
        </H>
        {aside && <div className="section__aside">{aside}</div>}
      </div>
      {children}
    </section>
  );
}

export function CopyButton({ text, label = "Copy", what }: { text: string; label?: string; what?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const announce = useAnnounce();
  const timer = useRef<number>(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = async () => {
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      // Clipboard can be blocked (permissions, insecure origin). Fall back to a selection copy.
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        ok = document.execCommand("copy");
      } catch {
        ok = false;
      }
      ta.remove();
    }
    setState(ok ? "copied" : "failed");
    announce(ok ? `${what ?? "Text"} copied to the clipboard` : "Copy was blocked by the browser. Select the text and copy it by hand.");
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState("idle"), 2200);
  };
  return (
    <button type="button" className="btn btn-ghost btn-sm" onClick={copy} aria-label={what ? `${label} ${what}` : label}>
      <Icon name={state === "copied" ? "check" : "copy"} size={14} />
      <span>{state === "copied" ? "Copied" : state === "failed" ? "Copy blocked" : label}</span>
    </button>
  );
}

/** A native disclosure: works without script, with the keyboard and with a screen reader. */
export function Disclosure({ summary, children, defaultOpen = false, className = "", onToggle }: { summary: ReactNode; children: ReactNode; defaultOpen?: boolean; className?: string; onToggle?: (open: boolean) => void }) {
  return (
    <details className={`disclosure ${className}`} open={defaultOpen} onToggle={(e) => onToggle?.((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>
        <Icon name="chevron" size={14} className="disclosure__chev" />
        <span>{summary}</span>
      </summary>
      <div className="disclosure__body">{children}</div>
    </details>
  );
}

/**
 * Long values (an exclusion list, a vendor request) show the first few lines and open on request. The whole text is always in
 * the page, so screen readers, search and copy see it all; only the sighted view is shortened, and only when it overflows.
 */
export function Clamp({ text, lines = 3, tag = "span" }: { text: string; lines?: number; tag?: "span" | "mark" }) {
  const Tag = tag;
  const ref = useRef<HTMLElement>(null);
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      if (!open) setOverflows(el.scrollHeight > el.clientHeight + 1);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, open, lines]);
  return (
    <>
      <Tag ref={ref as React.RefObject<HTMLSpanElement>} className={`clamp${open ? "" : " is-clamped"}`} style={{ "--lines": lines } as CSSProperties}>
        {text}
      </Tag>
      {(overflows || open) && (
        <button type="button" className="linkish" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? "Show less" : "Show all"}
        </button>
      )}
    </>
  );
}

export function Mono({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <code className="mono-chip" title={title}>
      {children}
    </code>
  );
}

export function Redaction({ width = 56 }: { width?: number }) {
  return <span className="redaction-bar" style={{ width }} aria-hidden="true" />;
}

export function Stat({ value, label, hint }: { value: ReactNode; label: string; hint?: string }) {
  return (
    <div className="stat">
      <div className="stat__value">{value}</div>
      <div className="stat__label">{label}</div>
      {hint && <div className="stat__hint">{hint}</div>}
    </div>
  );
}

/** Sets the document title. Focus moves to the page heading in Layout on every route change. */
export function useDocTitle(title: string) {
  useEffect(() => {
    document.title = `${title} | Sakaime`;
  }, [title]);
}
