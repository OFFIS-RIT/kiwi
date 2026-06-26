import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const requireFromGraph = createRequire(join(repoRoot, "packages", "graph", "package.json"));
const buildCommand = ["node-gyp", "rebuild"];
const platformTag = `${process.platform}-${process.arch}`;

type BindingPatch = {
    packageName: string;
    target: string;
    sources: string[];
};

const patches: BindingPatch[] = [
    {
        packageName: "tree-sitter",
        target: join("prebuilds", platformTag, "tree-sitter.node"),
        sources: [join("build", "Release", "tree_sitter_runtime_binding.node")],
    },
    {
        packageName: "@tree-sitter-grammars/tree-sitter-zig",
        target: join("prebuilds", platformTag, "tree-sitter-zig.node"),
        sources: [
            join("prebuilds", platformTag, "@tree-sitter-grammars+tree-sitter-zig.node"),
            join("build", "Release", "tree_sitter_zig_binding.node"),
        ],
    },
];

let repaired = false;

for (const patch of patches) {
    const packageRoot = resolvePackageRoot(patch.packageName);
    const target = join(packageRoot, patch.target);

    if (existsSync(target)) {
        continue;
    }

    let source = findSource(packageRoot, patch.sources);

    if (!source) {
        runBuild(packageRoot, patch.packageName);
        source = findSource(packageRoot, patch.sources);
    }

    if (!source) {
        throw new Error(
            [
                `Missing native binding source for ${patch.packageName} on ${platformTag}.`,
                `Expected one of: ${patch.sources.map((candidate) => relative(repoRoot, join(packageRoot, candidate))).join(", ")}`,
                'Install the system build tools required by node-gyp, then rerun `CXXFLAGS="-std=c++20" bun install --force`.',
            ].join("\n")
        );
    }

    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
    repaired = true;
    console.log(`[tree-sitter] Created ${relative(repoRoot, target)} from ${relative(repoRoot, source)}.`);
}

if (!repaired) {
    console.log(`[tree-sitter] Bun native bindings already present for ${platformTag}.`);
}

function resolvePackageRoot(packageName: string) {
    try {
        return dirname(requireFromGraph.resolve(`${packageName}/package.json`));
    } catch (error) {
        throw new Error(`Cannot resolve ${packageName} from packages/graph. Run \`bun install\` first.`, {
            cause: error,
        });
    }
}

function findSource(packageRoot: string, sources: string[]) {
    return sources.map((candidate) => join(packageRoot, candidate)).find((candidate) => existsSync(candidate));
}

function runBuild(packageRoot: string, packageName: string) {
    console.log(`[tree-sitter] Building ${packageName} native binding for ${platformTag}.`);

    const result = spawnSync(buildCommand[0], buildCommand.slice(1), {
        cwd: packageRoot,
        stdio: "inherit",
        env: { ...process.env, CXXFLAGS: process.env.CXXFLAGS ?? "-std=c++20" },
    });

    if (result.error) {
        throw result.error;
    }

    if (result.status !== 0) {
        throw new Error(`${buildCommand.join(" ")} failed for ${packageName} with exit code ${result.status}.`);
    }
}
