import { Effect } from "effect";
import JSZip from "jszip";
import type { ContentTypes, Relationships } from "./types";
import { findDescendants, getAttribute, getDocumentRoot, parseXml, parseXmlEffect } from "./xml";

export function loadOOXMLZipEffect(content: ArrayBuffer): Effect.Effect<JSZip, unknown> {
    return Effect.tryPromise({
        try: () => JSZip.loadAsync(content),
        catch: (error) => error,
    });
}

export function readZipTextEffect(zip: JSZip, path: string): Effect.Effect<string | null, unknown> {
    const normalizedPath = cleanZipPath(path);
    if (!isSafeZipPath(normalizedPath)) {
        return Effect.succeed(null);
    }

    return Effect.tryPromise({
        try: async () => zip.file(normalizedPath)?.async("text") ?? null,
        catch: (error) => error,
    });
}

export function readZipBinaryEffect(zip: JSZip, path: string): Effect.Effect<Uint8Array | null, unknown> {
    const normalizedPath = cleanZipPath(path);
    if (!isSafeZipPath(normalizedPath)) {
        return Effect.succeed(null);
    }

    return Effect.tryPromise({
        try: async () => zip.file(normalizedPath)?.async("uint8array") ?? null,
        catch: (error) => error,
    });
}

export function getRelationshipsForPartEffect(zip: JSZip, partPath: string): Effect.Effect<Relationships, unknown> {
    return Effect.gen(function* () {
        const relationships: Relationships = new Map();
        const relsXml = yield* readZipTextEffect(zip, getRelationshipsPath(partPath));
        if (!relsXml) {
            return relationships;
        }

        const document = yield* parseXmlEffect(relsXml);
        const root = getDocumentRoot(document);
        if (!root) {
            return relationships;
        }

        for (const relationship of findDescendants(root, "Relationship")) {
            const id = getAttribute(relationship, "Id");
            const target = getAttribute(relationship, "Target");
            const targetMode = getAttribute(relationship, "TargetMode");
            if (!id || !target) {
                continue;
            }

            const external = targetMode === "External" || isExternalTarget(target);
            if (external) {
                relationships.set(id, { target, external: true });
                continue;
            }

            const resolved = resolveZipPath(getDirectoryPath(partPath), target);
            if (resolved) {
                relationships.set(id, { target: resolved, external: false });
            }
        }

        return relationships;
    });
}

export function parseContentTypes(xml: string | null): ContentTypes {
    const defaults = new Map<string, string>();
    const overrides = new Map<string, string>();
    if (!xml) {
        return { defaults, overrides };
    }

    const document = parseXml(xml);
    const root = getDocumentRoot(document);
    if (!root) {
        return { defaults, overrides };
    }

    for (const node of findDescendants(root, "Default")) {
        const extension = getAttribute(node, "Extension");
        const contentType = getAttribute(node, "ContentType");
        if (extension && contentType) {
            defaults.set(extension.toLowerCase(), contentType);
        }
    }

    for (const node of findDescendants(root, "Override")) {
        const partName = getAttribute(node, "PartName");
        const contentType = getAttribute(node, "ContentType");
        if (partName && contentType) {
            overrides.set(cleanZipPath(partName), contentType);
        }
    }

    return { defaults, overrides };
}

export function parseContentTypesEffect(xml: string | null): Effect.Effect<ContentTypes, unknown> {
    return Effect.try({
        try: () => parseContentTypes(xml),
        catch: (error) => error,
    });
}

export function getMimeTypeForPath(contentTypes: ContentTypes, path: string): string {
    const normalizedPath = cleanZipPath(path);
    const override = contentTypes.overrides.get(normalizedPath);
    if (override) {
        return override;
    }

    const extension = normalizedPath.split(".").at(-1)?.toLowerCase();
    if (extension) {
        const fromDefaults = contentTypes.defaults.get(extension);
        if (fromDefaults) {
            return fromDefaults;
        }
    }

    switch (extension) {
        case "png":
            return "image/png";
        case "jpg":
        case "jpeg":
            return "image/jpeg";
        case "gif":
            return "image/gif";
        case "bmp":
            return "image/bmp";
        case "svg":
            return "image/svg+xml";
        case "tif":
        case "tiff":
            return "image/tiff";
        case "webp":
            return "image/webp";
        default:
            return "application/octet-stream";
    }
}

export function createImageIdFactory(): () => string {
    let imageCounter = 0;
    return () => {
        imageCounter += 1;
        return `img-${imageCounter}`;
    };
}

export function getRelationshipsPath(partPath: string): string {
    const directory = getDirectoryPath(partPath);
    const filename = partPath.split("/").at(-1) ?? partPath;
    return directory ? `${directory}/_rels/${filename}.rels` : `_rels/${filename}.rels`;
}

export function getDirectoryPath(path: string): string {
    const parts = cleanZipPath(path).split("/");
    parts.pop();
    return parts.join("/");
}

export function resolveZipPath(basePath: string, target: string): string | null {
    if (isExternalTarget(target)) {
        return null;
    }

    if (target.startsWith("/")) {
        const absolutePath = cleanZipPath(target);
        return isSafeZipPath(absolutePath) ? absolutePath : null;
    }

    const initialParts = basePath ? cleanZipPath(basePath).split("/").filter(Boolean) : [];
    const targetParts = target.replace(/\\/g, "/").split("/");
    const parts = [...initialParts];

    for (const part of targetParts) {
        if (!part || part === ".") {
            continue;
        }

        if (part === "..") {
            if (parts.length === 0) {
                return null;
            }

            parts.pop();
            continue;
        }

        parts.push(part);
    }

    const resolved = parts.join("/");
    return isSafeZipPath(resolved) ? resolved : null;
}

export function cleanZipPath(path: string): string {
    return path.replace(/^\/+/, "").replace(/\\/g, "/");
}

export function isExternalTarget(target: string): boolean {
    return /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//");
}

export function isSafeZipPath(path: string): boolean {
    const normalized = cleanZipPath(path);
    if (!normalized || normalized.startsWith("/") || isExternalTarget(normalized)) {
        return false;
    }

    return normalized.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}
