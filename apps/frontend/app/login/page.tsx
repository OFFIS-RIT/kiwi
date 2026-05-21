import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/auth/get-server-session";
import { AuthPage } from "@/components/auth/AuthPage";
import { getSafeRedirectPath } from "@/lib/utils";

type Props = { searchParams: Promise<{ next?: string }> };

export default async function LoginPage({ searchParams }: Props) {
    const [session, { next }] = await Promise.all([getServerSession(), searchParams]);
    if (session) {
        redirect(getSafeRedirectPath(next));
    }
    return <AuthPage view="login" nextPath={next} />;
}
