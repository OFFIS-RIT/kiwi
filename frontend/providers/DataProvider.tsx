"use client";

import type React from "react";

import { useCreateGroup, useGroupsWithProjects } from "@/hooks/use-data";
import { useLanguage } from "@/providers/LanguageProvider";
import type { Group } from "@/types";
import { createContext, useContext } from "react";

/**
 * Context value type for the DataProvider.
 */
type DataContextType = {
  groups: Group[];
  isLoading: boolean;
  error: string | null;
  addGroup: (name: string) => Promise<void>;
  refreshData: () => Promise<void>;
};

const DataContext = createContext<DataContextType | undefined>(undefined);

/**
 * Provides centralized data access for groups and projects.
 * Wraps TanStack Query hooks to expose a simpler API for components.
 */
export function DataProvider({ children }: { children: React.ReactNode }) {
  const { t } = useLanguage();
  // Use TanStack Query hook for fetching groups with projects
  const {
    data: groups = [],
    isLoading,
    error: queryError,
    refetch,
  } = useGroupsWithProjects();

  // Use mutation hook for creating groups
  const createGroupMutation = useCreateGroup();

  // Convert query error to string
  const error = queryError ? t("error.loading.data") : null;

  const addGroup = async (name: string) => {
    try {
      await createGroupMutation.mutateAsync(name);
      // TanStack Query will automatically refetch the data via invalidation
    } catch (err) {
      console.error("Error creating group:", err);
      throw err;
    }
  };

  const refreshData = async () => {
    await refetch();
  };

  return (
    <DataContext.Provider
      value={{ groups, isLoading, error, addGroup, refreshData }}
    >
      {children}
    </DataContext.Provider>
  );
}

/**
 * Hook to access group data and operations.
 * Must be used within a DataProvider.
 *
 * @returns Object containing groups, loading state, error, and mutation functions
 * @throws Error if used outside of DataProvider
 */
export function useData() {
  const context = useContext(DataContext);
  if (context === undefined) {
    throw new Error("useData must be used within a DataProvider");
  }
  return context;
}
