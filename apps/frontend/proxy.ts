import { NextResponse, type NextRequest } from "next/server";

export function proxy(request: NextRequest) {
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set("x-pathname", `${request.nextUrl.pathname}${request.nextUrl.search}`);

    return NextResponse.next({
        request: {
            headers: requestHeaders,
        },
    });
}

export const config = {
    matcher: ["/((?!api|_next/static|_next/image|favicon.ico|KIWI.jpg).*)"],
};
