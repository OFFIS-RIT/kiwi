"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type React from "react";
import { useState } from "react";

/**
 * Provides TanStack Query client with sensible defaults for the application.
 * Creates a new QueryClient per component instance to prevent data leaking between sessions.
 *
 * Configuration:
 * - staleTime: 30 seconds
 * - gcTime: 5 minutes
 * - retry: 1 attempt for both queries and mutations
 * - refetchOnWindowFocus: enabled
 * - refetchOnMount: disabled (uses stale data)
 */
export function QueryProvider({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30 * 1000,
            gcTime: 5 * 60 * 1000,
            retry: 1,
            refetchOnWindowFocus: true,
            refetchOnMount: false,
          },
          mutations: {
            retry: 1,
          },
        },
      })
  );

  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}
