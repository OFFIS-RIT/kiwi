import { describe, expect, test } from "bun:test";
import { dedupe } from "../../dedupe";
import { mergeGraphs } from "../../merge";
import { buildCodeFileGraph, buildCodeRepositoryManifest, type CodeRepositoryFile } from "../repository";

const baseFile = (input: { fileId: string; path: string; content: string }): CodeRepositoryFile => ({
    fileId: input.fileId,
    repositoryUrl: "https://github.com/acme/widgets.git",
    repositoryName: "widgets",
    commitSha: "commit-1",
    path: input.path,
    content: input.content,
});
const repositoryPrefix = "https://github.com/acme/widgets.git";

function relationshipKinds(graph: ReturnType<typeof buildCodeFileGraph>) {
    return graph.relationships.map((relationship) => relationship.kind).sort();
}

function entityByName(graph: ReturnType<typeof buildCodeFileGraph>, name: string) {
    return graph.entities.find((entity) => entity.name === name);
}

function hasRelationship(
    graph: ReturnType<typeof buildCodeFileGraph>,
    kind: string,
    sourceName: string,
    targetName: string
) {
    const source = entityByName(graph, sourceName);
    const target = entityByName(graph, targetName);
    return graph.relationships.some(
        (relationship) =>
            relationship.kind === kind && relationship.sourceId === source?.id && relationship.targetId === target?.id
    );
}
function relationshipCount(
    graph: ReturnType<typeof buildCodeFileGraph>,
    kind: string,
    sourceName: string,
    targetName: string
) {
    const source = entityByName(graph, sourceName);
    const target = entityByName(graph, targetName);
    return graph.relationships.filter(
        (relationship) =>
            relationship.kind === kind && relationship.sourceId === source?.id && relationship.targetId === target?.id
    ).length;
}

