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
import Link from "next/link";
import { usePathname } from "next/navigation";

export function BreadcrumbNav() {
    const pathname = usePathname();
    const { group: selectedGroup, project: selectedProject } = useCurrentSelection();
    const showAllGroups = pathname === "/";

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
                            <BreadcrumbLink asChild className="max-w-full truncate">
                                <Link href="/">KIWI</Link>
                            </BreadcrumbLink>
                        </BreadcrumbItem>
                        <BreadcrumbSeparator className="shrink-0" />
                        <BreadcrumbItem className="min-w-0 shrink">
                            <BreadcrumbLink
                                asChild
                                className="block max-w-full truncate"
                                title={selectedGroup.name}
                            >
                                <Link href={`/${selectedGroup.id}`}>{selectedGroup.name}</Link>
                            </BreadcrumbLink>
                        </BreadcrumbItem>
                        {selectedProject && (
                            <>
                                <BreadcrumbSeparator className="shrink-0" />
                                <BreadcrumbItem className="min-w-0 shrink">
                                    <BreadcrumbPage className="block max-w-full truncate" title={selectedProject.name}>
                                        {selectedProject.name}
                                    </BreadcrumbPage>
                                </BreadcrumbItem>
                            </>
                        )}
                    </>
                ) : (
                    <BreadcrumbItem className="shrink-0">
                        <BreadcrumbLink asChild>
                            <Link href="/">KIWI</Link>
                        </BreadcrumbLink>
                    </BreadcrumbItem>
                )}
            </BreadcrumbList>
        </Breadcrumb>
    );
}
