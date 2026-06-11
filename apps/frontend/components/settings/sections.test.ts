import { describe, expect, test } from "vitest";

import {
    DEFAULT_SETTINGS_SECTION,
    getAdminOnlySectionIds,
    getVisibleSettingsCategories,
    resolveActiveSettingsSection,
} from "./sections";

const sectionIds = (categories: ReturnType<typeof getVisibleSettingsCategories>) =>
    categories.flatMap((category) => category.sections.map((section) => section.id));

describe("settings section visibility", () => {
    test("regular user in credentials mode sees General Sections incl. Account, but no System Admin", () => {
        const categories = getVisibleSettingsCategories({
            isSystemAdmin: false,
            canManageSuggestions: false,
            canManagePrompts: false,
            authMode: "credentials",
        });

        expect(categories.map((category) => category.id)).toEqual(["general"]);
        expect(sectionIds(categories)).toEqual([
            "account",
            "appearance",
            "personalization",
            "api-keys",
            "archived-chats",
        ]);
    });

    test("Account Section is hidden in LDAP mode", () => {
        const categories = getVisibleSettingsCategories({
            isSystemAdmin: false,
            canManageSuggestions: false,
            canManagePrompts: false,
            authMode: "ldap",
        });

        expect(sectionIds(categories)).not.toContain("account");
        expect(sectionIds(categories)).toEqual(["appearance", "personalization", "api-keys", "archived-chats"]);
    });

    test("system admin additionally sees the System Admin Category with User Management", () => {
        const categories = getVisibleSettingsCategories({
            isSystemAdmin: true,
            canManageSuggestions: false,
            canManagePrompts: false,
            authMode: "credentials",
        });

        expect(categories.map((category) => category.id)).toEqual(["general", "system-admin"]);
        expect(sectionIds(categories)).toContain("user-management");
        expect(sectionIds(categories)).toContain("ai-models");
    });

    test("system-admin Category never appears for non-system-admins", () => {
        const categories = getVisibleSettingsCategories({
            isSystemAdmin: false,
            canManageSuggestions: false,
            canManagePrompts: false,
            authMode: "ldap",
        });

        expect(categories.map((category) => category.id)).not.toContain("system-admin");
    });

    test("suggestion managers see the Administration Category with Suggestions", () => {
        const categories = getVisibleSettingsCategories({
            isSystemAdmin: false,
            canManageSuggestions: true,
            canManagePrompts: false,
            authMode: "credentials",
        });

        expect(categories.map((category) => category.id)).toEqual(["general", "administration"]);
        expect(sectionIds(categories)).toContain("suggestions");
        expect(sectionIds(categories)).not.toContain("prompts");
    });

    test("prompt managers see the Administration Category with Prompts", () => {
        const categories = getVisibleSettingsCategories({
            isSystemAdmin: false,
            canManageSuggestions: false,
            canManagePrompts: true,
            authMode: "credentials",
        });

        expect(categories.map((category) => category.id)).toEqual(["general", "administration"]);
        expect(sectionIds(categories)).toContain("prompts");
        expect(sectionIds(categories)).not.toContain("suggestions");
    });

    test("Administration Category is hidden without suggestion or prompt rights, even for system admins", () => {
        const categories = getVisibleSettingsCategories({
            isSystemAdmin: true,
            canManageSuggestions: false,
            canManagePrompts: false,
            authMode: "credentials",
        });

        expect(categories.map((category) => category.id)).not.toContain("administration");
    });
});

describe("admin-only section derivation", () => {
    test("derives admin-only Section ids from the registry predicates", () => {
        expect(getAdminOnlySectionIds()).toEqual(["user-management", "ai-models"]);
    });

    test("does not classify auth-mode-gated Sections (e.g. Account) as admin-only", () => {
        expect(getAdminOnlySectionIds()).not.toContain("account");
    });

    test("does not classify the Suggestions Section as admin-only", () => {
        // Team moderators may manage suggestions without being system admins,
        // so the server-side system-admin guard must not cover this Section.
        expect(getAdminOnlySectionIds()).not.toContain("suggestions");
    });

    test("does not classify the Prompts Section as admin-only", () => {
        // Team admins may manage prompts without being system admins, so the
        // server-side system-admin guard must not cover this Section.
        expect(getAdminOnlySectionIds()).not.toContain("prompts");
    });
});

describe("active section resolution", () => {
    const credentialsContext = {
        isSystemAdmin: false,
        canManageSuggestions: false,
        canManagePrompts: false,
        authMode: "credentials" as const,
    };

    test("resolves a valid, visible section by id", () => {
        expect(resolveActiveSettingsSection("api-keys", credentialsContext)?.id).toBe("api-keys");
    });

    test("falls back to the default section for an unknown id", () => {
        expect(resolveActiveSettingsSection("does-not-exist", credentialsContext)?.id).toBe(DEFAULT_SETTINGS_SECTION);
    });

    test("falls back to the default when the requested section is not visible to this user", () => {
        // user-management is hidden for non-system-admins
        expect(resolveActiveSettingsSection("user-management", credentialsContext)?.id).toBe(DEFAULT_SETTINGS_SECTION);
    });

    test("falls back to the default when Suggestions is requested without management rights", () => {
        expect(resolveActiveSettingsSection("suggestions", credentialsContext)?.id).toBe(DEFAULT_SETTINGS_SECTION);
    });

    test("falls back to the default when Prompts is requested without management rights", () => {
        expect(resolveActiveSettingsSection("prompts", credentialsContext)?.id).toBe(DEFAULT_SETTINGS_SECTION);
    });

    test("resolves Suggestions for users with management rights", () => {
        const context = { ...credentialsContext, canManageSuggestions: true };

        expect(resolveActiveSettingsSection("suggestions", context)?.id).toBe("suggestions");
    });

    test("resolves Prompts for users with management rights", () => {
        const context = { ...credentialsContext, canManagePrompts: true };

        expect(resolveActiveSettingsSection("prompts", context)?.id).toBe("prompts");
    });
});
