import { ProjectView } from "@/components/projects/ProjectView";

type Props = {
    params: Promise<{ groupId: string; projectId: string }>;
};

export default async function ProjectPage({ params }: Props) {
    const { groupId, projectId } = await params;
    return <ProjectView groupId={groupId} projectId={projectId} />;
}
