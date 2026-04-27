"use client";

import { AppSidebarInset } from "@/components/common/AppSidebarInset";
import { BreadcrumbNav } from "@/components/header/BreadcrumbNav";
import { CreateActions } from "@/components/header/CreateActions";
import { LanguageSwitcher } from "@/components/header/LanguageSwitcher";
import { UserNav } from "@/components/header/UserNav";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { useData } from "@/providers/DataProvider";
import { ProjectChat } from "./ProjectChat";

type ProjectChatViewProps = {
    groupName: string;
    projectName: string;
};

export function ProjectChatView({ groupName, projectName }: ProjectChatViewProps) {
    const { groups } = useData();
    const group = groups.find((g) => g.name === groupName);
    const project = group?.projects.find((p) => p.name === projectName);

    return (
        <AppSidebarInset>
            <header className="flex h-16 shrink-0 items-center justify-between gap-2 border-b px-4">
                <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
                    <SidebarTrigger className="-ml-1" />
                    <Separator orientation="vertical" className="mr-2 h-4 shrink-0" />
                    <BreadcrumbNav />
                </div>
                <div className="flex shrink-0 items-center gap-2">
                    <LanguageSwitcher />
                    <CreateActions />
                    <UserNav />
                </div>
            </header>
            <div className="flex h-[calc(100vh-4rem)] flex-col overflow-hidden p-4">
                {project && group ? (
                    <div className="h-full min-w-0 overflow-hidden">
                        <ProjectChat
                            projectName={project.name}
                            groupName={group.name}
                            projectId={project.id}
                        />
                    </div>
                ) : (
                    <div className="flex h-full items-center justify-center">
                        <p className="text-muted-foreground">Project not found</p>
                    </div>
                )}
            </div>
        </AppSidebarInset>
    );
}
