"use client";

import type React from "react";

import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { canCreateOrganizationProject, canCreatePersonalProject, canCreateProjectInGroup } from "@/lib/capabilities";
import { useGroupsWithProjects } from "@/hooks/use-data";
import { createProject, ORGANIZATION_GROUP_ID, PERSONAL_GROUP_ID } from "@/lib/api/projects";
import { queryKeys } from "@/lib/query-keys";
import { formatBytes } from "@/lib/utils";
import { useApiClient } from "@/providers/ApiClientProvider";
import { useAuth } from "@/providers/AuthProvider";
import { useAppTranslations } from "@/lib/i18n/use-app-translations";
import { useSidebarExpansion } from "@/providers/SidebarExpansionProvider";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { FileUploader } from "./FileUploader";

type CreateProjectDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    groupId?: string;
    onProjectCreated?: (projectId: string, groupId: string, projectName: string) => void;
};

const MAX_NAME_LENGTH = 40;

type ProjectDestination = { id: string; name: string; kind: "organization" | "personal" | "team" };

export function CreateProjectDialog({ open, onOpenChange, groupId, onProjectCreated }: CreateProjectDialogProps) {
    const apiClient = useApiClient();
    const queryClient = useQueryClient();
    const t = useAppTranslations();
    const { isAdmin } = useAuth();
    const { data: groups = [], isLoading, error: queryError } = useGroupsWithProjects();
    const error = queryError ? t("error.loading.data") : null;
    const { toggleGroupExpanded, expandedGroups } = useSidebarExpansion();
    const [projectName, setProjectName] = useState("");
    const [selectedGroup, setSelectedGroup] = useState("");
    const [files, setFiles] = useState<File[]>([]);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [uploadProgress, setUploadProgress] = useState(0);
    const [uploadedBytes, setUploadedBytes] = useState(0);
    const [totalBytes, setTotalBytes] = useState(0);
    const [uploadSpeed, setUploadSpeed] = useState(0); // Bytes per second
    const [submitError, setSubmitError] = useState<string | null>(null);
    const [groupError, setGroupError] = useState(false);

    const nameTooLong = projectName.length > MAX_NAME_LENGTH;
    const context = { isAdmin };
    const existingDestinations: ProjectDestination[] = groups
        .filter((group) => canCreateProjectInGroup(group, context))
        .map((group) =>
            group.scope === "organization"
                ? {
                      id: group.id,
                      name: t("organization"),
                      kind: "organization",
                  }
                : {
                      id: group.id,
                      name: group.name,
                      kind: "team",
                  }
        );
    const hasOrganizationDestination = existingDestinations.some((destination) => destination.kind === "organization");
    const creatableDestinations: ProjectDestination[] = [
        ...(canCreateOrganizationProject(context) && !hasOrganizationDestination
            ? [
                  {
                      id: ORGANIZATION_GROUP_ID,
                      name: t("organization"),
                      kind: "organization" as const,
                  },
              ]
            : []),
        ...(canCreatePersonalProject(context)
            ? [
                  {
                      id: PERSONAL_GROUP_ID,
                      name: t("personal"),
                      kind: "personal" as const,
                  },
              ]
            : []),
        ...existingDestinations,
    ];
    const groupIdExists = groupId ? creatableDestinations.some((destination) => destination.id === groupId) : false;

    useEffect(() => {
        if (open && groupId && groupIdExists) {
            setSelectedGroup(groupId);
        } else if (!open) {
            setProjectName("");
            setSelectedGroup("");
            setFiles([]);
            setSubmitError(null);
            setGroupError(false);
            setUploadProgress(0);
            setUploadedBytes(0);
            setTotalBytes(0);
            setUploadSpeed(0);
        }
    }, [open, groupId, groupIdExists]);

    const handleGroupChange = (value: string) => {
        setSelectedGroup(value);
        if (groupError) {
            setGroupError(false);
            setSubmitError(null);
        }
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setIsSubmitting(true);
        setSubmitError(null);
        setGroupError(false);

        if (!selectedGroup) {
            setGroupError(true);
            setSubmitError(t("error.group.required"));
            setIsSubmitting(false);
            return;
        }

        try {
            const startTime = Date.now();
            let lastTime = startTime;
            let lastLoaded = 0;

            const response = await createProject(
                apiClient,
                selectedGroup,
                projectName,
                files,
                (progress, loaded, total) => {
                    setUploadProgress(progress);
                    setUploadedBytes(loaded);
                    setTotalBytes(total);

                    const currentTime = Date.now();
                    const timeDiff = currentTime - lastTime;

                    // Update speed every 500ms to avoid flickering
                    if (timeDiff > 500) {
                        const bytesDiff = loaded - lastLoaded;
                        const speed = (bytesDiff / timeDiff) * 1000; // Bytes/sec
                        setUploadSpeed(speed);
                        lastTime = currentTime;
                        lastLoaded = loaded;
                    }
                }
            );

            if (!expandedGroups[selectedGroup]) {
                toggleGroupExpanded(selectedGroup);
            }

            await queryClient.invalidateQueries({ queryKey: queryKeys.groupsWithProjects });

            if (onProjectCreated) {
                onProjectCreated(response.graph.id.toString(), selectedGroup, response.graph.name);
            }

            onOpenChange(false);
        } catch (error) {
            console.error(t("error.creating.project"), error);
            setSubmitError(error instanceof Error ? error.message : t("error.unknown"));
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-[600px]">
                <form onSubmit={handleSubmit} className="w-full">
                    <DialogHeader>
                        <DialogTitle>{t("create.new.project")}</DialogTitle>
                        <DialogDescription>{t("create.new.project.description")}</DialogDescription>
                    </DialogHeader>
                    <div className="grid gap-6 py-4 min-w-0">
                        {submitError && (
                            <div className="bg-destructive/15 text-destructive px-4 py-2 rounded-md text-sm">
                                {submitError}
                            </div>
                        )}
                        <div className="grid gap-2">
                            <Label htmlFor="project-name">{t("project.name")}</Label>
                            <Input
                                id="project-name"
                                value={projectName}
                                onChange={(e) => setProjectName(e.target.value)}
                                placeholder={t("project.name.placeholder")}
                                required
                            />
                            {nameTooLong && (
                                <p className="text-sm text-destructive">
                                    {t("error.name.too.long", { max: String(MAX_NAME_LENGTH) })}
                                </p>
                            )}
                        </div>
                        <div className="grid gap-2">
                            <Label htmlFor="group">{t("select.group")}</Label>
                            <Select
                                value={selectedGroup}
                                onValueChange={handleGroupChange}
                                required
                                disabled={isLoading || creatableDestinations.length === 0}
                            >
                                <SelectTrigger id="group" aria-invalid={groupError} className="w-full">
                                    {isLoading ? (
                                        <div className="flex items-center gap-2">
                                            <Loader2 className="h-4 w-4 animate-spin" />
                                            <span>{t("loading")}</span>
                                        </div>
                                    ) : (
                                        <SelectValue placeholder={t("select.group.placeholder")} />
                                    )}
                                </SelectTrigger>
                                <SelectContent>
                                    {error ? (
                                        <div className="p-2 text-sm text-destructive">{t("error.loading.groups")}</div>
                                    ) : creatableDestinations.length === 0 ? (
                                        <div className="p-2 text-sm text-muted-foreground">{t("no.groups")}</div>
                                    ) : (
                                        creatableDestinations.map((destination) => (
                                            <SelectItem key={destination.id} value={destination.id}>
                                                {destination.name}
                                            </SelectItem>
                                        ))
                                    )}
                                </SelectContent>
                            </Select>
                        </div>
                        <div className="grid gap-2 w-full min-w-0">
                            <Label>{t("upload.documents")}</Label>
                            <FileUploader files={files} setFiles={setFiles} />
                        </div>
                        {isSubmitting && files.length > 0 && (
                            <div className="space-y-2">
                                <div className="flex justify-between text-xs text-muted-foreground">
                                    <span>{t("uploading.files")}</span>
                                    <span>{Math.round(uploadProgress)}%</span>
                                </div>
                                <Progress value={uploadProgress} />
                                <div className="flex justify-between text-xs text-muted-foreground">
                                    <span>
                                        {formatBytes(uploadedBytes)} / {formatBytes(totalBytes)}
                                    </span>
                                    <span>{formatBytes(uploadSpeed)}/s</span>
                                </div>
                            </div>
                        )}
                    </div>
                    <DialogFooter>
                        <Button
                            type="button"
                            variant="outline"
                            onClick={() => onOpenChange(false)}
                            disabled={isSubmitting}
                        >
                            {t("cancel")}
                        </Button>
                        <Button type="submit" disabled={isSubmitting || nameTooLong}>
                            {isSubmitting ? t("creating") : t("create")}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
