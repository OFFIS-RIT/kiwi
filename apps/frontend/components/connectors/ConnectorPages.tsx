"use client";

import {
    completeGitHubConnectorInstallation,
    completeGitHubConnectorManifest,
    createGitLabConnector,
    createRepositoryGraph,
    fetchConnectorBranches,
    fetchConnectorInstallations,
    fetchConnectorRepositories,
    fetchConnectors,
    startConnectorConnect,
    startGitHubConnectorManifest,
    type ConnectorBranchRecord,
    type ConnectorInstallationRecord,
    type ConnectorRepositoryRecord,
} from "@/lib/api";
import { ORGANIZATION_GROUP_ID } from "@/lib/api/projects";
import { useGroupsWithProjects } from "@/hooks/use-data";
import { useApiClient } from "@/providers/ApiClientProvider";
import { useAuth } from "@/providers/AuthProvider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Loader2, Plug, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";

const connectorQueryKeys = {
    connectors: ["connectors"] as const,
    installations: (connectorId: string) => ["connectors", connectorId, "installations"] as const,
    repositories: (connectorId: string, installationId: string) =>
        ["connectors", connectorId, "installations", installationId, "repositories"] as const,
    branches: (connectorId: string, installationId: string, repositoryId: string) =>
        ["connectors", connectorId, "installations", installationId, "repositories", repositoryId, "branches"] as const,
};

const EMPTY_INSTALLATIONS: ConnectorInstallationRecord[] = [];
const EMPTY_REPOSITORIES: ConnectorRepositoryRecord[] = [];
const EMPTY_BRANCHES: ConnectorBranchRecord[] = [];


export function ConnectorListPage() {
    const apiClient = useApiClient();
    const { isAdmin, isSystemAdmin } = useAuth();
    const { data: groups = [] } = useGroupsWithProjects();
    const canManageGraphs =
        isAdmin || groups.some((group) => group.scope === "organization" || group.role === "admin" || group.role === "moderator");
    const { data: connectors = [], isLoading, error } = useQuery({
        queryKey: connectorQueryKeys.connectors,
        queryFn: () => fetchConnectors(apiClient),
    });

    return (
        <div className="h-full overflow-y-auto">
            <div className="space-y-6">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                        <h1 className="text-2xl font-bold">Repository connectors</h1>
                        <p className="text-muted-foreground">
                            Connect provider apps to create private repository graphs and keep them synced.
                        </p>
                    </div>
                    {isSystemAdmin ? (
                        <div className="flex gap-2">
                            <Button asChild variant="outline">
                                <Link href="/connectors/gitlab/new">New GitLab connector</Link>
                            </Button>
                            <Button asChild>
                                <Link href="/connectors/github/new">New GitHub connector</Link>
                            </Button>
                        </div>
                    ) : null}
                </div>

                {error ? (
                    <Card>
                        <CardHeader>
                            <CardTitle>Unable to load connectors</CardTitle>
                            <CardDescription>Please try again later.</CardDescription>
                        </CardHeader>
                    </Card>
                ) : null}

                {isLoading ? (
                    <Card>
                        <CardContent className="flex items-center gap-2 text-sm text-muted-foreground">
                            <Loader2 className="size-4 animate-spin" /> Loading connectors…
                        </CardContent>
                    </Card>
                ) : null}

                {!isLoading && connectors.length === 0 ? (
                    <Card>
                        <CardHeader>
                            <CardTitle>No connectors configured</CardTitle>
                            <CardDescription>
                                {isSystemAdmin
                                    ? "Create a GitHub or GitLab connector before managers can add repository graphs."
                                    : "Ask a system administrator to configure a repository connector."}
                            </CardDescription>
                        </CardHeader>
                    </Card>
                ) : null}

                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                    {connectors.map((connector) => (
                        <Card key={connector.id}>
                            <CardHeader>
                                <CardTitle className="flex items-center gap-2">
                                    <Plug className="size-5" /> {connector.name}
                                </CardTitle>
                                <CardDescription>{connector.provider === "github" ? "GitHub" : "GitLab"} connector</CardDescription>
                            </CardHeader>
                            <CardContent className="space-y-4">
                                <div className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
                                    <span>
                                        Slug: <span className="font-mono text-foreground">{connector.slug}</span>
                                    </span>
                                    <Badge variant={connector.status === "active" ? "default" : "secondary"}>
                                        {connector.status}
                                    </Badge>
                                </div>
                                <div className="flex gap-2">
                                    {canManageGraphs && connector.status === "active" ? (
                                        <Button asChild>
                                            <Link href={`/connectors/${connector.id}/connect`}>Connect repository</Link>
                                        </Button>
                                    ) : null}
                                    {isSystemAdmin ? (
                                        <Button asChild variant="outline">
                                            <Link href={`/connectors/${connector.id}/connect`}>Inspect</Link>
                                        </Button>
                                    ) : null}
                                </div>
                            </CardContent>
                        </Card>
                    ))}
                </div>
            </div>
        </div>
    );
}

