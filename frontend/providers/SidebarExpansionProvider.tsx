"use client";

import type React from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

/**
 * Context value type for the SidebarExpansionProvider.
 */
type SidebarExpansionContextType = {
  expandedGroups: Record<string, boolean>;
  setExpandedGroups: React.Dispatch<
    React.SetStateAction<Record<string, boolean>>
  >;
  toggleGroupExpanded: (groupId: string) => void;
  initializeExpandedGroups: (groupIds: string[]) => void;
  preserveExpansionDuringSearch: () => Record<string, boolean>;
  restoreExpansionAfterSearch: (originalState: Record<string, boolean>) => void;
  expandGroupsForSearch: (groupIds: string[]) => void;
};

const SidebarExpansionContext = createContext<
  SidebarExpansionContextType | undefined
>(undefined);

const STORAGE_KEY = "sidebar-expanded-groups";

/**
 * Loads expanded group state from localStorage with validation.
 * @returns Record of group IDs to expansion state, or empty object on failure
 */
const loadExpandedGroupsFromStorage = (): Record<string, boolean> => {
  if (typeof window === "undefined") return {};

  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      // Validate that parsed data is an object with boolean values
      if (typeof parsed === "object" && parsed !== null) {
        const isValid = Object.values(parsed).every(
          (val) => typeof val === "boolean"
        );
        if (isValid) {
          return parsed;
        }
      }
    }
  } catch (error) {
    console.warn(
      "Failed to load sidebar expansion state from localStorage:",
      error
    );
  }

  return {};
};

/**
 * Persists expanded group state to localStorage.
 * @param expandedGroups - Record of group IDs to expansion state
 */
const saveExpandedGroupsToStorage = (
  expandedGroups: Record<string, boolean>
) => {
  if (typeof window === "undefined") return;

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(expandedGroups));
  } catch (error) {
    console.warn(
      "Failed to save sidebar expansion state to localStorage:",
      error
    );
  }
};

/**
 * Manages sidebar group expansion state with localStorage persistence.
 * Provides utilities for search-related expansion (expand during search, restore after).
 */
export function SidebarExpansionProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>(
    loadExpandedGroupsFromStorage
  );
  const originalExpandedStateRef = useRef<Record<string, boolean>>({});
  const isInitializedRef = useRef(false);

  // Save to localStorage whenever expandedGroups changes (but not on initial load)
  useEffect(() => {
    if (isInitializedRef.current) {
      saveExpandedGroupsToStorage(expandedGroups);
    }
  }, [expandedGroups]);

  // Mark as initialized after first render
  useEffect(() => {
    isInitializedRef.current = true;
  }, []);

  // Initialize expanded groups with all groups collapsed by default
  const initializeExpandedGroups = useCallback((groupIds: string[]) => {
    setExpandedGroups((prev) => {
      const newState: Record<string, boolean> = {};

      // Load from localStorage on first initialization if prev is empty
      const storedState =
        Object.keys(prev).length === 0 ? loadExpandedGroupsFromStorage() : prev;

      // Preserve existing state for groups that still exist
      groupIds.forEach((groupId) => {
        newState[groupId] = storedState[groupId] ?? false;
      });

      return newState;
    });
  }, []);

  // Toggle a specific group's expanded state
  const toggleGroupExpanded = useCallback((groupId: string) => {
    setExpandedGroups((prev) => ({
      ...prev,
      [groupId]: !prev[groupId],
    }));
  }, []);

  // Save current expansion state for search functionality
  const preserveExpansionDuringSearch = useCallback(() => {
    const currentState = { ...expandedGroups };
    originalExpandedStateRef.current = currentState;
    return currentState;
  }, [expandedGroups]);

  // Restore expansion state after search
  const restoreExpansionAfterSearch = useCallback(
    (originalState: Record<string, boolean>) => {
      setExpandedGroups(originalState);
    },
    []
  );

  // Expand specific groups during search
  const expandGroupsForSearch = useCallback((groupIds: string[]) => {
    setExpandedGroups((prev) => {
      const newState = { ...prev };
      groupIds.forEach((groupId) => {
        newState[groupId] = true;
      });
      return newState;
    });
  }, []);

  return (
    <SidebarExpansionContext.Provider
      value={{
        expandedGroups,
        setExpandedGroups,
        toggleGroupExpanded,
        initializeExpandedGroups,
        preserveExpansionDuringSearch,
        restoreExpansionAfterSearch,
        expandGroupsForSearch,
      }}
    >
      {children}
    </SidebarExpansionContext.Provider>
  );
}

/**
 * Hook to access sidebar expansion state and controls.
 * Must be used within a SidebarExpansionProvider.
 *
 * @returns Expansion state and control functions
 * @throws Error if used outside of SidebarExpansionProvider
 */
export function useSidebarExpansion() {
  const context = useContext(SidebarExpansionContext);
  if (context === undefined) {
    throw new Error(
      "useSidebarExpansion must be used within a SidebarExpansionProvider"
    );
  }
  return context;
}
