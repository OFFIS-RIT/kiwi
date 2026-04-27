import { ProjectListView } from "@/components/projects/ProjectListView";

export default async function GroupPage({ params }: { params: Promise<{ groupId: string }> }) {
    const { groupId } = await params;

    return <ProjectListView groupId={groupId} />;
}