export function GitHubConnectorNewPage() {
    const apiClient = useApiClient();
    const [name, setName] = useState("KIWI GitHub Connector");
    const manifestMutation = useMutation({
        mutationFn: () => startGitHubConnectorManifest(apiClient, { name: name.trim() }),
        onSuccess: ({ manifestUrl }) => {
            window.location.assign(manifestUrl);
        },
        onError: () => toast.error("Unable to start GitHub manifest flow."),
    });
    const disabled = manifestMutation.isPending || name.trim().length === 0;

    return (
        <div className="max-w-3xl space-y-6">
            <div>
                <h1 className="text-2xl font-bold">Create GitHub connector</h1>
                <p className="text-muted-foreground">
                    Start a GitHub App manifest flow for this KIWI instance. GitHub will return the app credentials to KIWI.
                </p>
            </div>
            <Card>
                <CardHeader>
                    <CardTitle>Required permissions</CardTitle>
                    <CardDescription>The generated app requests only read access and push events.</CardDescription>
                </CardHeader>
                <CardContent>
                    <ul className="list-disc space-y-2 pl-5 text-sm">
                        <li>Contents: read, so KIWI can ingest repository files.</li>
                        <li>Metadata: read, so KIWI can list repositories and branches.</li>
                        <li>Push webhook, so KIWI can enqueue a sync when the selected branch changes.</li>
                    </ul>
                </CardContent>
            </Card>
            <Card>
                <CardHeader>
                    <CardTitle>Manifest starter</CardTitle>
                    <CardDescription>Name the connector before continuing to GitHub.</CardDescription>
                </CardHeader>
                <CardContent>
                    <form
                        className="space-y-4"
                        onSubmit={(event) => {
                            event.preventDefault();
                            if (!disabled) manifestMutation.mutate();
                        }}
                    >
                        <div className="space-y-2">
                            <Label htmlFor="github-connector-name">Connector name</Label>
                            <Input
                                id="github-connector-name"
                                value={name}
                                onChange={(event) => setName(event.target.value)}
                                autoComplete="off"
                            />
                        </div>
                        <Button type="submit" disabled={disabled}>
                            {manifestMutation.isPending ? <Loader2 className="size-4 animate-spin" /> : <ExternalLink />}
                            Continue to GitHub
                        </Button>
                    </form>
                </CardContent>
            </Card>
        </div>
    );
}

type GitHubConnectorCallbackPageProps = {
    code: string;
    state: string;
};

export function GitHubConnectorCallbackPage({ code, state }: GitHubConnectorCallbackPageProps) {
    const apiClient = useApiClient();
    const router = useRouter();
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!code || !state) {
            setError("Missing GitHub manifest callback parameters.");
            return;
        }

        let cancelled = false;
        void completeGitHubConnectorManifest(apiClient, { code, state })
            .then((connector) => {
                if (cancelled) return;
                router.replace(`/connectors/${connector.id}/connect`);
            })
            .catch(() => {
                if (cancelled) return;
                setError("Unable to finish GitHub connector creation.");
                toast.error("Unable to finish GitHub connector creation.");
            });

        return () => {
            cancelled = true;
        };
    }, [apiClient, code, router, state]);

    return (
        <Card>
            <CardHeader>
                <CardTitle>Finishing GitHub connector setup</CardTitle>
                <CardDescription>
                    {error ?? "KIWI is exchanging the GitHub manifest callback and preparing the connector."}
                </CardDescription>
            </CardHeader>
            {!error ? (
                <CardContent className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" /> Redirecting…
                </CardContent>
            ) : null}
        </Card>
    );
}

type GitHubConnectorInstallCallbackPageProps = {
    installationId: string;
    setupAction: string;
    state: string;
};

