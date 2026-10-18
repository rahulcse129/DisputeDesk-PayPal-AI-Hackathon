"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cx } from "./ui";

const LINKS = [
  { href: "/", label: "Disputes" },
  { href: "/cases", label: "Case history" },
];

export function NavLinks() {
  const pathname = usePathname();
  return (
    <nav className="flex items-center gap-1 text-sm">
      {LINKS.map((l) => {
        const active = l.href === "/" ? pathname === "/" || pathname.startsWith("/disputes") : pathname.startsWith(l.href);
        return (
          <Link
            key={l.href}
            href={l.href}
            className={cx(
              "rounded-md px-3 py-1.5 font-medium transition-colors",
              active ? "bg-slate-100 text-slate-900" : "text-slate-600 hover:bg-slate-50 hover:text-slate-900",
            )}
          >
            {l.label}
          </Link>
        );
      })}
    </nav>
  );
}
