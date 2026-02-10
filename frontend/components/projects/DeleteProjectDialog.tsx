"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useDeleteProject } from "@/hooks/use-data";
import { useLanguage } from "@/providers/LanguageProvider";
import { useNavigation } from "@/providers/NavigationProvider";
import { Loader2 } from "lucide-react";
import { useEffect } from "react";

type DeleteProjectDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: {
    id: string;
    name: string;
  } | null;
  groupId: string | null;
  groupName: string | null;
};

export function DeleteProjectDialog({
  open,
  onOpenChange,
  project,
  groupId,
  groupName,
}: DeleteProjectDialogProps) {
  const { t } = useLanguage();
  const { selectItem, selectedProject } = useNavigation();
  const deleteProjectMutation = useDeleteProject();

  useEffect(() => {
    if (!open) {
      deleteProjectMutation.reset();
    }
  }, [open, deleteProjectMutation]);

  const handleDelete = async () => {
    if (!project) return;

    try {
      await deleteProjectMutation.mutateAsync(project.id);

      onOpenChange(false);

      if (selectedProject?.id === project.id && groupId && groupName) {
        selectItem({ id: groupId, name: groupName });
      }
    } catch (err) {
      console.error("Failed to delete project:", err);
    }
  };

  const error = deleteProjectMutation.error
    ? deleteProjectMutation.error instanceof Error
      ? deleteProjectMutation.error.message
      : t("delete.project.error")
    : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>{t("delete.project.confirm")}</DialogTitle>
          <DialogDescription>
            {t("delete.project.description", {
              projectName: project?.name || "",
            })}
          </DialogDescription>
        </DialogHeader>

        {error && (
          <div className="bg-destructive/15 text-destructive px-4 py-2 rounded-md text-sm">
            {error}
          </div>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={deleteProjectMutation.isPending}
          >
            {t("cancel")}
          </Button>
          <Button
            variant="destructive"
            onClick={handleDelete}
            disabled={deleteProjectMutation.isPending}
          >
            {deleteProjectMutation.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : null}
            {t("delete")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
