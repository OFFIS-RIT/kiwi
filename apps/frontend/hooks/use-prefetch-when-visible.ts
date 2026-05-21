"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

const prefetchedHrefs = new Set<string>();

type UsePrefetchWhenVisibleOptions = {
    onVisible?: () => void;
};

export function usePrefetchWhenVisible<TElement extends Element>(
    href?: string,
    options?: UsePrefetchWhenVisibleOptions
) {
    const router = useRouter();
    const elementRef = useRef<TElement | null>(null);
    const onVisibleRef = useRef(options?.onVisible);

    useEffect(() => {
        onVisibleRef.current = options?.onVisible;
    }, [options?.onVisible]);

    useEffect(() => {
        if (!href && !onVisibleRef.current) return;

        const element = elementRef.current;
        if (!element) return;

        const prefetch = () => {
            if (href && !prefetchedHrefs.has(href)) {
                prefetchedHrefs.add(href);
                router.prefetch(href);
            }
            onVisibleRef.current?.();
        };

        if (!("IntersectionObserver" in window)) {
            prefetch();
            return;
        }

        const observer = new IntersectionObserver(
            ([entry]) => {
                if (!entry?.isIntersecting) return;

                prefetch();
                observer.disconnect();
            },
            { rootMargin: "200px" }
        );

        observer.observe(element);

        return () => observer.disconnect();
    }, [href, router]);

    return elementRef;
}
