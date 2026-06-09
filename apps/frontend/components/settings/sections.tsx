import type { AuthMode } from "@kiwi/auth/mode";
import { Archive, KeyRound, Palette, Users, UserCircle } from "lucide-react";
import type { ComponentType } from "react";
import type { LucideIcon } from "lucide-react";

import { AccountSection } from "./sections/AccountSection";
import { ApiKeysSection } from "./sections/ApiKeysSection";
import { AppearanceSection } from "./sections/AppearanceSection";
import { ArchivedChatsSection } from "./sections/ArchivedChatsSection";
import { UserManagementSection } from "./sections/UserManagementSection";

export type SettingsVisibilityContext = {
    isSystemAdmin: boolean;
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
