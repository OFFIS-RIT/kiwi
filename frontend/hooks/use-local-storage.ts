"use client";

import { useEffect, useState } from "react";

/**
 * Custom hook for syncing state with localStorage
 * Handles SSR/hydration properly by:
 * 1. Starting with default value (matches SSR)
 * 2. Restoring from localStorage after mount (client-side only)
 * 3. Saving changes back to localStorage
 *
 * @param key - localStorage key
 * @param defaultValue - Default value (used for SSR and when no stored value exists)
 * @returns [value, setValue] - Same API as useState
 */
export function useLocalStorage<T>(
  key: string,
  defaultValue: T
): [T, React.Dispatch<React.SetStateAction<T>>] {
  // Always start with default value to match SSR
  const [value, setValue] = useState<T>(defaultValue);
  const [isHydrated, setIsHydrated] = useState(false);

  // Restore from localStorage after mount (client-side only)
  useEffect(() => {
    if (typeof window === "undefined") return;

    try {
      const stored = localStorage.getItem(key);
      if (stored !== null) {
        setValue(JSON.parse(stored));
      }
    } catch (error) {
      console.error(`Failed to load "${key}" from localStorage:`, error);
    }

    setIsHydrated(true);
  }, [key]);

  // Save to localStorage whenever value changes (only after hydration)
  useEffect(() => {
    if (!isHydrated || typeof window === "undefined") return;

    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
      console.error(`Failed to save "${key}" to localStorage:`, error);
    }
  }, [key, value, isHydrated]);

  return [value, setValue];
}
