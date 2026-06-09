import { describe, expect, test } from "vitest";

import {
    DEFAULT_SETTINGS_SECTION,
    getVisibleSettingsCategories,
    resolveActiveSettingsSection,
} from "./sections";

const sectionIds = (categories: ReturnType<typeof getVisibleSettingsCategories>) =>
    categories.flatMap((category) => category.sections.map((section) => section.id));

describe("settings section visibility", () => {
    test("regular user in credentials mode sees General Sections incl. Account, but no System Admin", () => {
        const categories = getVisibleSettingsCategories({ isSystemAdmin: false, authMode: "credentials" });

        expect(categories.map((category) => category.id)).toEqual(["general"]);
        expect(sectionIds(categories)).toEqual(["account", "appearance", "api-keys", "archived-chats"]);
    });

    test("Account Section is hidden in LDAP mode", () => {
        const categories = getVisibleSettingsCategories({ isSystemAdmin: false, authMode: "ldap" });

        expect(sectionIds(categories)).not.toContain("account");
        expect(sectionIds(categories)).toEqual(["appearance", "api-keys", "archived-chats"]);
    });

    test("system admin additionally sees the System Admin Category with User Management", () => {
        const categories = getVisibleSettingsCategories({ isSystemAdmin: true, authMode: "credentials" });

        expect(categories.map((category) => category.id)).toEqual(["general", "system-admin"]);
        expect(sectionIds(categories)).toContain("user-management");
    });

    test("system-admin Category never appears for non-system-admins", () => {
        const categories = getVisibleSettingsCategories({ isSystemAdmin: false, authMode: "ldap" });

        expect(categories.map((category) => category.id)).not.toContain("system-admin");
    });
});

describe("active section resolution", () => {
    const credentialsContext = { isSystemAdmin: false, authMode: "credentials" as const };

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
});
