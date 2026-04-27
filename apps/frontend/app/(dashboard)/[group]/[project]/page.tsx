import { ProjectChatView } from "@/components/chat/ProjectChatView";

export default async function ProjectPage({
    params,
}: {
    params: Promise<{ group: string; project: string }>;
}) {
    const { group, project } = await params;

    return <ProjectChatView groupName={decodeURIComponent(group)} projectName={decodeURIComponent(project)} />;
}
