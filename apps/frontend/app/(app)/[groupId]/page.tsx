import { GroupView } from "@/components/groups/GroupView";

type Props = {
    params: Promise<{ groupId: string }>;
};

export default async function GroupPage({ params }: Props) {
    const { groupId } = await params;
    return <GroupView groupId={groupId} />;
}
