import { describe, expect, test } from "bun:test";
import { inferGraphFileType } from "../file-type";

function file(name: string, type = "") {
    return { name, type } as File;
}

describe("inferGraphFileType", () => {
    test("classifies supported source paths as code", () => {
        expect(inferGraphFileType(file("src/index.ts"))).toBe("code");
        expect(inferGraphFileType(file("src/component.tsx"))).toBe("code");
        expect(inferGraphFileType(file("src/script.js"))).toBe("code");
        expect(inferGraphFileType(file("src/lib.rs"))).toBe("code");
        expect(inferGraphFileType(file("src/LIB.RS"))).toBe("code");
        expect(inferGraphFileType(file("src/main.zig"))).toBe("code");
        expect(inferGraphFileType(file("src/MAIN.ZIG"))).toBe("code");
        expect(inferGraphFileType(file("src/main.c"))).toBe("code");
        expect(inferGraphFileType(file("src/math.h"))).toBe("code");
        expect(inferGraphFileType(file("src/MATH.H"))).toBe("code");
    });

    test("keeps text and structured formats out of code classification", () => {
        expect(inferGraphFileType(file("README.md"))).toBe("text");
        expect(inferGraphFileType(file("data.json", "application/json"))).toBe("json");
    });
});
