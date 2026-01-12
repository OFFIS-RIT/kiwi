"use client";

import { AUTH_TOKEN } from "@/lib/api/client";
import { useLanguage } from "@/providers/LanguageProvider";
import { useEffect } from "react";
import { toast } from "sonner";

/**
 * Subscribes to real-time project events via Server-Sent Events (SSE).
 * Displays toast notifications for incoming events.
 * Automatically manages connection lifecycle with AbortController.
 *
 * NOTE: Connection is automatically closed on unmount or when projectId changes.
 *
 * @param projectId - The project ID to subscribe to, or null to disable
 */
export function useProjectEvents(projectId: string | null) {
  const { t } = useLanguage();

  useEffect(() => {
    if (!projectId) {
      return;
    }

    const controller = new AbortController();
    const signal = controller.signal;

    const connect = async () => {
      try {
        const response = await fetch(
          `${process.env.NEXT_PUBLIC_API_URL}/projects/${projectId}/events`,
          {
            headers: {
              Authorization: AUTH_TOKEN,
            },
            signal,
          }
        );

        if (!response.ok) {
          console.error(`SSE connection failed: ${response.statusText}`);
          toast.error(`SSE connection failed: ${response.statusText}`);
          return;
        }

        if (!response.body) {
          throw new Error("Response body is null");
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || ""; // Keep the last, possibly incomplete line

          for (const line of lines) {
            if (line.startsWith("data:")) {
              const dataString = line.substring(5).trim();
              try {
                if (dataString) {
                  toast.success(dataString);
                }
              } catch (e) {
                console.error("Failed to parse SSE data:", dataString, e);
              }
            }
          }
        }
      } catch (error) {
        if (error instanceof Error && error.name !== "AbortError") {
          console.error("SSE Error:", error);
        }
      }
    };

    connect();

    return () => {
      controller.abort();
    };
  }, [projectId, t]);
}
