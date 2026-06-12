"use client";

import { PromptEditor } from "@/components/settings/PromptEditor";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useManageablePromptGroups } from "@/hooks/use-prompt-access";
import { fetchPrompts, type PromptScope } from "@/lib/api";
import { useAppTranslations } from "@/lib/i18n/use-app-translations";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import { useApiClient } from "@/providers/ApiClientProvider";
import { useAuth } from "@/providers/AuthProvider";
import { useAuthClient } from "@/providers/AuthClientProvider";
import { pickDefaultOrganization } from "@kiwi/auth/organization";
import { useQueries } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useState } from "react";

type TreeNodeKind = "organization" | "group" | "project";

type TreeNode = {
    scope: PromptScope;
    scopeId: string;
    name: string;
    kind: TreeNodeKind;
    indented: boolean;
};

const NODE_BADGE_KEYS: Record<TreeNodeKind, string> = {
    organization: "prompts.badge.organization",
    group: "prompts.badge.group",
    project: "prompts.badge.project",
};

export function PromptsSection() {
    const t = useAppTranslations();
    const apiClient = useApiClient();
    const { isSystemAdmin } = useAuth();
    const authClient = useAuthClient();
    const { groups, isLoading: isLoadingGroups } = useManageablePromptGroups();
    // Chat injection always reads the deployment's default organization, so
    // the editor must target that one too — not the session's active
    // organization, which a system admin may have switched away from.
    const {
        data: organizations,
        isPending: isOrganizationsPending,
        error: organizationsError,
        refetch: refetchOrganizations,
    } = authClient.useListOrganizations();
    const { data: activeOrganization } = authClient.useActiveOrganization();
    const defaultOrganization = pickDefaultOrganization(organizations ?? []);
    const [selectedScopeId, setSelectedScopeId] = useState<string | null>(null);

    const organizationGroup = groups.find((group) => group.scope === "organization");
    const teamGroups = groups.filter((group) => group.scope === "team");

    const projectNode = (project: { id: string; name: string }): TreeNode => ({
        scope: { kind: "graph", graphId: project.id },
        scopeId: project.id,
        name: project.name,
        kind: "project",
        indented: true,
    });

    // The groups query is scoped to the session's active organization, while
    // the prompt editor targets the default organization. Only nest the
    // org-owned projects under the organization node when both are the same
    // organization, so a multi-org admin never sees org B's graphs grouped
    // under org A's prompt.
    const organizationProjects =
        activeOrganization?.id === defaultOrganization?.id ? (organizationGroup?.projects ?? []) : [];

    const organizationNodes: TreeNode[] =
        isSystemAdmin && defaultOrganization
            ? [
                  {
                      scope: { kind: "organization", organizationId: defaultOrganization.id },
                      scopeId: defaultOrganization.id,
                      name: t("prompts.organization"),
                      kind: "organization",
                      indented: false,
                  },
                  ...organizationProjects.map(projectNode),
              ]
            : [];

    const groupNodes: TreeNode[] = teamGroups.flatMap((group) => [
        {
            scope: { kind: "team", teamId: group.id },
            scopeId: group.id,
            name: group.name,
            kind: "group",
            indented: false,
        },
        ...group.projects.map(projectNode),
    ]);

    const nodes = [...organizationNodes, ...groupNodes];

    // One list query per scope powers the "prompt set" dots and warms the
    // cache the detail editor reads from (same query keys).
    const promptQueries = useQueries({
        queries: nodes.map((node) => ({
            queryKey: queryKeys.prompts(node.scope.kind, node.scopeId),
            queryFn: () => fetchPrompts(apiClient, node.scope),
        })),
    });

    const hasPrompt = (index: number) => (promptQueries[index]?.data?.[0]?.prompt.trim().length ?? 0) > 0;

    const selectedNode = nodes.find((node) => node.scopeId === selectedScopeId) ?? nodes[0] ?? null;
    const isLoading = isLoadingGroups || (isSystemAdmin && !defaultOrganization && isOrganizationsPending);
    // Without this, a failed organization fetch would render the tree without
    // the organization node and look like "no scopes" to a system admin.
    const hasOrganizationLoadError = isSystemAdmin && !defaultOrganization && organizationsError !== null;

    return (
        <section className="flex flex-col gap-6">
            <div>
                <h1 className="text-2xl font-bold">{t("settings.prompts.title")}</h1>
                <p className="text-sm text-muted-foreground">{t("settings.prompts.description")}</p>
            </div>

            {isLoading ? (
                <div className="flex items-center justify-center py-12">
                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
            ) : hasOrganizationLoadError ? (
                <div className="flex items-center gap-3 rounded-md bg-destructive/15 px-4 py-2 text-sm text-destructive">
                    <span className="flex-1">{t("prompts.load.error")}</span>
                    <Button variant="outline" size="sm" onClick={() => void refetchOrganizations()}>
                        {t("prompts.reload")}
                    </Button>
                </div>
            ) : !selectedNode ? (
                <p className="py-12 text-center text-sm text-muted-foreground">{t("settings.prompts.empty")}</p>
            ) : (
                <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
                    <nav className="flex flex-col gap-1 rounded-lg border p-2 lg:w-72 lg:shrink-0">
                        {nodes.map((node, index) => {
                            const isFirstGroupNode = node.scopeId === groupNodes[0]?.scopeId;

                            return (
                                <div key={node.scopeId} className="contents">
                                    {index === 0 && organizationNodes.length > 0 ? (
                                        <span className="px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                            {t("prompts.organization")}
                                        </span>
                                    ) : null}
                                    {isFirstGroupNode ? (
                                        <span className="px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                            {t("prompts.groups")}
                                        </span>
                                    ) : null}
                                    <button
                                        type="button"
                                        onClick={() => setSelectedScopeId(node.scopeId)}
                                        className={cn(
                                            "flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors",
                                            node.scopeId === selectedNode.scopeId
                                                ? "bg-muted font-medium"
                                                : "hover:bg-muted/50"
                                        )}
                                    >
                                        {node.indented ? <span className="w-3 shrink-0" /> : null}
                                        <span
                                            className={cn(
                                                "h-1.5 w-1.5 shrink-0 rounded-full",
                                                hasPrompt(index) ? "bg-success" : "bg-muted-foreground/30"
                                            )}
                                        />
                                        <span className="min-w-0 flex-1 truncate">{node.name}</span>
                                    </button>
                                </div>
                            );
                        })}
                    </nav>

                    <div className="min-w-0 flex-1 rounded-lg border p-5">
                        <div className="mb-4 flex items-center gap-2">
                            <h2 className="min-w-0 truncate text-lg font-semibold">{selectedNode.name}</h2>
                            <Badge variant="secondary" className="shrink-0">
                                {t(NODE_BADGE_KEYS[selectedNode.kind])}
                            </Badge>
                        </div>
                        {/* Keyed so the draft state resets when switching scopes. */}
                        <PromptEditor key={selectedNode.scopeId} scope={selectedNode.scope} />
                    </div>
                </div>
            )}
        </section>
    );
}
