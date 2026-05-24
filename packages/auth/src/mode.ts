export type AuthMode = "credentials" | "ldap";

const ldapEnvKeys = ["LDAP_URL", "LDAP_BIND_DN", "LDAP_PASSW", "LDAP_BASE_DN", "LDAP_SEARCH_ATTR"] as const;
const ldapPresenceEnvKeys = [
    "LDAP_URL_CONFIGURED",
    "LDAP_BIND_DN_CONFIGURED",
    "LDAP_PASSW_CONFIGURED",
    "LDAP_BASE_DN_CONFIGURED",
    "LDAP_SEARCH_ATTR_CONFIGURED",
] as const;

type AuthModeEnv = Record<string, string | undefined>;

export type LdapConfigState = {
    configured: boolean;
    partial: boolean;
    missingKeys: string[];
    blankKeys: string[];
};

function isTruthy(value: string | undefined) {
    return ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");
}

export function getLdapConfigState(env: AuthModeEnv): LdapConfigState {
    const missingKeys: string[] = [];
    const blankKeys: string[] = [];
    let presentKeys = 0;

    for (const key of ldapEnvKeys) {
        const value = env[key];
        if (value === undefined) {
            missingKeys.push(key);
            continue;
        }

        if (!value.trim()) {
            blankKeys.push(key);
            continue;
        }

        presentKeys += 1;
    }

    const configured = missingKeys.length === 0 && blankKeys.length === 0;

    return {
        configured,
        partial: !configured && (presentKeys > 0 || blankKeys.length > 0),
        missingKeys,
        blankKeys,
    };
}

export function deriveAuthMode(env: AuthModeEnv): AuthMode {
    return getLdapConfigState(env).configured ? "ldap" : "credentials";
}

export function deriveAuthModeFromPresence(env: AuthModeEnv): AuthMode {
    return ldapPresenceEnvKeys.every((key) => isTruthy(env[key])) ? "ldap" : "credentials";
}
