"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";

import { DEFAULT_SETTINGS_SECTION } from "@/components/settings/sections";

type SettingsContextType = {
    activeSection: string;
    setActiveSection: (sectionId: string) => void;
};

const SettingsContext = createContext<SettingsContextType | undefined>(undefined);

const SECTION_PARAM = "section";

export function SettingsProvider({ children }: { children: ReactNode }) {
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const activeSection = searchParams.get(SECTION_PARAM) ?? DEFAULT_SETTINGS_SECTION;

    const setActiveSection = useCallback(
        (sectionId: string) => {
            const params = new URLSearchParams(searchParams.toString());
            params.set(SECTION_PARAM, sectionId);
            router.replace(`${pathname}?${params.toString()}`, { scroll: false });
        },
        [router, pathname, searchParams]
    );

    const value = useMemo<SettingsContextType>(
        () => ({ activeSection, setActiveSection }),
        [activeSection, setActiveSection]
    );

    return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings() {
    const context = useContext(SettingsContext);
    if (context === undefined) {
        throw new Error("useSettings must be used within a SettingsProvider");
    }
    return context;
}
