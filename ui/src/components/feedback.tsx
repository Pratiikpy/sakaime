import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type { ApiError } from "../api/client";
import { Icon } from "./Icon";
import type { IconName } from "../lib/vocab";

// ---------------------------------------------------------------- announcements for screen readers

const AnnounceContext = createContext<(message: string) => void>(() => undefined);
export const useAnnounce = () => useContext(AnnounceContext);

export function AnnouncerProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState("");
  const flip = useRef(false);
  const announce = useCallback((m: string) => {
    // Alternate a trailing space so the same message twice is still read out.
    flip.current = !flip.current;
    setMessage(flip.current ? m : `${m} `);
  }, []);
  const value = useMemo(() => announce, [announce]);
  return (
    <AnnounceContext.Provider value={value}>
      {children}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-testid="announcer">
        {message}
      </div>
    </AnnounceContext.Provider>
  );
}

// ---------------------------------------------------------------- loading, empty, error

export function Loading({ label = "Loading", rows = 3 }: { label?: string; rows?: number }) {
  return (
    <div className="skeleton" role="status" aria-busy="true" aria-live="polite">
      <span className="sr-only">{label}…</span>
      {Array.from({ length: rows }, (_, i) => (
        <span key={i} className="skeleton__bar" style={{ width: `${92 - i * 14}%` }} />
      ))}
    </div>
  );
}

export function EmptyState({ title, children, icon = "empty", action }: { title: string; children?: ReactNode; icon?: IconName; action?: ReactNode }) {
  return (
    <div className="state state-empty" role="status">
      <Icon name={icon} size={22} />
      <div className="state__body">
        <h3 className="state__title">{title}</h3>
        {children && <div className="state__text">{children}</div>}
        {action && <div className="state__action">{action}</div>}
      </div>
    </div>
  );
}

const FAILURE_COPY: Record<string, { title: string; hint: string; icon: IconName }> = {
  UNAVAILABLE: { title: "Could not be reached", hint: "This is on our side. It says nothing about whether the evidence exists. Try again in a moment.", icon: "unplugged" },
  FORBIDDEN: { title: "Refused by policy", hint: "A rule or identity refused this request. This is not an outage and retrying will not help.", icon: "lock" },
  REFUSED: { title: "Refused by a guard", hint: "Our own guard declined this. The reason is below; change the input and try again.", icon: "block" },
  INVALID: { title: "Check the input", hint: "The service could not use what was sent. Fix the input and try again.", icon: "warn" },
  DRIFTED: { title: "A source changed shape", hint: "The data is not read until its mapping is reviewed.", icon: "drift" },
  TRUNCATED: { title: "The result was cut short", hint: "An incomplete result is refused, never used as a partial answer.", icon: "warn" },
  BLOCKED: { title: "Blocked for scripts", hint: "The provider refuses automated access.", icon: "block" },
  NOT_FOUND: { title: "Not found", hint: "That item does not exist. It may have been mistyped, or the service restarted.", icon: "empty" },
  RATE_LIMITED: { title: "Too many requests", hint: "Nothing is wrong with the case or the request. The service limits how fast this can be asked for; wait for the time shown and try again.", icon: "clock" },
  CONTRACT: { title: "Unexpected reply", hint: "The service replied in a shape this app does not recognise. Nothing is shown rather than something wrong.", icon: "warn" },
};

/** A retry button that stays off for as long as the service asked the client to wait, and says how long is left. */
function RetryButton({ onRetry, waitSeconds }: { onRetry: () => void; waitSeconds: number }) {
  const [left, setLeft] = useState(waitSeconds);
  useEffect(() => {
    if (left <= 0) return;
    const t = window.setTimeout(() => setLeft((n) => n - 1), 1000);
    return () => window.clearTimeout(t);
  }, [left]);
  return (
    <button type="button" className="btn btn-secondary" onClick={onRetry} disabled={left > 0} data-testid="retry-button">
      {left > 0 ? `Try again in ${left} s` : "Try again"}
    </button>
  );
}

export function ErrorState({ error, onRetry, title }: { error: ApiError; onRetry?: () => void; title?: string }) {
  const copy = FAILURE_COPY[error.failure] ?? { title: "Something went wrong", hint: "Try again. If it keeps happening, the service log has the detail.", icon: "warn" as IconName };
  const issues = Array.isArray(error.detail?.["issues"]) ? (error.detail?.["issues"] as string[]) : [];
  // The service names the cases it does know when asked for one it does not.
  const known = error.failure === "NOT_FOUND" && Array.isArray(error.detail?.["known"]) ? (error.detail?.["known"] as unknown[]).filter((k): k is string => typeof k === "string") : [];
  return (
    <div className="state state-error" role="alert" data-failure={error.failure}>
      <Icon name={copy.icon} size={22} />
      <div className="state__body">
        <h3 className="state__title">{title ?? copy.title}</h3>
        <p className="state__text">{error.message}</p>
        <p className="state__hint">{copy.hint}</p>
        {issues.length > 0 && (
          <ul className="state__issues mono">
            {issues.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
        )}
        {known.length > 0 && (
          <p className="state__hint">
            Cases this service has:{" "}
            {known.map((k, i) => (
              <span key={k}>
                {i > 0 && ", "}
                <Link to={`/cases/${encodeURIComponent(k)}`}>{k}</Link>
              </span>
            ))}
            .
          </p>
        )}
        <p className="state__code mono">{error.failure}</p>
        {onRetry && (
          <div className="state__action">
            <RetryButton onRetry={onRetry} waitSeconds={error.failure === "RATE_LIMITED" && typeof error.detail?.["retryAfterSeconds"] === "number" ? (error.detail["retryAfterSeconds"] as number) : 0} />
          </div>
        )}
      </div>
    </div>
  );
}

export function Notice({ tone = "info", title, children }: { tone?: "info" | "warn" | "bad" | "good"; title?: string; children: ReactNode }) {
  const icon: IconName = tone === "bad" ? "cross" : tone === "warn" ? "warn" : tone === "good" ? "check" : "info";
  return (
    <div className={`notice notice-${tone}`}>
      <Icon name={icon} size={18} />
      <div>
        {title && <strong className="notice__title">{title}</strong>}
        <div className="notice__text">{children}</div>
      </div>
    </div>
  );
}