describe("code repository graph builder", () => {
    test("builds code entities, directed relationships, and source metadata from TypeScript AST", () => {
        const helper = baseFile({
            fileId: "file-helper",
            path: "src/helper.ts",
            content: "export function helper() {\n  return 1;\n}\n",
        });
        const index = baseFile({
            fileId: "file-index",
            path: "src/index.ts",
            content: [
                "import { helper } from './helper';",
                "class Base {}",
                "interface Runnable { run(): number }",
                "export class Runner extends Base implements Runnable {",
                "  run() {",
                "    return helper();",
                "  }",
                "}",
                "export const makeRunner = () => new Runner();",
                "export type RunnerId = string;",
            ].join("\n"),
        });
        const manifest = buildCodeRepositoryManifest([helper, index]);

        const graph = buildCodeFileGraph(index, manifest);

        expect(graph.entities.map((entity) => [entity.type, entity.name]).sort()).toContainEqual([
            "CODE_FILE",
            `${repositoryPrefix}:src/index.ts`,
        ]);
        expect(graph.entities.map((entity) => [entity.type, entity.name]).sort()).toContainEqual([
            "CODE_CLASS",
            `${repositoryPrefix}:src/index.ts#Runner`,
        ]);
        expect(graph.entities.map((entity) => [entity.type, entity.name]).sort()).toContainEqual([
            "CODE_INTERFACE",
            `${repositoryPrefix}:src/index.ts#Runnable`,
        ]);
        expect(graph.entities.map((entity) => [entity.type, entity.name]).sort()).toContainEqual([
            "CODE_FUNCTION",
            `${repositoryPrefix}:src/index.ts#makeRunner`,
        ]);
        expect(graph.entities.map((entity) => [entity.type, entity.name]).sort()).toContainEqual([
            "CODE_TYPE",
            `${repositoryPrefix}:src/index.ts#RunnerId`,
        ]);
        expect(graph.entities.map((entity) => [entity.type, entity.name]).sort()).toContainEqual([
            "CODE_FUNCTION",
            `${repositoryPrefix}:src/helper.ts#helper`,
        ]);
        expect(relationshipKinds(graph)).toContain("IMPORTS");
        expect(relationshipKinds(graph)).toContain("CALLS");
        expect(relationshipKinds(graph)).toContain("CONTAINS");
        expect(relationshipKinds(graph)).toContain("EXTENDS");
        expect(relationshipKinds(graph)).toContain("IMPLEMENTS");
        expect(graph.relationships.every((relationship) => relationship.directed === true)).toBe(true);

        const runEntity = graph.entities.find(
            (entity) => entity.name === `${repositoryPrefix}:src/index.ts#Runner.run`
        );
        expect(runEntity).toBeDefined();
        const runChunk = runEntity?.sources
            .map((source) => graph.units.find((unit) => unit.id === source.unitId)?.chunks[0])
            .find(Boolean);
        expect(runChunk).toMatchObject({
            type: "text",
            filePath: "src/index.ts",
            language: "typescript",
            startLine: 5,
            endLine: 7,
        });
        expect(runChunk?.text).toContain("run() {");
        expect(runChunk?.text).toContain("helper()");
        expect(
            hasRelationship(
                graph,
                "CALLS",
                `${repositoryPrefix}:src/index.ts#Runner.run`,
                `${repositoryPrefix}:src/helper.ts#helper`
            )
        ).toBe(true);
    });

    test("keeps named import resolution when reading manifests without explicit exports", () => {
        const helper = baseFile({
            fileId: "file-legacy-helper",
            path: "src/helper.ts",
            content: "export function helper() { return 1; }\n",
        });
        const consumer = baseFile({
            fileId: "file-legacy-consumer",
            path: "src/legacy-consumer.ts",
            content: "import { helper } from './helper';\nexport function run() { return helper(); }\n",
        });
        const manifest = buildCodeRepositoryManifest([helper, consumer]);
        const legacyManifest = { ...manifest };
        delete (legacyManifest as typeof legacyManifest & { exports?: unknown }).exports;

        const graph = buildCodeFileGraph(consumer, legacyManifest as typeof manifest);

        expect(
            hasRelationship(
                graph,
                "CALLS",
                `${repositoryPrefix}:src/legacy-consumer.ts#run`,
                `${repositoryPrefix}:src/helper.ts#helper`
            )
        ).toBe(true);
    });

    test("resolves index imports inside repository manifests", () => {
        const dependency = baseFile({
            fileId: "file-module",
            path: "src/lib/index.ts",
            content: "export function dependency() { return 1; }\n",
        });
        const consumer = baseFile({
            fileId: "file-consumer",
            path: "src/consumer.ts",
            content: "import { dependency } from './lib';\nexport function consumer() { return dependency(); }\n",
        });
        const manifest = buildCodeRepositoryManifest([dependency, consumer]);

        const graph = buildCodeFileGraph(consumer, manifest);

        const dependencyEntity = graph.entities.find(
            (entity) => entity.name === `${repositoryPrefix}:src/lib/index.ts#dependency`
        );
        const consumerEntity = graph.entities.find(
            (entity) => entity.name === `${repositoryPrefix}:src/consumer.ts#consumer`
        );
        expect(dependencyEntity).toBeDefined();
        expect(consumerEntity).toBeDefined();
        expect(
            graph.relationships.some(
                (relationship) =>
                    relationship.kind === "CALLS" &&
                    relationship.sourceId === consumerEntity?.id &&
                    relationship.targetId === dependencyEntity?.id
            )
        ).toBe(true);
    });
    test("resolves default namespace and barrel imports across files", () => {
        const defaultHelper = baseFile({
            fileId: "file-default-helper",
            path: "src/default-helper.ts",
            content: "const helper = () => 1;\nexport default helper;\n",
        });
        const helpers = baseFile({
            fileId: "file-helpers",
            path: "src/helpers.ts",
            content: "export function add() { return 1; }\n",
        });
        const barrel = baseFile({
            fileId: "file-barrel",
            path: "src/lib/index.ts",
            content: "export { add } from '../helpers';\n",
        });
        const consumer = baseFile({
            fileId: "file-default-consumer",
            path: "src/default-consumer.ts",
            content: [
                "import helper from './default-helper';",
                "import * as helpers from './helpers';",
                "import { add as addFromBarrel } from './lib';",
                "export function run() {",
                "  return helper() + helpers.add() + addFromBarrel();",
                "}",
            ].join("\n"),
        });
        const manifest = buildCodeRepositoryManifest([defaultHelper, helpers, barrel, consumer]);
        const graph = buildCodeFileGraph(consumer, manifest);

        expect(
            hasRelationship(
                graph,
                "CALLS",
                `${repositoryPrefix}:src/default-consumer.ts#run`,
                `${repositoryPrefix}:src/default-helper.ts#helper`
            )
        ).toBe(true);
        expect(
            relationshipCount(
                graph,
                "CALLS",
                `${repositoryPrefix}:src/default-consumer.ts#run`,
                `${repositoryPrefix}:src/helpers.ts#add`
            )
        ).toBe(2);
        expect(
            hasRelationship(
                graph,
                "IMPORTS",
                `${repositoryPrefix}:src/default-consumer.ts`,
                `${repositoryPrefix}:src/lib/index.ts`
            )
        ).toBe(true);
    });

    test("resolves explicit extensions export-star barrels and default reexports", () => {
        const defaultHelper = baseFile({
            fileId: "file-default-helper-declaration",
            path: "src/default-helper.ts",
            content: "export default function helper() { return 1; }\n",
        });
        const shared = baseFile({
            fileId: "file-shared",
            path: "src/shared.ts",
            content: "export function sharedHelper() { return 1; }\n",
        });
        const barrel = baseFile({
            fileId: "file-export-star-barrel",
            path: "src/lib/index.ts",
            content: ["export { default as helper } from '../default-helper';", "export * from '../shared';"].join(
                "\n"
            ),
        });
        const consumer = baseFile({
            fileId: "file-explicit-extension-consumer",
            path: "src/use-barrel.ts",
            content: [
                "import { helper, sharedHelper } from './lib/index.ts';",
                "export function run() {",
                "  return helper() + sharedHelper();",
                "}",
            ].join("\n"),
        });
        const manifest = buildCodeRepositoryManifest([defaultHelper, shared, barrel, consumer]);
        const graph = buildCodeFileGraph(consumer, manifest);

        expect(
            hasRelationship(
                graph,
                "CALLS",
                `${repositoryPrefix}:src/use-barrel.ts#run`,
                `${repositoryPrefix}:src/default-helper.ts#helper`
            )
        ).toBe(true);
        expect(
            hasRelationship(
                graph,
                "CALLS",
                `${repositoryPrefix}:src/use-barrel.ts#run`,
                `${repositoryPrefix}:src/shared.ts#sharedHelper`
            )
        ).toBe(true);
    });
    test("resolves non-relative package imports to external symbols", () => {
        const consumer = baseFile({
            fileId: "file-external-consumer",
            path: "src/external-consumer.ts",
            content: [
                "import { debounce as delay } from 'lodash';",
                "import * as React from 'react';",
                "export function run() {",
                "  delay();",
                "  return React.useMemo(() => 1, []);",
                "}",
            ].join("\n"),
        });
        const manifest = buildCodeRepositoryManifest([consumer]);
        const graph = buildCodeFileGraph(consumer, manifest);

        expect(
            hasRelationship(
                graph,
                "CALLS",
                `${repositoryPrefix}:src/external-consumer.ts#run`,
                "widgets:external:lodash#debounce"
            )
        ).toBe(true);
        expect(
            hasRelationship(
                graph,
                "CALLS",
                `${repositoryPrefix}:src/external-consumer.ts#run`,
                "widgets:external:react#useMemo"
            )
        ).toBe(true);
        expect(
            hasRelationship(graph, "IMPORTS", `${repositoryPrefix}:src/external-consumer.ts`, "widgets:external:lodash")
        ).toBe(true);
        expect(
            hasRelationship(graph, "IMPORTS", `${repositoryPrefix}:src/external-consumer.ts`, "widgets:external:react")
        ).toBe(true);
    });
    test("prefers local definitions over imported ones when names overlap", () => {
        const helper = baseFile({
            fileId: "file-shadow-helper",
            path: "src/helper.ts",
            content: "export function helper() { return 1; }\n",
        });
        const consumer = baseFile({
            fileId: "file-shadow-consumer",
            path: "src/shadow.ts",
            content: [
                "import { helper } from './helper';",
                "export function helperLocal() { return 2; }",
                "export function run() {",
                "  return helperLocal();",
                "}",
            ].join("\n"),
        });
        const manifest = buildCodeRepositoryManifest([helper, consumer]);
        const graph = buildCodeFileGraph(consumer, manifest);

        expect(
            hasRelationship(
                graph,
                "CALLS",
                `${repositoryPrefix}:src/shadow.ts#run`,
                `${repositoryPrefix}:src/shadow.ts#helperLocal`
            )
        ).toBe(true);
        expect(
            hasRelationship(
                graph,
                "CALLS",
                `${repositoryPrefix}:src/shadow.ts#run`,
                `${repositoryPrefix}:src/helper.ts#helper`
            )
        ).toBe(false);
    });

    test("resolves external default imports as callable symbols", () => {
        const consumer = baseFile({
            fileId: "file-external-default-consumer",
            path: "src/external-default.ts",
            content: ["import nanoid from 'nanoid';", "export function run() {", "  return nanoid();", "}"].join("\n"),
        });
        const manifest = buildCodeRepositoryManifest([consumer]);
        const graph = buildCodeFileGraph(consumer, manifest);

        expect(
            hasRelationship(
                graph,
                "CALLS",
                `${repositoryPrefix}:src/external-default.ts#run`,
                "widgets:external:nanoid#default"
            )
        ).toBe(true);
    });

    test("resolves member calls on external default imports", () => {
        const consumer = baseFile({
            fileId: "file-external-default-member-consumer",
            path: "src/external-default-member.ts",
            content: [
                "import React from 'react';",
                "export function run() {",
                "  return React.useMemo(() => 1, []);",
                "}",
            ].join("\n"),
        });
        const manifest = buildCodeRepositoryManifest([consumer]);
        const graph = buildCodeFileGraph(consumer, manifest);

        expect(
            hasRelationship(
                graph,
                "CALLS",
                `${repositoryPrefix}:src/external-default-member.ts#run`,
                "widgets:external:react#useMemo"
            )
        ).toBe(true);
    });

    test("keeps nested namespace member paths for external modules", () => {
        const consumer = baseFile({
            fileId: "file-external-namespace-consumer",
            path: "src/external-namespace.ts",
            content: [
                "import * as React from 'react';",
                "export function run() {",
                "  return React.Children.only(null);",
                "}",
            ].join("\n"),
        });
        const manifest = buildCodeRepositoryManifest([consumer]);
        const graph = buildCodeFileGraph(consumer, manifest);

        expect(
            hasRelationship(
                graph,
                "CALLS",
                `${repositoryPrefix}:src/external-namespace.ts#run`,
                "widgets:external:react#Children.only"
            )
        ).toBe(true);
    });

    test("resolves Rust fully qualified calls into nested modules", () => {
        const mathRoot = baseFile({
            fileId: "file-rust-qualified-root",
            path: "src/math/mod.rs",
            content: "pub mod nested;\n",
        });
        const nestedMath = baseFile({
            fileId: "file-rust-qualified-nested-module",
            path: "src/math/nested.rs",
            content: "pub fn add() -> i32 { 1 }\n",
        });
        const main = baseFile({
            fileId: "file-rust-qualified-main",
            path: "src/main.rs",
            content: ["mod math;", "pub fn run() -> i32 {", "  crate::math::nested::add()", "}"].join("\n"),
        });
        const manifest = buildCodeRepositoryManifest([mathRoot, nestedMath, main]);
        const graph = buildCodeFileGraph(main, manifest);

        expect(
            hasRelationship(
                graph,
                "CALLS",
                `${repositoryPrefix}:src/main.rs#run`,
                `${repositoryPrefix}:src/math/nested.rs#add`
            )
        ).toBe(true);
    });

    test("resolves Rust aliased module paths into nested modules", () => {
        const mathRoot = baseFile({
            fileId: "file-rust-alias-root",
            path: "src/math/mod.rs",
            content: "pub mod nested;\n",
        });
        const nestedMath = baseFile({
            fileId: "file-rust-alias-nested-module",
            path: "src/math/nested.rs",
            content: "pub fn add() -> i32 { 1 }\n",
        });
        const main = baseFile({
            fileId: "file-rust-alias-main",
            path: "src/main.rs",
            content: [
                "mod math;",
                "use crate::math as helpers;",
                "pub fn run() -> i32 {",
                "  helpers::nested::add()",
                "}",
            ].join("\n"),
        });
        const manifest = buildCodeRepositoryManifest([mathRoot, nestedMath, main]);
        const graph = buildCodeFileGraph(main, manifest);

        expect(
            hasRelationship(
                graph,
                "CALLS",
                `${repositoryPrefix}:src/main.rs#run`,
                `${repositoryPrefix}:src/math/nested.rs#add`
            )
        ).toBe(true);
    });

    test("keeps nested external Zig symbol paths", () => {
        const main = baseFile({
            fileId: "file-zig-std-mem-main",
            path: "src/std-mem.zig",
            content: [
                'const std = @import("std");',
                "pub fn run() bool {",
                '  return std.mem.eql(u8, "a", "b");',
                "}",
            ].join("\n"),
        });
        const manifest = buildCodeRepositoryManifest([main]);
        const graph = buildCodeFileGraph(main, manifest);

        expect(
            hasRelationship(graph, "CALLS", `${repositoryPrefix}:src/std-mem.zig#run`, "widgets:external:std#mem.eql")
        ).toBe(true);
    });

    test("avoids ambiguous system include call resolution", () => {
        const main = baseFile({
            fileId: "file-c-ambiguous-system-main",
            path: "src/ambiguous-stdio.c",
            content: ["#include <stdio.h>", "#include <string.h>", 'int run(void) { return printf("hi"); }'].join("\n"),
        });
        const manifest = buildCodeRepositoryManifest([main]);
        const graph = buildCodeFileGraph(main, manifest);

        expect(
            graph.relationships.some(
                (relationship) =>
                    relationship.kind === "CALLS" &&
                    relationship.sourceId === entityByName(graph, `${repositoryPrefix}:src/ambiguous-stdio.c#run`)?.id
            )
        ).toBe(false);
    });

    test("prefers local C declarations over wildcard external includes", () => {
        const main = baseFile({
            fileId: "file-c-local-over-external-main",
            path: "src/local-over-external.c",
            content: ["#include <stdio.h>", "int printf(void);", "int run(void) { return printf(); }"].join("\n"),
        });
        const manifest = buildCodeRepositoryManifest([main]);
        const graph = buildCodeFileGraph(main, manifest);

        expect(
            hasRelationship(
                graph,
                "CALLS",
                `${repositoryPrefix}:src/local-over-external.c#run`,
                `${repositoryPrefix}:src/local-over-external.c#printf`
            )
        ).toBe(true);
        expect(
            hasRelationship(
                graph,
                "CALLS",
                `${repositoryPrefix}:src/local-over-external.c#run`,
                "widgets:external:stdio.h#printf"
            )
        ).toBe(false);
    });

    test("resolves Rust fully qualified calls without aliases", () => {
        const math = baseFile({
            fileId: "file-rust-qualified-math",
            path: "src/math.rs",
            content: "pub fn add() -> i32 { 1 }\n",
        });
        const nested = baseFile({
            fileId: "file-rust-qualified-nested",
            path: "src/nested/mod.rs",
            content: ["pub fn run() -> i32 {", "  crate::math::add() + super::math::add()", "}"].join("\n"),
        });
        const manifest = buildCodeRepositoryManifest([math, nested]);
        const graph = buildCodeFileGraph(nested, manifest);

        expect(
            relationshipCount(
                graph,
                "CALLS",
                `${repositoryPrefix}:src/nested/mod.rs#run`,
                `${repositoryPrefix}:src/math.rs#add`
            )
        ).toBe(2);
    });

    test("resolves Zig package imports to external symbols", () => {
        const main = baseFile({
            fileId: "file-zig-std-main",
            path: "src/std-main.zig",
            content: ['const std = @import("std");', "pub fn run() void {", '  std.debug.print("hi", .{});', "}"].join(
                "\n"
            ),
        });
        const manifest = buildCodeRepositoryManifest([main]);
        const graph = buildCodeFileGraph(main, manifest);

        expect(
            hasRelationship(
                graph,
                "CALLS",
                `${repositoryPrefix}:src/std-main.zig#run`,
                "widgets:external:std#debug.print"
            )
        ).toBe(true);
        expect(hasRelationship(graph, "IMPORTS", `${repositoryPrefix}:src/std-main.zig`, "widgets:external:std")).toBe(
            true
        );
    });

    test("resolves C system includes to external symbols", () => {
        const main = baseFile({
            fileId: "file-c-stdio-main",
            path: "src/stdio-main.c",
            content: '#include <stdio.h>\nint run(void) { printf("hi"); return 0; }\n',
        });
        const manifest = buildCodeRepositoryManifest([main]);
        const graph = buildCodeFileGraph(main, manifest);

        expect(
            hasRelationship(
                graph,
                "CALLS",
                `${repositoryPrefix}:src/stdio-main.c#run`,
                "widgets:external:stdio.h#printf"
            )
        ).toBe(true);
        expect(
            hasRelationship(graph, "IMPORTS", `${repositoryPrefix}:src/stdio-main.c`, "widgets:external:stdio.h")
        ).toBe(true);
    });

    test("resolves Rust imports and module calls across files", () => {
        const math = baseFile({
            fileId: "file-rust-math",
            path: "src/math.rs",
            content: "pub fn add() -> i32 { 1 }\n",
        });
        const main = baseFile({
            fileId: "file-rust-main",
            path: "src/main.rs",
            content: ["mod math;", "use crate::math::add;", "pub fn run() -> i32 {", "  add() + math::add()", "}"].join(
                "\n"
            ),
        });
        const manifest = buildCodeRepositoryManifest([math, main]);
        const graph = buildCodeFileGraph(main, manifest);

        expect(
            relationshipCount(
                graph,
                "CALLS",
                `${repositoryPrefix}:src/main.rs#run`,
                `${repositoryPrefix}:src/math.rs#add`
            )
        ).toBe(2);
        expect(
            hasRelationship(graph, "IMPORTS", `${repositoryPrefix}:src/main.rs`, `${repositoryPrefix}:src/math.rs`)
        ).toBe(true);
    });

    test("resolves Rust aliases super paths and modrs modules", () => {
        const rootMath = baseFile({
            fileId: "file-rust-root-math",
            path: "src/math/mod.rs",
            content: "pub fn add() -> i32 { 1 }\n",
        });
        const shared = baseFile({
            fileId: "file-rust-shared",
            path: "src/shared.rs",
            content: "pub fn scale() -> i32 { 2 }\n",
        });
        const nested = baseFile({
            fileId: "file-rust-nested",
            path: "src/nested/mod.rs",
            content: [
                "use crate::math as helpers;",
                "use super::shared::{scale as shared_scale};",
                "pub fn run() -> i32 {",
                "  helpers::add() + shared_scale()",
                "}",
            ].join("\n"),
        });
        const manifest = buildCodeRepositoryManifest([rootMath, shared, nested]);
        const graph = buildCodeFileGraph(nested, manifest);
        const runEntity = entityByName(graph, `${repositoryPrefix}:src/nested/mod.rs#run`);
        const runChunk = runEntity?.sources
            .map((source) => graph.units.find((unit) => unit.id === source.unitId)?.chunks[0])
            .find(Boolean);

        expect(
            hasRelationship(
                graph,
                "CALLS",
                `${repositoryPrefix}:src/nested/mod.rs#run`,
                `${repositoryPrefix}:src/math/mod.rs#add`
            )
        ).toBe(true);
        expect(
            hasRelationship(
                graph,
                "CALLS",
                `${repositoryPrefix}:src/nested/mod.rs#run`,
                `${repositoryPrefix}:src/shared.rs#scale`
            )
        ).toBe(true);
        expect(runChunk?.language).toBe("rust");
    });

    test("resolves Zig imports across files", () => {
        const helpers = baseFile({
            fileId: "file-zig-helpers",
            path: "src/helpers.zig",
            content: "pub fn add() i32 { return 1; }\n",
        });
        const main = baseFile({
            fileId: "file-zig-main",
            path: "src/main.zig",
            content: [
                'const helpers = @import("helpers.zig");',
                "pub fn run() i32 {",
                "  return helpers.add();",
                "}",
            ].join("\n"),
        });
        const manifest = buildCodeRepositoryManifest([helpers, main]);
        const graph = buildCodeFileGraph(main, manifest);
        const runEntity = entityByName(graph, `${repositoryPrefix}:src/main.zig#run`);
        const runChunk = runEntity?.sources
            .map((source) => graph.units.find((unit) => unit.id === source.unitId)?.chunks[0])
            .find(Boolean);

        expect(
            hasRelationship(
                graph,
                "CALLS",
                `${repositoryPrefix}:src/main.zig#run`,
                `${repositoryPrefix}:src/helpers.zig#add`
            )
        ).toBe(true);
        expect(runChunk?.language).toBe("zig");
    });

    test("resolves Zig parent-relative imports", () => {
        const helpers = baseFile({
            fileId: "file-zig-parent-helpers",
            path: "src/helpers.zig",
            content: "pub fn add() i32 { return 1; }\n",
        });
        const main = baseFile({
            fileId: "file-zig-parent-main",
            path: "src/app/main.zig",
            content: [
                'const helpers = @import("../helpers.zig");',
                "pub fn run() i32 {",
                "  return helpers.add();",
                "}",
            ].join("\n"),
        });
        const manifest = buildCodeRepositoryManifest([helpers, main]);
        const graph = buildCodeFileGraph(main, manifest);

        expect(
            hasRelationship(
                graph,
                "CALLS",
                `${repositoryPrefix}:src/app/main.zig#run`,
                `${repositoryPrefix}:src/helpers.zig#add`
            )
        ).toBe(true);
    });

    test("resolves C header includes across files", () => {
        const header = baseFile({
            fileId: "file-c-header",
            path: "src/math.h",
            content: "int add(int left, int right);\n",
        });
        const main = baseFile({
            fileId: "file-c-main",
            path: "src/main.c",
            content: '#include "math.h"\nint run(void) { return add(1, 2); }\n',
        });
        const manifest = buildCodeRepositoryManifest([header, main]);
        const graph = buildCodeFileGraph(main, manifest);
        const runEntity = entityByName(graph, `${repositoryPrefix}:src/main.c#run`);
        const runChunk = runEntity?.sources
            .map((source) => graph.units.find((unit) => unit.id === source.unitId)?.chunks[0])
            .find(Boolean);

        expect(
            hasRelationship(graph, "CALLS", `${repositoryPrefix}:src/main.c#run`, `${repositoryPrefix}:src/math.h#add`)
        ).toBe(true);
        expect(
            hasRelationship(graph, "IMPORTS", `${repositoryPrefix}:src/main.c`, `${repositoryPrefix}:src/math.h`)
        ).toBe(true);
        expect(runChunk?.language).toBe("c");
    });

    test("resolves parent-relative C header includes", () => {
        const header = baseFile({
            fileId: "file-c-nested-header",
            path: "src/include/math.h",
            content: "int add(int left, int right);\n",
        });
        const main = baseFile({
            fileId: "file-c-nested-main",
            path: "src/app/main.c",
            content: '#include "../include/math.h"\nint run(void) { return add(1, 2); }\n',
        });
        const manifest = buildCodeRepositoryManifest([header, main]);
        const graph = buildCodeFileGraph(main, manifest);

        expect(
            hasRelationship(
                graph,
                "CALLS",
                `${repositoryPrefix}:src/app/main.c#run`,
                `${repositoryPrefix}:src/include/math.h#add`
            )
        ).toBe(true);
    });

    test("keeps same-named functions in different modules distinct after merge and dedupe", () => {
        const alpha = baseFile({
            fileId: "file-alpha",
            path: "src/alpha/math.ts",
            content: "export function normalize() { return 'alpha'; }\n",
        });
        const beta = baseFile({
            fileId: "file-beta",
            path: "src/beta/math.ts",
            content: "export function normalize() { return 'beta'; }\n",
        });
        const manifest = buildCodeRepositoryManifest([alpha, beta]);

        const graph = dedupe(mergeGraphs([buildCodeFileGraph(alpha, manifest), buildCodeFileGraph(beta, manifest)]));

        expect(
            graph.entities
                .filter((entity) => entity.type === "CODE_FUNCTION" && entity.name.endsWith("#normalize"))
                .map((entity) => entity.name)
                .sort()
        ).toEqual([
            `${repositoryPrefix}:src/alpha/math.ts#normalize`,
            `${repositoryPrefix}:src/beta/math.ts#normalize`,
        ]);
    });

    test("keeps same repository names from different URLs distinct after dedupe", () => {
        const left = baseFile({
            fileId: "file-left",
            path: "src/math.ts",
            content: "export function normalize() { return 'left'; }\n",
        });
        const right = {
            ...baseFile({
                fileId: "file-right",
                path: "src/math.ts",
                content: "export function normalize() { return 'right'; }\n",
            }),
            repositoryUrl: "https://gitlab.com/acme/widgets.git",
        };
        const manifest = buildCodeRepositoryManifest([left, right]);

        const graph = dedupe(mergeGraphs([buildCodeFileGraph(left, manifest), buildCodeFileGraph(right, manifest)]));

        expect(
            graph.entities
                .filter((entity) => entity.type === "CODE_FUNCTION" && entity.name.endsWith("src/math.ts#normalize"))
                .map((entity) => entity.name)
                .sort()
        ).toEqual([
            "https://github.com/acme/widgets.git:src/math.ts#normalize",
            "https://gitlab.com/acme/widgets.git:src/math.ts#normalize",
        ]);
    });

    test("returns an empty graph for unsupported code paths", () => {
        const file = baseFile({ fileId: "file-readme", path: "README.md", content: "# docs" });
        const graph = buildCodeFileGraph(file, buildCodeRepositoryManifest([file]));

        expect(graph.units).toEqual([]);
        expect(graph.entities).toEqual([]);
        expect(graph.relationships).toEqual([]);
    });
});
