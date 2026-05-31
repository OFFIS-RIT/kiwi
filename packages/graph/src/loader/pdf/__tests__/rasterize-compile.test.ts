import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, test } from "bun:test";

describe("compiled PDF rasterizer startup", () => {
    test("does not initialize pdfjs when only importing the rasterizer", async () => {
        const directory = await mkdtemp(join(tmpdir(), "kiwi-rasterize-compile-"));

        try {
            const entryPath = join(directory, "entry.ts");
            const executablePath = join(directory, "entry");
            await Bun.write(
                entryPath,
                `import ${JSON.stringify(resolve(import.meta.dir, "../rasterize.ts"))};\n`
            );

            await expectCommand([process.execPath, "build", "--compile", "--outfile", executablePath, entryPath]);
            await expectCommand([executablePath]);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
});

async function expectCommand(command: string[]): Promise<void> {
    const child = Bun.spawn(command, {
        stdout: "pipe",
        stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
    ]);

    if (code !== 0) {
        throw new Error(`${command.join(" ")} failed with exit code ${code}\n${stdout}\n${stderr}`);
    }
}
