import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/auth/get-server-session";
import { LoginForm } from "@/components/auth/LoginForm";

type Props = { searchParams: Promise<{ next?: string }> };

export default async function LoginPage({ searchParams }: Props) {
    const [session, { next }] = await Promise.all([getServerSession(), searchParams]);
    if (session) {
        const safeNext = next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
        redirect(safeNext);
    }
    return <LoginForm nextPath={next} />;
}
