import { ProjectChatView } from "@/components/chat/ProjectChatView";

export default async function ProjectPage({
    params,
}: {
    params: Promise<{ groupId: string; projectId: string }>;
}) {
    const { groupId, projectId } = await params;

    return <ProjectChatView groupId={groupId} projectId={projectId} />;
}
