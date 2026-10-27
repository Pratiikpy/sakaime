import type { ReactElement } from "react";
import type { IconName } from "../lib/vocab";

/**
 * Small line icons. Each state has its own shape (check, half check, cross, gap, person) so a finding is readable
 * without colour. Icons are decorative: the word next to them carries the meaning.
 */
const PATHS: Record<IconName, ReactElement> = {
  check: <path d="M3 8.5 6.5 12 13 4.5" />,
  "check-partial": (
    <>
      <path d="M2.5 8.5 5.5 11.5 9 7" />
      <path d="M11 5.5h3M11 8h3M11 10.5h3" opacity="0.6" />
    </>
  ),
  cross: <path d="M4 4l8 8M12 4l-8 8" />,
  gap: <path d="M3 8h2.2M7 8h2M10.8 8H13" />,
  person: (
    <>
      <circle cx="8" cy="5.5" r="2.4" />
      <path d="M3.2 13c.4-2.6 2.2-4 4.8-4s4.4 1.4 4.8 4" />
    </>
  ),
  empty: (
    <>
      <circle cx="8" cy="8" r="5" />
      <path d="M4.6 11.4 11.4 4.6" />
    </>
  ),
  unplugged: (
    <>
      <path d="M5.5 2.5v3M10.5 2.5v3M4 5.5h8v1.5a4 4 0 0 1-8 0V5.5z" />
      <path d="M8 11v2.5" />
      <path d="M2.5 2.5l11 11" />
    </>
  ),
  drift: <path d="M2 6c1.5-1.6 3-1.6 4.5 0S9.5 7.6 11 6M2 10.5c1.5-1.6 3-1.6 4.5 0s3 1.6 4.5 0M13.5 5l1.5 1.2-1.7 1" />,
  lock: (
    <>
      <rect x="3.5" y="7" width="9" height="6.5" rx="1" />
      <path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7" />
    </>
  ),
  clock: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 4.8V8l2.2 1.4" />
    </>
  ),
  block: (
    <>
      <path d="M8 2 3 4v4c0 3 2 5 5 6 3-1 5-3 5-6V4L8 2z" />
      <path d="M5.8 8h4.4" />
    </>
  ),
  warn: (
    <>
      <path d="M8 2.5 14 13H2L8 2.5z" />
      <path d="M8 6.5v3M8 11.2v.1" />
    </>
  ),
  info: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 7.4V11M8 5.2v.1" />
    </>
  ),
  copy: (
    <>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.2" />
      <path d="M10.5 5.5V3.7a1.2 1.2 0 0 0-1.2-1.2H3.7a1.2 1.2 0 0 0-1.2 1.2v5.6a1.2 1.2 0 0 0 1.2 1.2h1.8" />
    </>
  ),
  chevron: <path d="M5.5 3.5 10 8l-4.5 4.5" />,
  sun: (
    <>
      <circle cx="8" cy="8" r="2.8" />
      <path d="M8 1.8v1.4M8 12.8v1.4M1.8 8h1.4M12.8 8h1.4M3.6 3.6l1 1M11.4 11.4l1 1M12.4 3.6l-1 1M4.6 11.4l-1 1" />
    </>
  ),
  moon: <path d="M13 9.4A5.4 5.4 0 0 1 6.6 3 5.4 5.4 0 1 0 13 9.4z" />,
  menu: <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />,
  close: <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />,
  play: <path d="M5 3.2v9.6L12.5 8 5 3.2z" />,
  arrow: <path d="M3 8h9.5M8.5 4l4 4-4 4" />,
  file: (
    <>
      <path d="M4 2.5h5l3 3v8H4v-11z" />
      <path d="M9 2.5v3h3M6 8.5h4M6 10.8h4" />
    </>
  ),
  link: <path d="M6.8 9.2a2.5 2.5 0 0 0 3.5 0l2-2a2.5 2.5 0 0 0-3.5-3.5l-.6.6M9.2 6.8a2.5 2.5 0 0 0-3.5 0l-2 2a2.5 2.5 0 0 0 3.5 3.5l.6-.6" />,
  database: (
    <>
      <ellipse cx="8" cy="4" rx="4.8" ry="1.8" />
      <path d="M3.2 4v8c0 1 2.1 1.8 4.8 1.8s4.8-.8 4.8-1.8V4M3.2 8c0 1 2.1 1.8 4.8 1.8s4.8-.8 4.8-1.8" />
    </>
  ),
  bolt: <path d="M9 2 4 9h3.5L7 14l5-7H8.5L9 2z" />,
  shield: <path d="M8 2 3 4v4c0 3 2 5 5 6 3-1 5-3 5-6V4L8 2z" />,
  recorded: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <circle cx="8" cy="8" r="1.8" fill="currentColor" stroke="none" />
    </>
  ),
  constructed: (
    <>
      <path d="M2.5 13.5h11M4 13.5V7l4-3.5L12 7v6.5" />
      <path d="M6.8 13.5v-3h2.4v3" />
    </>
  ),
};

export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      className={`icon${className ? ` ${className}` : ""}`}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
