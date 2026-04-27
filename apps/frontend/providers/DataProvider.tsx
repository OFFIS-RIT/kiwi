"use client";

import type React from "react";

import { useCreateGroup, useGroupsWithProjects } from "@/hooks/use-data";
import { useLanguage } from "@/providers/LanguageProvider";
import type { Group } from "@/types";
import { createContext, useContext } from "react";

type DataContextType = {
    groups: Group[];
    isLoading: boolean;
    error: string | null;
    dataUpdatedAt: number;
    addGroup: (name: string) => Promise<void>;
    refreshData: () => Promise<void>;
};

const DataContext = createContext<DataContextType | undefined>(undefined);

type DataProviderProps = {
    initialGroups: Group[];
    children: React.ReactNode;
};

export function DataProvider({ initialGroups, children }: DataProviderProps) {
    const { t } = useLanguage();
    const { data: groups = [], isLoading, error: queryError, refetch, dataUpdatedAt } = useGroupsWithProjects(initialGroups);

    const createGroupMutation = useCreateGroup();

    const error = queryError ? t("error.loading.data") : null;

    const addGroup = async (name: string) => {
        try {
            await createGroupMutation.mutateAsync(name);
        } catch (err) {
            console.error("Error creating group:", err);
            throw err;
        }
    };

    const refreshData = async () => {
        await refetch();
    };

    return (
        <DataContext.Provider value={{ groups, isLoading, error, dataUpdatedAt, addGroup, refreshData }}>
            {children}
        </DataContext.Provider>
    );
}

export function useData() {
    const context = useContext(DataContext);
    if (context === undefined) {
        throw new Error("useData must be used within a DataProvider");
    }
    return context;
}
