import { describe, expect, test } from "bun:test";
import { deriveAuthMode, deriveAuthModeFromPresence, getLdapConfigState } from "./mode";

const ldapEnv = {
    LDAP_URL: "ldaps://ldap.example.com",
    LDAP_BIND_DN: "cn=readonly,dc=example,dc=com",
    LDAP_PASSW: "secret",
    LDAP_BASE_DN: "dc=example,dc=com",
    LDAP_SEARCH_ATTR: "uid",
};

describe("auth mode", () => {
    test("derives LDAP mode only when all LDAP env vars are present", () => {
        expect(deriveAuthMode(ldapEnv)).toBe("ldap");
        expect(deriveAuthMode({ ...ldapEnv, LDAP_PASSW: "" })).toBe("credentials");
    });

    test("ignores unrelated env values", () => {
        expect(deriveAuthMode({ ...ldapEnv, KIWI_AUTH_KIND: "credentials" })).toBe("ldap");
        expect(deriveAuthMode({ KIWI_AUTH_KIND: "ldap" })).toBe("credentials");
    });

    test("reports partial LDAP value config without exposing values", () => {
        expect(getLdapConfigState({ LDAP_URL: "ldaps://ldap.example.com", LDAP_PASSW: "   " })).toEqual({
            configured: false,
            partial: true,
            missingKeys: ["LDAP_BIND_DN", "LDAP_BASE_DN", "LDAP_SEARCH_ATTR"],
            blankKeys: ["LDAP_PASSW"],
        });
    });

    test("derives frontend mode from non-secret presence flags", () => {
        expect(
            deriveAuthModeFromPresence({
                LDAP_URL_CONFIGURED: "true",
                LDAP_BIND_DN_CONFIGURED: "true",
                LDAP_PASSW_CONFIGURED: "true",
                LDAP_BASE_DN_CONFIGURED: "true",
                LDAP_SEARCH_ATTR_CONFIGURED: "true",
            })
        ).toBe("ldap");
        expect(
            deriveAuthModeFromPresence({
                LDAP_URL_CONFIGURED: "true",
                LDAP_BIND_DN_CONFIGURED: "true",
                LDAP_PASSW_CONFIGURED: "false",
                LDAP_BASE_DN_CONFIGURED: "true",
                LDAP_SEARCH_ATTR_CONFIGURED: "true",
            })
        ).toBe("credentials");
    });
});
