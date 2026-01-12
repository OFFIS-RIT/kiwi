"use client";

import { Loader2 } from "lucide-react";

interface LoadingFallbackProps {
  message?: string;
}

/**
 * Loading fallback component for Suspense boundaries
 * Shows a centered spinner with optional message
 */
export function LoadingFallback({
  message = "Laden...",
}: LoadingFallbackProps) {
  return (
    <div className="flex h-full min-h-[400px] items-center justify-center">
      <div className="flex flex-col items-center gap-3">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <p className="text-sm text-muted-foreground">{message}</p>
      </div>
    </div>
  );
}
