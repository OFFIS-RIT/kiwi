"use client";

import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useGroupsWithProjects } from "@/hooks/use-data";
import { canCreateAnyProject, canCreateTeam } from "@/lib/capabilities";
import { useAuth } from "@/providers/AuthProvider";
import { useAppTranslations } from "@/lib/i18n/use-app-translations";
import { BookOpen, Plus, Users } from "lucide-react";
import { Suspense, lazy, useState } from "react";

const CreateGroupDialog = lazy(() =>
    import("@/components/groups").then((mod) => ({
        default: mod.CreateGroupDialog,
    }))
);
const CreateProjectDialog = lazy(() =>
    import("@/components/projects").then((mod) => ({
        default: mod.CreateProjectDialog,
    }))
);

export function CreateActions() {
    const t = useAppTranslations();
    const { isAdmin } = useAuth();
    const { data: groups = [] } = useGroupsWithProjects();
    const context = { isAdmin };
    const canCreateGroup = canCreateTeam(context);
    const canCreateProject = canCreateAnyProject(groups, context);
    const [showProjectDialog, setShowProjectDialog] = useState(false);
    const [showGroupDialog, setShowGroupDialog] = useState(false);

    if (!canCreateGroup && !canCreateProject) {
        return null;
    }

    return (
        <>
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-8 w-8">
                        <Plus className="h-5 w-5" />
                        <span className="sr-only">{t("create.new")}</span>
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                    {canCreateGroup && (
                        <DropdownMenuItem onSelect={() => setShowGroupDialog(true)}>
                            <Users className="h-4 w-4" />
                            <span>{t("create.new.group")}</span>
                        </DropdownMenuItem>
                    )}
                    {canCreateProject && (
                        <DropdownMenuItem onSelect={() => setShowProjectDialog(true)}>
                            <BookOpen className="h-4 w-4" />
                            <span>{t("create.new.project")}</span>
                        </DropdownMenuItem>
                    )}
                </DropdownMenuContent>
            </DropdownMenu>

            <Suspense fallback={null}>
                <CreateProjectDialog open={showProjectDialog} onOpenChange={setShowProjectDialog} />
            </Suspense>
            <Suspense fallback={null}>
                <CreateGroupDialog open={showGroupDialog} onOpenChange={setShowGroupDialog} />
            </Suspense>
        </>
    );
}
