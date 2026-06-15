import { ConnectorConnectPage } from "@/components/connectors/ConnectorPages";

type Props = {
    params: Promise<{ connectorId: string }>;
};

export default async function ConnectConnectorPage({ params }: Props) {
    const { connectorId } = await params;
    return <ConnectorConnectPage connectorId={connectorId} />;
}