export function GitHubConnectorInstallCallbackPage({
    installationId,
    setupAction,
    state,
}: GitHubConnectorInstallCallbackPageProps) {
    const apiClient = useApiClient();
    const router = useRouter();
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!installationId || !state) {
            setError("Missing GitHub installation callback parameters.");
            return;
        }

        let cancelled = false;
        void completeGitHubConnectorInstallation(apiClient, {
            installation_id: installationId,
            setup_action: setupAction || undefined,
            state,
        })
            .then((installation) => {
                if (cancelled) return;
                router.replace(`/connectors/${installation.connectorId}/connect`);
            })
            .catch(() => {
                if (cancelled) return;
                setError("Unable to finish the GitHub installation flow.");
                toast.error("Unable to finish the GitHub installation flow.");
            });

        return () => {
            cancelled = true;
        };
    }, [apiClient, installationId, router, setupAction, state]);

    return (
        <Card>
            <CardHeader>
                <CardTitle>Finishing GitHub installation</CardTitle>
                <CardDescription>
                    {error ?? "KIWI is storing the GitHub installation before returning you to connector setup."}
                </CardDescription>
            </CardHeader>
            {!error ? (
                <CardContent className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" /> Redirecting…
                </CardContent>
            ) : null}
        </Card>
    );
}

