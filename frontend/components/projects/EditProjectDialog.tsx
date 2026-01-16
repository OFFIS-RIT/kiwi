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
import {
  addFilesToProject,
  deleteProjectFiles,
  fetchProjectFiles,
  updateProject,
} from "@/lib/api/projects";
import { cn } from "@/lib/utils";
import { useData } from "@/providers/DataProvider";
import { useLanguage } from "@/providers/LanguageProvider";
import type { ApiProjectFile } from "@/types";
import { Calendar, FileText, Loader2, XIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
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

export function EditProjectDialog({
  open,
  onOpenChange,
  project,
}: EditProjectDialogProps) {
  const { t } = useLanguage();
  const { refreshData } = useData();
  const [isLoading, setIsLoading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [projectFiles, setProjectFiles] = useState<ApiProjectFile[]>([]);
  const [newFiles, setNewFiles] = useState<File[]>([]);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [editedName, setEditedName] = useState("");
  const [filesToDelete, setFilesToDelete] = useState<string[]>([]);

  const loadProjectFiles = useCallback(async () => {
    if (!project) return;
    setIsLoading(true);
    setError(null);
    try {
      const files = await fetchProjectFiles(project.id);
      setProjectFiles(files);
    } catch (err) {
      console.error("Fehler beim Laden der Projektdateien:", err);
      setError(
        err instanceof Error
          ? err.message
          : "Unbekannter Fehler beim Laden der Dateien"
      );
    } finally {
      setIsLoading(false);
    }
  }, [project]);

  useEffect(() => {
    if (project && open) {
      setEditedName(project.name);
      loadProjectFiles();
      setFilesToDelete([]);
    } else {
      setProjectFiles([]);
      setNewFiles([]);
      setError(null);
      setEditedName("");
      setFilesToDelete([]);
      setUploadProgress(0);
    }
  }, [project, open, loadProjectFiles]);

  const handleToggleFileForDeletion = (fileKey: string) => {
    setFilesToDelete((prev) =>
      prev.includes(fileKey)
        ? prev.filter((key) => key !== fileKey)
        : [...prev, fileKey]
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
          console.error("Fehler beim Löschen der Dateien:", err);
          setError(
            (prevError) =>
              (prevError ? `${prevError}\n` : "") +
              (err instanceof Error
                ? err.message
                : "Fehler beim Löschen von Dateien")
          );
        }
      }

      if (nameChanged && overallSuccess) {
        try {
          await updateProject(project.id, editedName);
        } catch (err) {
          overallSuccess = false;
          console.error("Fehler beim Aktualisieren des Projektnamens:", err);
          setError(
            (prevError) =>
              (prevError ? `${prevError}\n` : "") +
              (err instanceof Error
                ? err.message
                : "Fehler beim Aktualisieren des Namens")
          );
        }
      }

      if (filesAdded && overallSuccess) {
        try {
          await addFilesToProject(project.id, newFiles, (progress) =>
            setUploadProgress(progress)
          );
          setNewFiles([]);
        } catch (err) {
          overallSuccess = false;
          console.error("Fehler beim Hinzufügen der Dateien:", err);
          setError(
            (prevError) =>
              (prevError ? `${prevError}\n` : "") +
              (err instanceof Error
                ? err.message
                : "Fehler beim Hinzufügen der Dateien")
          );
        }
      }

      if (
        overallSuccess &&
        (nameChanged || filesAdded || filesMarkedForDeletion)
      ) {
        await refreshData();
        await loadProjectFiles();
      }

      if (overallSuccess) {
        onOpenChange(false);
      }
    } catch (err) {
      console.error("Unerwarteter Fehler im Submit-Prozess:", err);
      if (!error) {
        setError(
          err instanceof Error
            ? err.message
            : "Ein unerwarteter Fehler ist aufgetreten."
        );
      }
      overallSuccess = false;
    } finally {
      setIsSubmitting(false);
    }
  };

  const parseApiTimestamp = (
    value: { Time?: string; Valid?: boolean } | string | null | undefined
  ): Date | null => {
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

  const formatDate = (
    input: { Time?: string; Valid?: boolean } | string | null | undefined
  ) => {
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[800px] h-[80vh] flex flex-col">
        <DialogHeader className="flex-shrink-0">
          <DialogTitle>{t("edit.project")}</DialogTitle>
          <DialogDescription>{t("edit.project.description")}</DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0">
          <ScrollArea className="h-full">
            <div className="space-y-6 pr-4">
              {error && (
                <div className="bg-destructive/15 text-destructive px-4 py-2 rounded-md text-sm whitespace-pre-line">
                  {error}
                </div>
              )}

              <div className="space-y-4">
                <div className="grid gap-2">
                  <Label htmlFor="project-name-edit">{t("project.name")}</Label>
                  <Input
                    id="project-name-edit"
                    value={editedName}
                    onChange={(e) => setEditedName(e.target.value)}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="project-id">{t("project.id")}</Label>
                  <Input
                    id="project-id"
                    value={project.id}
                    disabled
                    className="bg-muted font-mono text-sm"
                  />
                </div>
              </div>

              <Separator />

              <div className="space-y-4">
                <h3 className="text-lg font-medium">{t("project.files")}</h3>
                {isLoading ? (
                  <div className="flex items-center justify-center py-4">
                    <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                    <span className="ml-2 text-muted-foreground">
                      {t("loading.files")}
                    </span>
                  </div>
                ) : projectFiles.length === 0 && filesToDelete.length === 0 ? (
                  <div className="py-4 text-center text-muted-foreground">
                    {t("no.files")}
                  </div>
                ) : (
                  <div className="grid grid-cols-1 gap-2 md:grid-cols-2 lg:grid-cols-3">
                    {projectFiles.map((file) => {
                      const isMarkedForDeletion = filesToDelete.includes(
                        file.file_key
                      );
                      return (
                        <div
                          key={file.id}
                          className={cn(
                            "relative rounded-md border p-2 text-xs",
                            isMarkedForDeletion &&
                              "opacity-50 ring-2 ring-destructive"
                          )}
                        >
                          <div className="flex items-start gap-2">
                            <FileText className="mt-0.5 h-3 w-3 text-muted-foreground" />
                            <div className="min-w-0 flex-1">
                              <p
                                className={cn(
                                  "truncate text-xs font-medium leading-tight",
                                  isMarkedForDeletion && "line-through"
                                )}
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
                          <Button
                            variant="ghost"
                            size="icon"
                            className={cn(
                              "absolute right-1 top-1 h-6 w-6",
                              isMarkedForDeletion
                                ? "text-destructive hover:text-destructive"
                                : "text-muted-foreground hover:text-destructive"
                            )}
                            onClick={() =>
                              handleToggleFileForDeletion(file.file_key)
                            }
                            aria-label={
                              isMarkedForDeletion
                                ? t("undo.delete.file")
                                : t("mark.delete.file")
                            }
                          >
                            <XIcon className="h-3.5 w-3.5" />
                          </Button>
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
                  </div>
                )}
              </div>
            </div>
          </ScrollArea>
        </div>

        <DialogFooter className="flex-shrink-0 pt-4">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            {t("cancel")}
          </Button>
          <Button onClick={handleSubmit} disabled={isSubmitting || !hasChanges}>
            {isSubmitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {t("save.changes")}
              </>
            ) : (
              t("save.changes")
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
