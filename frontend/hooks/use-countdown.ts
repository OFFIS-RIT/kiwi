"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Custom hook for real-time countdown from a server-provided time remaining value.
 * Decrements every second and syncs with new server values when they change.
 *
 * @param serverTimeRemaining - Time remaining in milliseconds from server (undefined when not processing)
 * @returns Current countdown value in milliseconds, or undefined if not counting
 */
export function useCountdown(
  serverTimeRemaining: number | undefined
): number | undefined {
  const [countdown, setCountdown] = useState<number | undefined>(
    serverTimeRemaining
  );
  const lastServerValueRef = useRef<number | undefined>(serverTimeRemaining);

  // Sync with server value when it changes
  useEffect(() => {
    if (serverTimeRemaining !== lastServerValueRef.current) {
      setCountdown(serverTimeRemaining);
      lastServerValueRef.current = serverTimeRemaining;
    }
  }, [serverTimeRemaining]);

  // Decrement countdown every second
  // Depend on serverTimeRemaining (stable between server updates) instead of countdown
  // to avoid recreating the interval on every tick
  useEffect(() => {
    if (serverTimeRemaining === undefined) {
      return;
    }

    const intervalId = setInterval(() => {
      setCountdown((prev) => {
        if (prev === undefined || prev <= 1000) {
          return prev !== undefined && prev > 0 ? 0 : prev;
        }
        return prev - 1000;
      });
    }, 1000);

    return () => clearInterval(intervalId);
  }, [serverTimeRemaining]);

  return countdown;
}