export function GitLabConnectorNewPage() {
    const apiClient = useApiClient();
    const queryClient = useQueryClient();
    const [name, setName] = useState("KIWI GitLab Connector");
    const [baseUrl, setBaseUrl] = useState("https://gitlab.com");
    const [clientId, setClientId] = useState("");
    const [clientSecret, setClientSecret] = useState("");
    const [webhookSecret, setWebhookSecret] = useState("");

    const createMutation = useMutation({
        mutationFn: () =>
            createGitLabConnector(apiClient, {
                name: name.trim(),
                baseUrl: baseUrl.trim(),
                clientId: clientId.trim(),
                clientSecret,
                webhookSecret,
            }),
        onSuccess: () => {
            setClientSecret("");
            setWebhookSecret("");
            queryClient.invalidateQueries({ queryKey: connectorQueryKeys.connectors });
            toast.success("GitLab connector saved in disabled state until OAuth install flow is available.");
            window.location.assign("/connectors");
        },
        onError: () => toast.error("Unable to save GitLab connector."),
    });
    const disabled =
        createMutation.isPending ||
        name.trim().length === 0 ||
        baseUrl.trim().length === 0 ||
        clientId.trim().length === 0 ||
        clientSecret.length === 0 ||
        webhookSecret.length === 0;

    return (
        <div className="max-w-3xl space-y-6">
            <div>
                <h1 className="text-2xl font-bold">Create GitLab connector</h1>
                <p className="text-muted-foreground">
                    Register a GitLab application manually, then store its credentials encrypted in KIWI.
                </p>
            </div>
            <Card>
                <CardHeader>
                    <CardTitle>Required GitLab access</CardTitle>
                    <CardDescription>Use the narrowest application scopes that allow repository reads and push hooks.</CardDescription>
                </CardHeader>
                <CardContent>
                    <ul className="list-disc space-y-2 pl-5 text-sm">
                        <li>Read repository access for file ingestion.</li>
                        <li>API access only when needed to list projects, branches, or configure push webhooks.</li>
                        <li>A push webhook token that KIWI can verify without exposing it back to the browser.</li>
                    </ul>
                </CardContent>
            </Card>
            <Card>
                <CardHeader>
                    <CardTitle>Connector settings</CardTitle>
                    <CardDescription>Secrets are submitted once and cleared from the form after saving.</CardDescription>
                </CardHeader>
                <CardContent>
                    <form
                        className="space-y-4"
                        onSubmit={(event) => {
                            event.preventDefault();
                            if (!disabled) createMutation.mutate();
                        }}
                    >
                        <div className="grid gap-4 sm:grid-cols-2">
                            <div className="space-y-2">
                                <Label htmlFor="gitlab-name">Connector name</Label>
                                <Input id="gitlab-name" value={name} onChange={(event) => setName(event.target.value)} />
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="gitlab-base-url">Base URL</Label>
                                <Input
                                    id="gitlab-base-url"
                                    value={baseUrl}
                                    onChange={(event) => setBaseUrl(event.target.value)}
                                    placeholder="https://gitlab.com"
                                />
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="gitlab-client-id">Application client ID</Label>
                                <Input
                                    id="gitlab-client-id"
                                    value={clientId}
                                    onChange={(event) => setClientId(event.target.value)}
                                    autoComplete="off"
                                />
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="gitlab-client-secret">Application client secret</Label>
                                <Input
                                    id="gitlab-client-secret"
                                    value={clientSecret}
                                    onChange={(event) => setClientSecret(event.target.value)}
                                    type="password"
                                    autoComplete="new-password"
                                />
                            </div>
                            <div className="space-y-2 sm:col-span-2">
                                <Label htmlFor="gitlab-webhook-secret">Webhook token</Label>
                                <Input
                                    id="gitlab-webhook-secret"
                                    value={webhookSecret}
                                    onChange={(event) => setWebhookSecret(event.target.value)}
                                    type="password"
                                    autoComplete="new-password"
                                />
                            </div>
                        </div>
                        <Button type="submit" disabled={disabled}>
                            {createMutation.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
                            Save GitLab connector
                        </Button>
                    </form>
                </CardContent>
            </Card>
        </div>
    );
}

type ConnectorConnectPageProps = {
    connectorId: string;
};

export function ConnectorConnectPage({ connectorId }: ConnectorConnectPageProps) {
    const apiClient = useApiClient();
    const router = useRouter();
    const { isAdmin } = useAuth();
    const { data: groups = [], isLoading: groupsLoading } = useGroupsWithProjects();
    const { data: connectors = [] } = useQuery({
        queryKey: connectorQueryKeys.connectors,
        queryFn: () => fetchConnectors(apiClient),
    });
    const connector = connectors.find((item) => item.id === connectorId) ?? null;
    const manageableOwners = useMemo(() => {
        const owners = groups.filter(
            (group) => group.scope === "organization" || group.role === "admin" || group.role === "moderator"
        );
        if (isAdmin && !owners.some((group) => group.scope === "organization")) {
            return [
                {
                    id: ORGANIZATION_GROUP_ID,
                    name: "Organization",
                    role: "admin" as const,
                    scope: "organization" as const,
                    projects: [],
                },
                ...owners,
            ];
        }
        return owners;
    }, [groups, isAdmin]);
    const canManageGraphs = manageableOwners.length > 0;
    const connectorActive = connector?.status === "active";
    const [ownerValue, setOwnerValue] = useState("");
    const [installationId, setInstallationId] = useState("");
    const [repositoryId, setRepositoryId] = useState("");
    const [branchName, setBranchName] = useState("");
    const [graphName, setGraphName] = useState("");

    useEffect(() => {
        if (!ownerValue && manageableOwners.length > 0) setOwnerValue(manageableOwners[0].id);
    }, [manageableOwners, ownerValue]);

    const installationsQuery = useQuery({
        queryKey: connectorQueryKeys.installations(connectorId),
        queryFn: () => fetchConnectorInstallations(apiClient, connectorId),
        enabled: canManageGraphs && connectorActive,
    });
    const installations = installationsQuery.data ?? EMPTY_INSTALLATIONS;

    useEffect(() => {
        if (!installationId && installations.length > 0) setInstallationId(installations[0].id);
    }, [installationId, installations]);

    const repositoriesQuery = useQuery({
        queryKey: connectorQueryKeys.repositories(connectorId, installationId),
        queryFn: () => fetchConnectorRepositories(apiClient, connectorId, installationId),
        enabled: canManageGraphs && connectorActive && installationId.length > 0,
    });
    const repositories = repositoriesQuery.data ?? EMPTY_REPOSITORIES;
    const selectedRepository = repositories.find((repository) => repository.id === repositoryId) ?? null;

    useEffect(() => {
        if (repositories.length === 0) {
            if (repositoryId) setRepositoryId("");
            return;
        }
        if (!repositories.some((repository) => repository.id === repositoryId)) {
            const defaultRepository = repositories.find((repository) => repository.defaultBranch) ?? repositories[0];
            setRepositoryId(defaultRepository.id);
        }
    }, [repositories, repositoryId]);

    const branchesQuery = useQuery({
        queryKey: connectorQueryKeys.branches(connectorId, installationId, repositoryId),
        queryFn: () => fetchConnectorBranches(apiClient, connectorId, installationId, repositoryId),
        enabled: canManageGraphs && connectorActive && installationId.length > 0 && repositoryId.length > 0,
    });
    const branches = branchesQuery.data ?? EMPTY_BRANCHES;

    useEffect(() => {
        if (branches.length === 0) {
            if (branchName) setBranchName("");
            return;
        }
        if (!branches.some((branch) => branch.name === branchName)) {
            const defaultBranch = selectedRepository?.defaultBranch;
            setBranchName(branches.find((branch) => branch.name === defaultBranch)?.name ?? branches[0].name);
        }
    }, [branches, branchName, selectedRepository?.defaultBranch]);

    useEffect(() => {
        if (!graphName && selectedRepository) setGraphName(selectedRepository.name);
    }, [graphName, selectedRepository]);


    const connectMutation = useMutation({
        mutationFn: () =>
            startConnectorConnect(apiClient, connectorId, {
                ...(ownerValue === ORGANIZATION_GROUP_ID ? {} : { teamId: ownerValue }),
            }),
        onSuccess: ({ redirectUrl }) => {
            window.location.assign(redirectUrl);
        },
        onError: () => toast.error("Unable to open the provider installation flow."),
    });
    const createMutation = useMutation({
        mutationFn: async () => {
            if (!selectedRepository) throw new Error("Repository is required");
            const owner =
                ownerValue === ORGANIZATION_GROUP_ID
                    ? { kind: "organization" as const }
                    : { kind: "team" as const, teamId: ownerValue };
            return createRepositoryGraph(apiClient, connectorId, {
                connectorInstallationId: installationId,
                repositoryId: selectedRepository.id,
                repositoryFullName: selectedRepository.fullName,
                repositoryHtmlUrl: selectedRepository.htmlUrl,
                branch: branchName,
                name: graphName.trim() || selectedRepository.name,
                owner,
            });
        },
        onSuccess: ({ graph }) => {
            const routeGroupId = ownerValue === ORGANIZATION_GROUP_ID ? ORGANIZATION_GROUP_ID : ownerValue;
            router.push(`/${routeGroupId}/${graph.graphId ?? graph.id}`);
        },
        onError: () => toast.error("Unable to create repository graph."),
    });

    const disabled =
        createMutation.isPending ||
        !canManageGraphs ||
        !connectorActive ||
        ownerValue.length === 0 ||
        installationId.length === 0 ||
        repositoryId.length === 0 ||
        branchName.length === 0 ||
        !selectedRepository;
    const installDisabled =
        connectMutation.isPending || !connectorActive || ownerValue.length === 0 || connector?.provider !== "github";

    if (!canManageGraphs && groupsLoading) {
        return (
            <Card>
                <CardContent className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" /> Loading connector access…
                </CardContent>
            </Card>
        );
    }

    if (!canManageGraphs) {
        return (
            <Card>
                <CardHeader>
                    <CardTitle>Repository connector access denied</CardTitle>
                    <CardDescription>You need manager access to connect repositories.</CardDescription>
                </CardHeader>
            </Card>
        );
    }

    if (connector && !connectorActive) {
        return (
            <Card>
                <CardHeader>
                    <CardTitle>{connector.name} is disabled</CardTitle>
                    <CardDescription>
                        {connector.provider === "gitlab"
                            ? "GitLab connectors are saved in a disabled state until OAuth installation support is available."
                            : "Enable this connector before connecting repositories."}
                    </CardDescription>
                </CardHeader>
            </Card>
        );
    }

    return (
        <div className="max-w-5xl space-y-6">
            <div>
                <h1 className="text-2xl font-bold">Connect repository</h1>
                <p className="text-muted-foreground">
                    {connector ? `${connector.provider === "github" ? "GitHub" : "GitLab"} · ${connector.name}` : "Choose an installation, repository, and branch."}
                </p>
            </div>

            <Card>
                <CardHeader>
                    <CardTitle>Repository graph</CardTitle>
                    <CardDescription>Create a graph from a provider repository without exposing provider credentials.</CardDescription>
                </CardHeader>
                <CardContent>
                    {connector?.provider === "github" ? (
                        <div className="mb-5 flex flex-wrap items-center gap-3 rounded-md border border-dashed p-4">
                            <div className="min-w-0 flex-1">
                                <p className="text-sm font-medium">Need a GitHub installation?</p>
                                <p className="text-sm text-muted-foreground">
                                    Install or refresh the GitHub App for the selected owner before choosing a repository.
                                </p>
                            </div>
                            <Button
                                type="button"
                                variant="outline"
                                disabled={installDisabled}
                                onClick={() => connectMutation.mutate()}
                            >
                                {connectMutation.isPending ? <Loader2 className="size-4 animate-spin" /> : <ExternalLink />}
                                Connect GitHub installation
                            </Button>
                        </div>
                    ) : null}

                    <form
                        className="space-y-5"
                        onSubmit={(event) => {
                            event.preventDefault();
                            if (!disabled) createMutation.mutate();
                        }}
                    >
                        <div className="grid gap-4 md:grid-cols-2">
                            <SelectField label="Owner" value={ownerValue} onValueChange={setOwnerValue} disabled={manageableOwners.length === 0}>
                                {manageableOwners.map((group) => (
                                    <SelectItem key={group.id} value={group.id}>
                                        {group.name} ({group.scope})
                                    </SelectItem>
                                ))}
                            </SelectField>

                            <SelectField
                                label="Installation or account"
                                value={installationId}
                                onValueChange={(value) => {
                                    setInstallationId(value);
                                    setRepositoryId("");
                                    setBranchName("");
                                }}
                                disabled={installations.length === 0}
                            >
                                {installations.map((installation) => (
                                    <SelectItem key={installation.id} value={installation.id}>
                                        {installation.providerAccountLogin} ({installation.repositorySelection})
                                    </SelectItem>
                                ))}
                            </SelectField>

                            <SelectField
                                label="Repository"
                                value={repositoryId}
                                onValueChange={(value) => {
                                    setRepositoryId(value);
                                    setBranchName("");
                                    const repository = repositories.find((item) => item.id === value);
                                    if (repository) setGraphName(repository.name);
                                }}
                                disabled={repositories.length === 0 || repositoriesQuery.isLoading}
                            >
                                {repositories.map((repository) => (
                                    <SelectItem key={repository.id} value={repository.id}>
                                        {repository.fullName}
                                        {repository.private ? " · private" : ""}
                                    </SelectItem>
                                ))}
                            </SelectField>

                            <SelectField
                                label="Branch"
                                value={branchName}
                                onValueChange={setBranchName}
                                disabled={branches.length === 0 || branchesQuery.isLoading}
                            >
                                {branches.map((branch) => (
                                    <SelectItem key={branch.name} value={branch.name}>
                                        {branch.name}
                                        {branch.name === selectedRepository?.defaultBranch ? " · default" : ""}
                                    </SelectItem>
                                ))}
                            </SelectField>
                        </div>

                        <div className="space-y-2">
                            <Label htmlFor="repository-graph-name">Graph name</Label>
                            <Input
                                id="repository-graph-name"
                                value={graphName}
                                onChange={(event) => setGraphName(event.target.value)}
                                placeholder={selectedRepository?.name ?? "Repository graph"}
                            />
                        </div>

                        <ConnectorSelectionState
                            repositories={repositories}
                            branches={branches}
                            repositoriesLoading={repositoriesQuery.isLoading}
                            branchesLoading={branchesQuery.isLoading}
                        />

                        <Button type="submit" disabled={disabled}>
                            {createMutation.isPending ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw />}
                            Create graph
                        </Button>
                    </form>
                </CardContent>
            </Card>
        </div>
    );
}


function SelectField({
    label,
    value,
    onValueChange,
    disabled,
    children,
}: {
    label: string;
    value: string;
    onValueChange: (value: string) => void;
    disabled?: boolean;
    children: ReactNode;
}) {
    return (
        <div className="space-y-2">
            <Label>{label}</Label>
            <Select value={value} onValueChange={onValueChange} disabled={disabled}>
                <SelectTrigger className="w-full">
                    <SelectValue placeholder={`Select ${label.toLowerCase()}`} />
                </SelectTrigger>
                <SelectContent>{children}</SelectContent>
            </Select>
        </div>
    );
}

function ConnectorSelectionState({
    repositories,
    branches,
    repositoriesLoading,
    branchesLoading,
}: {
    repositories: ConnectorRepositoryRecord[];
    branches: ConnectorBranchRecord[];
    repositoriesLoading: boolean;
    branchesLoading: boolean;
}) {
    if (repositoriesLoading || branchesLoading) {
        return <p className="text-sm text-muted-foreground">Loading provider metadata…</p>;
    }
    if (repositories.length === 0) {
        return <p className="text-sm text-muted-foreground">No repositories are available for this installation.</p>;
    }
    if (branches.length === 0) {
        return <p className="text-sm text-muted-foreground">No branches are available for this repository.</p>;
    }
    return null;
}
