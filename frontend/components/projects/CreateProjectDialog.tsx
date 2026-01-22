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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { createProject } from "@/lib/api/projects";
import { useData } from "@/providers/DataProvider";
import { useLanguage } from "@/providers/LanguageProvider";
import { useSidebarExpansion } from "@/providers/SidebarExpansionProvider";
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { FileUploader } from "./FileUploader";

type CreateProjectDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groupId?: string;
  onProjectCreated?: (
    projectId: string,
    groupId: string,
    projectName: string
  ) => void;
};

export function CreateProjectDialog({
  open,
  onOpenChange,
  groupId,
  onProjectCreated,
}: CreateProjectDialogProps) {
  const { t } = useLanguage();
  const { groups, isLoading, error, refreshData } = useData();
  const { toggleGroupExpanded, expandedGroups } = useSidebarExpansion();
  const [projectName, setProjectName] = useState("");
  const [selectedGroup, setSelectedGroup] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadedBytes, setUploadedBytes] = useState(0);
  const [totalBytes, setTotalBytes] = useState(0);
  const [uploadSpeed, setUploadSpeed] = useState(0); // Bytes per second
  const [lastUploadUpdate, setLastUploadUpdate] = useState(0);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [groupError, setGroupError] = useState(false);

  useEffect(() => {
    if (open && groupId && groups.some((group) => group.id === groupId)) {
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
  }, [open, groupId, groups]);

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${Number.parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
  };

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

      if (refreshData) {
        refreshData();
      }

      if (onProjectCreated && response?.project) {
        onProjectCreated(
          response.project.id.toString(),
          selectedGroup,
          projectName
        );
      }

      onOpenChange(false);
    } catch (error) {
      console.error("Fehler beim Erstellen des Projekts:", error);
      setSubmitError(
        error instanceof Error ? error.message : "Unbekannter Fehler"
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px]">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{t("create.new.project")}</DialogTitle>
            <DialogDescription>
              {t("create.new.project.description")}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-6 py-4">
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
            </div>
            <div className="grid gap-2">
              <Label htmlFor="group">{t("select.group")}</Label>
              <Select
                value={selectedGroup}
                onValueChange={handleGroupChange}
                required
                disabled={isLoading || groups.length === 0}
              >
                <SelectTrigger
                  id="group"
                  aria-invalid={groupError}
                  className="w-full"
                >
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
                    <div className="p-2 text-sm text-destructive">
                      {t("error.loading.groups")}
                    </div>
                  ) : groups.length === 0 ? (
                    <div className="p-2 text-sm text-muted-foreground">
                      {t("no.groups")}
                    </div>
                  ) : (
                    groups.map((group) => (
                      <SelectItem key={group.id} value={group.id.toString()}>
                        {group.name}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
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
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? t("creating") : t("create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
