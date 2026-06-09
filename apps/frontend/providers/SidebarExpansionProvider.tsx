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
    expandSidebarPath: (groupIds: string[], projectIds?: string[]) => void;
};

const SidebarExpansionContext = createContext<SidebarExpansionContextType | undefined>(undefined);

const GROUP_STORAGE_KEY = "sidebar-expanded-groups";
const PROJECT_STORAGE_KEY = "sidebar-expanded-projects";

type StoredExpansionState = {
    expandedState: Record<string, boolean>;
    hasStoredState: boolean;
};

/**
 * Loads expanded state from localStorage with validation.
 * @returns Stored expansion state and whether the storage key exists
 */
const loadExpandedStateFromStorage = (storageKey: string): StoredExpansionState => {
    if (typeof window === "undefined") return { expandedState: {}, hasStoredState: false };

    try {
        const stored = localStorage.getItem(storageKey);
        if (stored === null) {
            return { expandedState: {}, hasStoredState: false };
        }

        if (stored) {
            const parsed = JSON.parse(stored);
            // Validate that parsed data is an object with boolean values
            if (typeof parsed === "object" && parsed !== null) {
                const isValid = Object.values(parsed).every((val) => typeof val === "boolean");
                if (isValid) {
                    return { expandedState: parsed, hasStoredState: true };
                }
            }
        }
    } catch (error) {
        console.warn("Failed to load sidebar expansion state from localStorage:", error);
    }

    return { expandedState: {}, hasStoredState: true };
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

const areExpansionStatesEqual = (first: Record<string, boolean>, second: Record<string, boolean>) => {
    const firstKeys = Object.keys(first);
    const secondKeys = Object.keys(second);

    return firstKeys.length === secondKeys.length && firstKeys.every((key) => first[key] === second[key]);
};

/**
 * Manages sidebar group expansion state with localStorage persistence.
 * Provides utilities for search-related expansion (expand during search, restore after).
 */
export function SidebarExpansionProvider({ children }: { children: React.ReactNode }) {
    const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>(() =>
        loadExpandedStateFromStorage(GROUP_STORAGE_KEY).expandedState
    );
    const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>(() =>
        loadExpandedStateFromStorage(PROJECT_STORAGE_KEY).expandedState
    );
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

    // First-time visitors have no persisted group state yet, so expose all accessible groups.
    const initializeExpandedGroups = useCallback((groupIds: string[]) => {
        if (groupIds.length === 0) return;
        setExpandedGroups((prev) => {
            const newState: Record<string, boolean> = {};

            // Load from localStorage on first initialization if prev is empty
            const storedState =
                Object.keys(prev).length === 0
                    ? loadExpandedStateFromStorage(GROUP_STORAGE_KEY)
                    : { expandedState: prev, hasStoredState: true };
            const defaultExpanded = !storedState.hasStoredState;

            // Preserve existing state for groups that still exist
            groupIds.forEach((groupId) => {
                newState[groupId] = storedState.expandedState[groupId] ?? defaultExpanded;
            });

            return areExpansionStatesEqual(prev, newState) ? prev : newState;
        });
    }, []);

    const initializeExpandedProjects = useCallback((projectIds: string[]) => {
        if (projectIds.length === 0) return;
        setExpandedProjects((prev) => {
            const storedState =
                Object.keys(prev).length === 0
                    ? loadExpandedStateFromStorage(PROJECT_STORAGE_KEY).expandedState
                    : prev;

            const newState = Object.fromEntries(
                projectIds.map((projectId) => [projectId, storedState[projectId] ?? false])
            );

            return areExpansionStatesEqual(prev, newState) ? prev : newState;
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

    const expandSidebarPath = useCallback((groupIds: string[], projectIds: string[] = []) => {
        setExpandedGroups((prev) => {
            const newState = { ...prev };
            groupIds.forEach((groupId) => {
                newState[groupId] = true;
            });
            return areExpansionStatesEqual(prev, newState) ? prev : newState;
        });
        setExpandedProjects((prev) => {
            const newState = { ...prev };
            projectIds.forEach((projectId) => {
                newState[projectId] = true;
            });
            return areExpansionStatesEqual(prev, newState) ? prev : newState;
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
                expandSidebarPath,
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
