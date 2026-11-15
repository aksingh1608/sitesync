"use client";
// Field UI primitives: big tap targets (>= 48 px), high contrast, large text.
import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";

const TONES = {
  primary: "bg-blue-700 text-white active:bg-blue-800 disabled:bg-slate-400",
  success: "bg-green-700 text-white active:bg-green-800 disabled:bg-slate-400",
  danger: "bg-red-700 text-white active:bg-red-800 disabled:bg-slate-400",
  warning: "bg-amber-500 text-black active:bg-amber-600 disabled:bg-slate-300",
  neutral: "bg-white text-slate-950 border-2 border-slate-800 active:bg-slate-100 disabled:text-slate-400 disabled:border-slate-300",
} as const;
export type Tone = keyof typeof TONES;

export function BigButton({
  tone = "primary",
  className,
  ...props
}: ComponentProps<"button"> & { tone?: Tone }) {
  return (
    <button
      type="button"
      className={cn(
        "flex min-h-14 w-full items-center justify-center gap-2 rounded-xl px-4 text-lg font-bold disabled:cursor-not-allowed",
        TONES[tone],
        className,
      )}
      {...props}
    />
  );
}

export function BigLink({ tone = "neutral", className, ...props }: ComponentProps<typeof Link> & { tone?: Tone }) {
  return (
    <Link
      className={cn("flex min-h-14 w-full items-center justify-center gap-2 rounded-xl px-4 text-lg font-bold", TONES[tone], className)}
      {...props}
    />
  );
}

export function Chip({ active, className, ...props }: ComponentProps<"button"> & { active: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={cn(
        "min-h-12 rounded-full border-2 px-4 text-base font-semibold",
        active ? "border-slate-950 bg-slate-950 text-white" : "border-slate-400 bg-white text-slate-900",
        className,
      )}
      {...props}
    />
  );
}

/** The "waiting to sync" marker on any row the server has not confirmed yet. */
export function WaitingMarker({ label = "Waiting to sync" }: { label?: string }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-md border border-amber-600 bg-amber-100 px-2 py-0.5 text-sm font-semibold text-amber-900"
      data-testid="waiting-marker"
    >
      <span aria-hidden className="size-2 rounded-full bg-amber-600" />
      {label}
    </span>
  );
}

export function PageTitle({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  return (
    <header className="space-y-1">
      <h1 className="text-2xl font-bold text-slate-950">{children}</h1>
      {sub && <p className="text-base text-slate-700">{sub}</p>}
    </header>
  );
}

export function Panel({ className, ...props }: ComponentProps<"section">) {
  return <section className={cn("space-y-3 rounded-xl border-2 border-slate-300 bg-white p-4", className)} {...props} />;
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block space-y-1">
      <span className="text-base font-semibold text-slate-900">{label}</span>
      {children}
      {hint && <span className="block text-sm text-slate-600">{hint}</span>}
    </label>
  );
}

export const inputClass =
  "block min-h-12 w-full rounded-lg border-2 border-slate-500 bg-white px-3 py-2 text-lg text-slate-950 focus:border-blue-700 focus:outline-none";

export const PRIORITY_STYLE: Record<string, string> = {
  urgent: "bg-red-700 text-white",
  high: "bg-orange-200 text-orange-950 border border-orange-700",
  normal: "bg-slate-100 text-slate-900 border border-slate-400",
  low: "bg-slate-50 text-slate-700 border border-slate-300",
};

export function Pill({ className, ...props }: ComponentProps<"span">) {
  return <span className={cn("inline-flex items-center rounded-md px-2 py-0.5 text-sm font-semibold", className)} {...props} />;
}
