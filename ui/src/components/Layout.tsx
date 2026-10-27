import { useEffect, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useParams } from "react-router-dom";
import { Icon } from "./Icon";
import { RunModeBanner } from "./RunModeBanner";
import { AnnouncerProvider } from "./feedback";

type Theme = "light" | "dark";

function currentTheme(): Theme {
  const set = document.documentElement.getAttribute("data-theme");
  if (set === "light" || set === "dark") return set;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(currentTheme);
  const toggle = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem("sakaime-theme", next);
    } catch {
      // Storage can be blocked. The choice then lasts for this visit only.
    }
    setTheme(next);
  };
  return (
    <button type="button" className="btn btn-ghost theme-toggle" onClick={toggle} aria-pressed={theme === "dark"} data-testid="theme-toggle">
      <Icon name={theme === "dark" ? "moon" : "sun"} size={16} />
      <span>{theme === "dark" ? "Dark" : "Light"}</span>
      <span className="sr-only"> theme, press to switch</span>
    </button>
  );
}

function Wordmark() {
  return (
    <Link to="/" className="wordmark">
      <span className="wordmark__mark" aria-hidden="true">
        <span className="wordmark__bar wordmark__bar--a" />
        <span className="wordmark__bar wordmark__bar--b" />
      </span>
      <span className="wordmark__name">Sakaime</span>
      <span className="wordmark__kanji" lang="ja" aria-hidden="true">
        境目
      </span>
    </Link>
  );
}

const TOP_NAV = [
  { to: "/cases", label: "Review desk" },
  { to: "/sources", label: "Sources" },
  { to: "/guard", label: "Guard" },
  { to: "/about", label: "About and limits" },
];

const CASE_NAV = [
  { to: "", label: "Overview", end: true },
  { to: "matrix", label: "Evidence matrix" },
  { to: "claims", label: "Claim X-ray" },
  { to: "lab", label: "Applicability lab" },
  { to: "timeline", label: "Timeline" },
  { to: "investigation", label: "Investigation" },
  { to: "drills", label: "Resilience" },
  { to: "dossier", label: "Dossier" },
];

function CaseNav({ id }: { id: string }) {
  const base = `/cases/${encodeURIComponent(id)}`;
  return (
    <nav className="case-nav" aria-label={`Case ${id}`}>
      <div className="case-nav__inner">
        <span className="case-nav__id mono">{id}</span>
        <ul>
          {CASE_NAV.map((n) => (
            <li key={n.label}>
              <NavLink to={n.to ? `${base}/${n.to}` : base} end={n.end} className={({ isActive }) => (isActive ? "is-active" : undefined)}>
                {n.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );
}

export function Layout() {
  const [menuOpen, setMenuOpen] = useState(false);
  const loc = useLocation();
  const params = useParams();
  const caseMatch = /^\/cases\/([^/]+)/.exec(loc.pathname);
  const caseId = caseMatch?.[1] ? decodeURIComponent(caseMatch[1]) : undefined;
  const first = useRef(true);
  void params;

  // On every route change: close the menu, scroll to top and put focus on the page heading so that a keyboard or
  // screen-reader user starts reading the new screen rather than the old navigation.
  useEffect(() => {
    setMenuOpen(false);
    window.scrollTo(0, 0);
    if (first.current) {
      first.current = false;
      return;
    }
    const raf = requestAnimationFrame(() => {
      const h = document.getElementById("page-title");
      if (h) h.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(raf);
  }, [loc.pathname]);

  return (
    <AnnouncerProvider>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <div className="chrome">
        <header className="site-header" role="banner">
          <div className="site-header__inner">
            <Wordmark />
            <button type="button" className="btn btn-ghost menu-button" aria-expanded={menuOpen} aria-controls="site-nav" onClick={() => setMenuOpen((o) => !o)}>
              <Icon name={menuOpen ? "close" : "menu"} size={18} />
              <span>Menu</span>
            </button>
            <nav id="site-nav" className={`site-nav${menuOpen ? " is-open" : ""}`} aria-label="Main">
              <ul>
                {TOP_NAV.map((n) => (
                  <li key={n.to}>
                    <NavLink to={n.to} className={({ isActive }) => (isActive || (n.to === "/cases" && loc.pathname.startsWith("/cases")) ? "is-active" : undefined)}>
                      {n.label}
                    </NavLink>
                  </li>
                ))}
              </ul>
              <ThemeToggle />
            </nav>
          </div>
        </header>
        <RunModeBanner />
      </div>
      {caseId && <CaseNav id={caseId} />}
      <main id="main" className="main" tabIndex={-1}>
        <div className="page">
          <Outlet />
        </div>
      </main>
      <footer className="site-footer" role="contentinfo">
        <div className="site-footer__inner">
          <p>
            <strong>Know where the evidence stops.</strong> Sakaime describes how far cited evidence reaches. It does not certify a product,
            rule on regulatory standing, or stand in for clinical judgement. It is not clinical decision support.
          </p>
          <ul className="footer-links">
            <li>
              <Link to="/about">Methods and limits</Link>
            </li>
            <li>
              <Link to="/sources">Sources</Link>
            </li>
            <li>
              <a href="https://github.com/Pratiikpy/sakaime">Code on GitHub</a>
            </li>
          </ul>
        </div>
      </footer>
    </AnnouncerProvider>
  );
}
