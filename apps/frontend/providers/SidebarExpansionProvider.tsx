"use client";

import type React from "react";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

/**
 * Context value type for the SidebarExpansionProvider.
 */
type SidebarExpansionContextType = {
    expandedGroups: Record<string, boolean>;
    setExpandedGroups: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
    expandedProjects: Record<string, boolean>;
    setExpandedProjects: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
    toggleGroupExpanded: (groupId: string) => void;
    toggleProjectExpanded: (projectId: string) => void;
    initializeExpandedGroups: (groupIds: string[]) => void;
    initializeExpandedProjects: (projectIds: string[]) => void;
    preserveExpansionDuringSearch: () => Record<string, boolean>;
    restoreExpansionAfterSearch: (originalGroups: Record<string, boolean>, originalProjects?: Record<string, boolean>) => void;
    expandGroupsForSearch: (groupIds: string[], projectIds?: string[]) => void;
};

const SidebarExpansionContext = createContext<SidebarExpansionContextType | undefined>(undefined);

const GROUP_STORAGE_KEY = "sidebar-expanded-groups";
const PROJECT_STORAGE_KEY = "sidebar-expanded-projects";

/**
 * Loads expanded state from localStorage with validation.
 * @returns Record of IDs to expansion state, or empty object on failure
 */
const loadExpandedStateFromStorage = (storageKey: string): Record<string, boolean> => {
    if (typeof window === "undefined") return {};

    try {
        const stored = localStorage.getItem(storageKey);
        if (stored) {
            const parsed = JSON.parse(stored);
            // Validate that parsed data is an object with boolean values
            if (typeof parsed === "object" && parsed !== null) {
                const isValid = Object.values(parsed).every((val) => typeof val === "boolean");
                if (isValid) {
                    return parsed;
                }
            }
        }
    } catch (error) {
        console.warn("Failed to load sidebar expansion state from localStorage:", error);
    }

    return {};
};

/**
 * Persists expanded state to localStorage.
 */
const saveExpandedStateToStorage = (storageKey: string, expandedState: Record<string, boolean>) => {
    if (typeof window === "undefined") return;

    try {
        localStorage.setItem(storageKey, JSON.stringify(expandedState));
    } catch (error) {
        console.warn("Failed to save sidebar expansion state to localStorage:", error);
    }
};

const areExpansionStatesEqual = (left: Record<string, boolean>, right: Record<string, boolean>) => {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key) => left[key] === right[key]);
};

/**
 * Manages sidebar group expansion state with localStorage persistence.
 * Provides utilities for search-related expansion (expand during search, restore after).
 */
export function SidebarExpansionProvider({ children }: { children: React.ReactNode }) {
    const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>(() =>
        loadExpandedStateFromStorage(GROUP_STORAGE_KEY)
    );
    const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>(() =>
        loadExpandedStateFromStorage(PROJECT_STORAGE_KEY)
    );
    const originalExpandedStateRef = useRef<Record<string, boolean>>({});
    const isInitializedRef = useRef(false);

    // Save to localStorage whenever expandedGroups changes (but not on initial load)
    useEffect(() => {
        if (isInitializedRef.current) {
            saveExpandedStateToStorage(GROUP_STORAGE_KEY, expandedGroups);
        }
    }, [expandedGroups]);

    useEffect(() => {
        if (isInitializedRef.current) {
            saveExpandedStateToStorage(PROJECT_STORAGE_KEY, expandedProjects);
        }
    }, [expandedProjects]);

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
                Object.keys(prev).length === 0 ? loadExpandedStateFromStorage(GROUP_STORAGE_KEY) : prev;

            // Preserve existing state for groups that still exist
            groupIds.forEach((groupId) => {
                newState[groupId] = storedState[groupId] ?? false;
            });

            if (areExpansionStatesEqual(prev, newState)) return prev;
            return newState;
        });
    }, []);

    const initializeExpandedProjects = useCallback((projectIds: string[]) => {
        setExpandedProjects((prev) => {
            const storedState =
                Object.keys(prev).length === 0 ? loadExpandedStateFromStorage(PROJECT_STORAGE_KEY) : prev;

            const newState = Object.fromEntries(
                projectIds.map((projectId) => [projectId, storedState[projectId] ?? false])
            );

            if (areExpansionStatesEqual(prev, newState)) return prev;
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

    const toggleProjectExpanded = useCallback((projectId: string) => {
        setExpandedProjects((prev) => ({
            ...prev,
            [projectId]: !prev[projectId],
        }));
    }, []);

    // Save current expansion state for search functionality
    const preserveExpansionDuringSearch = useCallback(() => {
        const currentState = { ...expandedGroups };
        originalExpandedStateRef.current = currentState;
        return currentState;
    }, [expandedGroups]);

    // Restore expansion state after search
    const restoreExpansionAfterSearch = useCallback((originalGroups: Record<string, boolean>, originalProjects?: Record<string, boolean>) => {
        setExpandedGroups(originalGroups);
        if (originalProjects) {
            setExpandedProjects(originalProjects);
        }
    }, []);

    // Expand specific groups during search
    const expandGroupsForSearch = useCallback((groupIds: string[], projectIds: string[] = []) => {
        setExpandedGroups((prev) => {
            const newState = { ...prev };
            groupIds.forEach((groupId) => {
                newState[groupId] = true;
            });
            return newState;
        });
        setExpandedProjects((prev) => {
            const newState = { ...prev };
            projectIds.forEach((projectId) => {
                newState[projectId] = true;
            });
            return newState;
        });
    }, []);

    return (
        <SidebarExpansionContext.Provider
            value={{
                expandedGroups,
                setExpandedGroups,
                expandedProjects,
                setExpandedProjects,
                toggleGroupExpanded,
                toggleProjectExpanded,
                initializeExpandedGroups,
                initializeExpandedProjects,
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
        throw new Error("useSidebarExpansion must be used within a SidebarExpansionProvider");
    }
    return context;
}
