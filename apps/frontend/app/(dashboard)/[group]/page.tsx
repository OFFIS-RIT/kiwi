import { ProjectListView } from "@/components/projects/ProjectListView";

export default async function GroupPage({ params }: { params: Promise<{ group: string }> }) {
    const { group } = await params;

    return <ProjectListView groupName={decodeURIComponent(group)} />;
}
