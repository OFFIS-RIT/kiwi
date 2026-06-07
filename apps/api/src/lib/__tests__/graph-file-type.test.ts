import { describe, expect, test } from "bun:test";
import { inferGraphFileType } from "../graph-file-type";

describe("inferGraphFileType", () => {
    test("detects audio files from MIME type and common extensions", () => {
        expect(inferGraphFileType(new File([""], "recording.mp3", { type: "audio/mpeg" }))).toBe("audio");
        expect(inferGraphFileType(new File([""], "recording.wav", { type: "" }))).toBe("audio");
        expect(inferGraphFileType(new File([""], "recording.webm", { type: "audio/webm" }))).toBe("audio");
    });

    test("detects video files from MIME type and common extensions", () => {
        expect(inferGraphFileType(new File([""], "meeting.mp4", { type: "video/mp4" }))).toBe("video");
        expect(inferGraphFileType(new File([""], "interview.mov", { type: "" }))).toBe("video");
        expect(inferGraphFileType(new File([""], "screen-share.mkv", { type: "" }))).toBe("video");
        expect(inferGraphFileType(new File([""], "clip.webm", { type: "" }))).toBe("video");
    });

    test("detects structured text formats without relying on MIME type", () => {
        expect(inferGraphFileType(new File([""], "feed.atom", { type: "application/atom+xml" }))).toBe("xml");
        expect(inferGraphFileType(new File([""], "config.yml", { type: "" }))).toBe("yaml");
        expect(inferGraphFileType(new File([""], "settings.toml", { type: "" }))).toBe("toml");
    });
});
