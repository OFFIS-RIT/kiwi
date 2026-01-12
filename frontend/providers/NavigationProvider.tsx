"use client";

import type React from "react";

import { useLocalStorage } from "@/hooks/use-local-storage";
import { createContext, useContext } from "react";

/**
 * Context value type for the NavigationProvider.
 */
type NavigationContextType = {
  selectedGroup: { id: string; name: string } | null;
  selectedProject: { id: string; name: string } | null;
  showAllGroups: boolean;
  setSelectedGroup: (group: { id: string; name: string } | null) => void;
  setSelectedProject: (project: { id: string; name: string } | null) => void;
  setShowAllGroups: (show: boolean) => void;
  selectItem: (
    group: { id: string; name: string },
    project?: { id: string; name: string }
  ) => void;
  showGroups: () => void;
};

const NavigationContext = createContext<NavigationContextType | undefined>(
  undefined
);

/**
 * Internal state shape persisted to localStorage.
 */
type NavigationState = {
  selectedGroup: { id: string; name: string } | null;
  selectedProject: { id: string; name: string } | null;
  showAllGroups: boolean;
};

/**
 * Manages navigation state (selected group/project) with localStorage persistence.
 * Persists selections across page reloads and browser sessions.
 */
export function NavigationProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  // Use custom hook for localStorage persistence with proper SSR/hydration handling
  const [navigationState, setNavigationState] =
    useLocalStorage<NavigationState>("kiwi-navigation-state", {
      selectedGroup: null,
      selectedProject: null,
      showAllGroups: false,
    });

  const setSelectedGroup = (group: { id: string; name: string } | null) => {
    setNavigationState((prev) => ({ ...prev, selectedGroup: group }));
  };

  const setSelectedProject = (project: { id: string; name: string } | null) => {
    setNavigationState((prev) => ({ ...prev, selectedProject: project }));
  };

  const setShowAllGroups = (show: boolean) => {
    setNavigationState((prev) => ({ ...prev, showAllGroups: show }));
  };

  const selectItem = (
    group: { id: string; name: string },
    project?: { id: string; name: string }
  ) => {
    setNavigationState({
      selectedGroup: group,
      selectedProject: project || null,
      showAllGroups: false,
    });
  };

  const showGroups = () => {
    setNavigationState({
      selectedGroup: null,
      selectedProject: null,
      showAllGroups: true,
    });
  };

  return (
    <NavigationContext.Provider
      value={{
        selectedGroup: navigationState.selectedGroup,
        selectedProject: navigationState.selectedProject,
        showAllGroups: navigationState.showAllGroups,
        setSelectedGroup,
        setSelectedProject,
        setShowAllGroups,
        selectItem,
        showGroups,
      }}
    >
      {children}
    </NavigationContext.Provider>
  );
}

/**
 * Hook to access and modify navigation state.
 * Must be used within a NavigationProvider.
 *
 * @returns Navigation state and control functions
 * @throws Error if used outside of NavigationProvider
 */
export function useNavigation() {
  const context = useContext(NavigationContext);
  if (context === undefined) {
    throw new Error("useNavigation must be used within a NavigationProvider");
  }
  return context;
}
