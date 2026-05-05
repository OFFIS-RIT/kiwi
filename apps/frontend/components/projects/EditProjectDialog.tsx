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
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { useProjectFiles } from "@/hooks/use-data";
import { addFilesToProject, deleteProjectFiles, updateProject } from "@/lib/api/projects";
import { cn, formatBytes } from "@/lib/utils";
import { useAuth } from "@/providers/AuthProvider";
import { useData } from "@/providers/DataProvider";
import { useLanguage } from "@/providers/LanguageProvider";
import { Calendar, Loader2, XIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { FileStatusIcon } from "./FileStatusIcon";
import { FileUploader } from "./FileUploader";

type EditProjectDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    project: {
        id: string;
        name: string;
    } | null;
    groupId: string | null;
};

const MAX_NAME_LENGTH = 40;

export function EditProjectDialog({ open, onOpenChange, project }: EditProjectDialogProps) {
    const { t } = useLanguage();
    const { hasPermission } = useAuth();
    const { refreshData } = useData();
    const canEdit = hasPermission("graph.update");
    const canDeleteFiles = hasPermission("graph.delete:file");
    const canAddFiles = hasPermission("graph.add:file");
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [newFiles, setNewFiles] = useState<File[]>([]);
    const [uploadProgress, setUploadProgress] = useState(0);
    const [uploadedBytes, setUploadedBytes] = useState(0);
    const [totalBytes, setTotalBytes] = useState(0);
    const [uploadSpeed, setUploadSpeed] = useState(0);
    const [editedName, setEditedName] = useState("");
    const [filesToDelete, setFilesToDelete] = useState<string[]>([]);
    const projectId = project?.id;
    const projectName = project?.name;

    const nameTooLong = editedName.length > MAX_NAME_LENGTH;
    const {
        data: projectFiles = [],
        isLoading,
        error: projectFilesError,
        refetch: refetchProjectFiles,
    } = useProjectFiles(project?.id ?? "", { enabled: open && !!project });

    useEffect(() => {
        if (projectId && projectName !== undefined && open) {
            setEditedName(projectName);
            setFilesToDelete([]);
        } else {
            setNewFiles([]);
            setError(null);
            setEditedName("");
            setFilesToDelete([]);
            setUploadProgress(0);
            setUploadedBytes(0);
            setTotalBytes(0);
            setUploadSpeed(0);
        }
    }, [projectId, projectName, open]);

    const handleToggleFileForDeletion = (fileKey: string) => {
        setFilesToDelete((prev) =>
            prev.includes(fileKey) ? prev.filter((key) => key !== fileKey) : [...prev, fileKey]
        );
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!project) return;

        const nameChanged = editedName.trim() !== "" && editedName !== project.name;
        const filesAdded = newFiles.length > 0;
        const filesMarkedForDeletion = filesToDelete.length > 0;

        if (!nameChanged && !filesAdded && !filesMarkedForDeletion) {
            onOpenChange(false);
            return;
        }

        setIsSubmitting(true);
        setError(null);
        let overallSuccess = true;

        try {
            if (filesMarkedForDeletion) {
                try {
                    await deleteProjectFiles(project.id, filesToDelete);
                    setFilesToDelete([]);
                } catch (err) {
                    overallSuccess = false;
                    console.error("Error deleting files:", err);
                    setError(
                        (prevError) =>
                            (prevError ? `${prevError}\n` : "") +
                            (err instanceof Error ? err.message : t("error.delete.files"))
                    );
                }
            }

            if (nameChanged && overallSuccess) {
                try {
                    await updateProject(project.id, editedName);
                } catch (err) {
                    overallSuccess = false;
                    console.error("Error updating project name:", err);
                    setError(
                        (prevError) =>
                            (prevError ? `${prevError}\n` : "") +
                            (err instanceof Error ? err.message : t("error.update.project.name"))
                    );
                }
            }

            if (filesAdded && overallSuccess) {
                try {
                    const startTime = Date.now();
                    let lastTime = startTime;
                    let lastLoaded = 0;

                    await addFilesToProject(project.id, newFiles, (progress, loaded, total) => {
                        setUploadProgress(progress);
                        setUploadedBytes(loaded);
                        setTotalBytes(total);

                        const currentTime = Date.now();
                        const timeDiff = currentTime - lastTime;

                        if (timeDiff > 500) {
                            const bytesDiff = loaded - lastLoaded;
                            const speed = (bytesDiff / timeDiff) * 1000;
                            setUploadSpeed(speed);
                            lastTime = currentTime;
                            lastLoaded = loaded;
                        }
                    });
                    setNewFiles([]);
                } catch (err) {
                    overallSuccess = false;
                    console.error("Error adding files:", err);
                    setError(
                        (prevError) =>
                            (prevError ? `${prevError}\n` : "") +
                            (err instanceof Error ? err.message : t("error.add.files"))
                    );
                }
            }

            if (overallSuccess && (nameChanged || filesAdded || filesMarkedForDeletion)) {
                await refreshData();
                await refetchProjectFiles();
            }

            if (overallSuccess) {
                onOpenChange(false);
            }
        } catch (err) {
            console.error("Unexpected error in submit process:", err);
            if (!error) {
                setError(err instanceof Error ? err.message : t("error.unexpected"));
            }
            overallSuccess = false;
        } finally {
            setIsSubmitting(false);
        }
    };

    const parseApiTimestamp = (value: { Time?: string; Valid?: boolean } | string | null | undefined): Date | null => {
        if (!value) return null;
        if (typeof value === "string") {
            const d = new Date(value);
            return Number.isNaN(d.getTime()) ? null : d;
        }
        if (typeof value === "object") {
            const time = (value as { Time?: string }).Time as string | undefined;
            if (!time) return null;
            const d = new Date(time);
            return Number.isNaN(d.getTime()) ? null : d;
        }
        return null;
    };

    const formatDate = (input: { Time?: string; Valid?: boolean } | string | null | undefined) => {
        const d = parseApiTimestamp(input);
        if (!d) return "-";
        return d.toLocaleDateString(undefined, {
            year: "numeric",
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
        });
    };

    if (!project) {
        return null;
    }

    const hasChanges =
        (project && editedName.trim() !== "" && editedName !== project.name) ||
        newFiles.length > 0 ||
        filesToDelete.length > 0;
    const displayError = error || (projectFilesError instanceof Error ? projectFilesError.message : null);

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent
                className="sm:max-w-[800px] h-[80vh] flex flex-col"
                onOpenAutoFocus={(e) => e.preventDefault()}
            >
                <DialogHeader className="flex-shrink-0">
                    <DialogTitle>{t("edit.project")}</DialogTitle>
                    <DialogDescription>{t("edit.project.description")}</DialogDescription>
                </DialogHeader>

                <div className="flex-1 min-h-0">
                    <ScrollArea className="h-full">
                        <div className="space-y-6 pr-4">
                            {displayError && (
                                <div className="bg-destructive/15 text-destructive px-4 py-2 rounded-md text-sm whitespace-pre-line">
                                    {displayError}
                                </div>
                            )}

                            <div className="space-y-4">
                                <div className="grid gap-2">
                                    <Label htmlFor="project-name-edit">{t("project.name")}</Label>
                                    <Input
                                        id="project-name-edit"
                                        value={editedName}
                                        onChange={(e) => setEditedName(e.target.value)}
                                        onFocus={(e) => {
                                            const input = e.target;
                                            requestAnimationFrame(() => {
                                                input.selectionStart = input.selectionEnd = input.value.length;
                                            });
                                        }}
                                        disabled={!canEdit}
                                    />
                                    {nameTooLong && (
                                        <p className="text-sm text-destructive">
                                            {t("error.name.too.long", { max: String(MAX_NAME_LENGTH) })}
                                        </p>
                                    )}
                                </div>
                            </div>

                            <Separator />

                            <div className="space-y-4">
                                <h3 className="text-lg font-medium">{t("project.files")}</h3>
                                {isLoading ? (
                                    <div className="flex items-center justify-center py-4">
                                        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                                        <span className="ml-2 text-muted-foreground">{t("loading.files")}</span>
                                    </div>
                                ) : projectFiles.length === 0 && filesToDelete.length === 0 ? (
                                    <div className="py-4 text-center text-muted-foreground">{t("no.files")}</div>
                                ) : (
                                    <div className="grid grid-cols-1 gap-2 md:grid-cols-2 lg:grid-cols-3">
                                        {projectFiles.map((file) => {
                                            const isMarkedForDeletion = filesToDelete.includes(file.file_key);
                                            return (
                                                <div
                                                    key={file.id}
                                                    className={cn(
                                                        "relative rounded-md border p-2 text-xs",
                                                        isMarkedForDeletion && "opacity-50 ring-2 ring-destructive"
                                                    )}
                                                >
                                                    <div
                                                        className={cn(
                                                            "flex items-start gap-2",
                                                            canDeleteFiles && "pr-6"
                                                        )}
                                                    >
                                                        <FileStatusIcon status={file.status} className="mt-0.5" />
                                                        <div className="min-w-0 flex-1">
                                                            <p
                                                                className={cn(
                                                                    "truncate text-xs font-medium leading-tight",
                                                                    isMarkedForDeletion && "line-through"
                                                                )}
                                                                title={file.name}
                                                            >
                                                                {file.name}
                                                            </p>
                                                            <p className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground">
                                                                <Calendar className="h-2.5 w-2.5" />
                                                                {formatDate(file.created_at) ||
                                                                    formatDate(file.updated_at)}
                                                            </p>
                                                        </div>
                                                    </div>
                                                    {canDeleteFiles && (
                                                        <Button
                                                            variant="ghost"
                                                            size="icon"
                                                            className={cn(
                                                                "absolute right-1 top-1 h-6 w-6",
                                                                isMarkedForDeletion
                                                                    ? "text-destructive hover:text-destructive"
                                                                    : "text-muted-foreground hover:text-destructive"
                                                            )}
                                                            onClick={() => handleToggleFileForDeletion(file.file_key)}
                                                            aria-label={
                                                                isMarkedForDeletion
                                                                    ? t("undo.delete.file")
                                                                    : t("mark.delete.file")
                                                            }
                                                        >
                                                            <XIcon className="h-3.5 w-3.5" />
                                                        </Button>
                                                    )}
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}
                                {filesToDelete.length > 0 && (
                                    <p className="px-1 text-xs text-destructive/80">
                                        {t("files.marked.deletion.warning")}
                                    </p>
                                )}
                            </div>

                            {canAddFiles && (
                                <>
                                    <Separator />

                                    <div className="space-y-4">
                                        <h3 className="text-lg font-medium">{t("add.files")}</h3>
                                        <FileUploader files={newFiles} setFiles={setNewFiles} />
                                        {isSubmitting && newFiles.length > 0 && (
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
                                </>
                            )}
                        </div>
                    </ScrollArea>
                </div>

                <DialogFooter className="flex-shrink-0 pt-4">
                    <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                        {canEdit || canDeleteFiles || canAddFiles ? t("cancel") : t("close")}
                    </Button>
                    {(canEdit || canDeleteFiles || canAddFiles) && (
                        <Button onClick={handleSubmit} disabled={isSubmitting || !hasChanges || nameTooLong}>
                            {isSubmitting ? (
                                <>
                                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                    {t("save.changes")}
                                </>
                            ) : (
                                t("save.changes")
                            )}
                        </Button>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
