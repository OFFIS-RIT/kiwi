export const DEFAULT_ORGANIZATION_SLUG = "default-org";

type OrganizationLike = {
    id: string;
    slug?: string | null;
    createdAt: Date | string;
};

/**
 * Picks the deployment's default organization from a list — the organization
 * with the default slug, otherwise the oldest one. Mirrors the server-side
 * `loadDefaultOrganizationId` query (see server.ts) so clients that need to
 * address the same organization the server resolves (e.g. for organization
 * prompts) cannot drift from it.
 */
export function pickDefaultOrganization<T extends OrganizationLike>(organizations: T[]): T | null {
    const bySlug = organizations.find((organization) => organization.slug === DEFAULT_ORGANIZATION_SLUG);
    if (bySlug) {
        return bySlug;
    }

    return (
        [...organizations].sort(
            (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
        )[0] ?? null
    );
}
