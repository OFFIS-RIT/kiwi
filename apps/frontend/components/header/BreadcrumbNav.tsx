"use client";

import {
    Breadcrumb,
    BreadcrumbItem,
    BreadcrumbLink,
    BreadcrumbList,
    BreadcrumbPage,
    BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { useCurrentSelection } from "@/hooks/use-current-selection";
import { usePathname } from "next/navigation";

type BreadcrumbNavProps = {
    ready?: boolean;
};

export function BreadcrumbNav({ ready = true }: BreadcrumbNavProps) {
    const pathname = usePathname();
    const { group: selectedGroup, project: selectedProject } = useCurrentSelection();
    const showAllGroups = pathname === "/";

    const fadeClass = `transition-opacity duration-300 ${ready ? "opacity-100" : "opacity-0"}`;

    return (
        <Breadcrumb className="min-w-0 w-full overflow-hidden">
            <BreadcrumbList className="min-w-0 w-full flex-nowrap overflow-hidden">
                {showAllGroups ? (
                    <BreadcrumbItem className="shrink-0">
                        <BreadcrumbPage>KIWI</BreadcrumbPage>
                    </BreadcrumbItem>
                ) : selectedGroup ? (
                    <>
                        <BreadcrumbItem className="shrink-0">
                            <BreadcrumbLink className="max-w-full truncate" href="/">
                                KIWI
                            </BreadcrumbLink>
                        </BreadcrumbItem>
                        <BreadcrumbSeparator className={`shrink-0 ${fadeClass}`} />
                        <BreadcrumbItem className={`min-w-0 shrink ${fadeClass}`}>
                            <BreadcrumbLink
                                className="block max-w-full truncate"
                                href={`/${selectedGroup.id}`}
                                title={selectedGroup.name}
                            >
                                {selectedGroup.name}
                            </BreadcrumbLink>
                        </BreadcrumbItem>
                        {selectedProject && (
                            <>
                                <BreadcrumbSeparator className={`shrink-0 ${fadeClass}`} />
                                <BreadcrumbItem className={`min-w-0 shrink ${fadeClass}`}>
                                    <BreadcrumbPage className="block max-w-full truncate" title={selectedProject.name}>
                                        {selectedProject.name}
                                    </BreadcrumbPage>
                                </BreadcrumbItem>
                            </>
                        )}
                    </>
                ) : (
                    <BreadcrumbItem className="shrink-0">
                        <BreadcrumbLink href="/">KIWI</BreadcrumbLink>
                    </BreadcrumbItem>
                )}
            </BreadcrumbList>
        </Breadcrumb>
    );
}
