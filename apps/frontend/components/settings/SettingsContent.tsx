"use client";

import { useRuntimeConfig } from "@/providers/RuntimeConfigProvider";
import { useAuth } from "@/providers/AuthProvider";
import { useSettings } from "@/providers/SettingsProvider";

import { resolveActiveSettingsSection } from "./sections";

export function SettingsContent() {
    const { isSystemAdmin } = useAuth();
    const { authMode } = useRuntimeConfig();
    const { activeSection } = useSettings();

    const section = resolveActiveSettingsSection(activeSection, { isSystemAdmin, authMode });
    if (!section) {
        return null;
    }

    const SectionComponent = section.Component;

    return (
        <div className="h-full overflow-y-auto">
            <div className="mx-auto flex w-full max-w-5xl flex-col gap-8">
                <SectionComponent />
            </div>
        </div>
    );
}
