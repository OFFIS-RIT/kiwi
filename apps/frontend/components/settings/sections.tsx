import type { AuthMode } from "@kiwi/auth/mode";
import { Archive, KeyRound, Lightbulb, Palette, ScrollText, SlidersHorizontal, Users, UserCircle } from "lucide-react";
import type { ComponentType } from "react";
import type { LucideIcon } from "lucide-react";

import { AccountSection } from "./sections/AccountSection";
import { ApiKeysSection } from "./sections/ApiKeysSection";
import { AppearanceSection } from "./sections/AppearanceSection";
import { ArchivedChatsSection } from "./sections/ArchivedChatsSection";
import { PersonalizationSection } from "./sections/PersonalizationSection";
import { PromptsSection } from "./sections/PromptsSection";
import { SuggestionsSection } from "./sections/SuggestionsSection";
import { UserManagementSection } from "./sections/UserManagementSection";

export type SettingsVisibilityContext = {
    isSystemAdmin: boolean;
    canManageSuggestions: boolean;
    canManagePrompts: boolean;
    authMode: AuthMode;
};

export type SettingsSectionDef = {
    id: string;
    labelKey: string;
    icon: LucideIcon;
    Component: ComponentType;
    isVisible?: (context: SettingsVisibilityContext) => boolean;
};

export type SettingsCategoryDef = {
    id: string;
    labelKey: string;
    sections: SettingsSectionDef[];
};

export const DEFAULT_SETTINGS_SECTION = "appearance";

export const settingsCategories: SettingsCategoryDef[] = [
    {
        id: "general",
        labelKey: "settings.category.general",
        sections: [
            {
                id: "account",
                labelKey: "settings.section.account",
                icon: UserCircle,
                Component: AccountSection,
                isVisible: (context) => context.authMode === "credentials",
            },
            {
                id: "appearance",
                labelKey: "appearance",
                icon: Palette,
                Component: AppearanceSection,
            },
            {
                id: "personalization",
                labelKey: "settings.personalization.title",
                icon: SlidersHorizontal,
                Component: PersonalizationSection,
            },
            {
                id: "api-keys",
                labelKey: "apiKey.management",
                icon: KeyRound,
                Component: ApiKeysSection,
            },
            {
                id: "archived-chats",
                labelKey: "settings.archived.title",
                icon: Archive,
                Component: ArchivedChatsSection,
            },
        ],
    },
    {
        id: "administration",
        labelKey: "settings.category.administration",
        sections: [
            {
                id: "suggestions",
                labelKey: "settings.suggestions.title",
                icon: Lightbulb,
                Component: SuggestionsSection,
                isVisible: (context) => context.canManageSuggestions,
            },
            {
                id: "prompts",
                labelKey: "settings.prompts.title",
                icon: ScrollText,
                Component: PromptsSection,
                isVisible: (context) => context.canManagePrompts,
            },
        ],
    },
    {
        id: "system-admin",
        labelKey: "settings.category.systemAdmin",
        sections: [
            {
                id: "user-management",
                labelKey: "admin.user.management",
                icon: Users,
                Component: UserManagementSection,
                isVisible: (context) => context.isSystemAdmin,
            },
        ],
    },
];

function isSectionVisible(section: SettingsSectionDef, context: SettingsVisibilityContext) {
    return section.isVisible ? section.isVisible(context) : true;
}

export function getVisibleSettingsCategories(context: SettingsVisibilityContext): SettingsCategoryDef[] {
    return settingsCategories
        .map((category) => ({
            ...category,
            sections: category.sections.filter((section) => isSectionVisible(section, context)),
        }))
        .filter((category) => category.sections.length > 0);
}

const ALL_AUTH_MODES: AuthMode[] = ["credentials", "ldap"];

function enumerateContexts(isSystemAdmin: boolean): SettingsVisibilityContext[] {
    return ALL_AUTH_MODES.flatMap((authMode) =>
        [false, true].flatMap((canManageSuggestions) =>
            [false, true].map((canManagePrompts) => ({
                isSystemAdmin,
                canManageSuggestions,
                canManagePrompts,
                authMode,
            }))
        )
    );
}

/**
 * Derives which Section ids require system-admin rights directly from the
 * registry's visibility predicates, so server-side guards never drift from this
 * single source of truth. A Section is admin-only when some context shows it
 * to a system admin but no context shows it to a non-admin.
 */
export function getAdminOnlySectionIds(): string[] {
    return settingsCategories
        .flatMap((category) => category.sections)
        .filter((section) => {
            const predicate = section.isVisible;
            if (!predicate) {
                return false;
            }
            const visibleToAdmin = enumerateContexts(true).some(predicate);
            const visibleToNonAdmin = enumerateContexts(false).some(predicate);
            return visibleToAdmin && !visibleToNonAdmin;
        })
        .map((section) => section.id);
}

export function resolveActiveSettingsSection(
    activeId: string,
    context: SettingsVisibilityContext
): SettingsSectionDef | null {
    const visibleSections = getVisibleSettingsCategories(context).flatMap((category) => category.sections);
    return (
        visibleSections.find((section) => section.id === activeId) ??
        visibleSections.find((section) => section.id === DEFAULT_SETTINGS_SECTION) ??
        visibleSections[0] ??
        null
    );
}
