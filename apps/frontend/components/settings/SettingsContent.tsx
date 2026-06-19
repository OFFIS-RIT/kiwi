"use client";

import { useCanManagePrompts } from "@/hooks/use-prompt-access";
import { useCanManageSuggestions } from "@/hooks/use-suggestion-access";
import { useRuntimeConfig } from "@/providers/RuntimeConfigProvider";
import { useAuth } from "@/providers/AuthProvider";
import { useSettings } from "@/providers/SettingsProvider";
import { Loader2 } from "lucide-react";

import { resolveActiveSettingsSection } from "./sections";

export function SettingsContent() {
    const { isAdmin, isSystemAdmin, isPending: isAuthPending } = useAuth();
    const { authMode } = useRuntimeConfig();
    const { activeSection } = useSettings();
    const { canManageSuggestions, isLoading: isSuggestionAccessLoading } = useCanManageSuggestions();
    const { canManagePrompts, isLoading: isPromptAccessLoading } = useCanManagePrompts();

    // Some admin Sections depend on async role/group queries; until they
    // resolve, a deep link would briefly render the fallback Section.
    if (
        (isAuthPending && activeSection === "system-configuration") ||
        (isSuggestionAccessLoading && activeSection === "suggestions") ||
        (isPromptAccessLoading && activeSection === "prompts")
    ) {
        return (
            <div className="flex h-full items-center justify-center">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
        );
    }

    const section = resolveActiveSettingsSection(activeSection, {
        isAdmin,
        isSystemAdmin,
        canManageSuggestions,
        canManagePrompts,
        authMode,
    });
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
