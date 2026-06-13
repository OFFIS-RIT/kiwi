import { describe, expect, test } from "bun:test";
import { inferGraphFileType } from "../graph-file-type";

describe("inferGraphFileType", () => {
    test("detects audio files from MIME type and common extensions", () => {
        expect(inferGraphFileType(new File([""], "recording.mp3", { type: "audio/mpeg" }))).toBe("audio");
        expect(inferGraphFileType(new File([""], "recording.wav", { type: "" }))).toBe("audio");
        expect(inferGraphFileType(new File([""], "recording.webm", { type: "audio/webm" }))).toBe("audio");
        expect(inferGraphFileType(new File([""], "recording", { type: "application/ogg" }))).toBe("audio");
    });

    test("detects video files from MIME type and common extensions", () => {
        expect(inferGraphFileType(new File([""], "meeting.mp4", { type: "video/mp4" }))).toBe("video");
        expect(inferGraphFileType(new File([""], "interview.mov", { type: "" }))).toBe("video");
        expect(inferGraphFileType(new File([""], "screen-share.mkv", { type: "" }))).toBe("video");
        expect(inferGraphFileType(new File([""], "clip.webm", { type: "" }))).toBe("video");
        expect(inferGraphFileType(new File([""], "clip.ogv", { type: "" }))).toBe("video");
    });

    test("detects structured text formats without relying on MIME type", () => {
        expect(inferGraphFileType(new File([""], "export.csv", { type: "text/csv" }))).toBe("csv");
        expect(inferGraphFileType(new File([""], "feed.atom", { type: "application/atom+xml" }))).toBe("xml");
        expect(inferGraphFileType(new File([""], "config.yml", { type: "" }))).toBe("yaml");
        expect(inferGraphFileType(new File([""], "settings.toml", { type: "" }))).toBe("toml");
        expect(inferGraphFileType(new File([""], "records.jsonl", { type: "" }))).toBe("jsonl");
        expect(inferGraphFileType(new File([""], "events.ndjson", { type: "application/x-ndjson" }))).toBe("jsonl");
        expect(inferGraphFileType(new File([""], "settings.jsonc", { type: "application/jsonc" }))).toBe("jsonc");
        expect(inferGraphFileType(new File([""], "records", { type: "application/x-ndjson; charset=utf-8" }))).toBe(
            "jsonl"
        );
        expect(inferGraphFileType(new File([""], "settings", { type: "application/jsonc; charset=utf-8" }))).toBe(
            "jsonc"
        );
    });

    test("detects web email calendar and contact formats", () => {
        expect(inferGraphFileType(new File([""], "page.html", { type: "" }))).toBe("html");
        expect(inferGraphFileType(new File([""], "message.eml", { type: "" }))).toBe("email");
        expect(inferGraphFileType(new File([""], "archive.mbox", { type: "" }))).toBe("email");
        expect(inferGraphFileType(new File([""], "outlook.msg", { type: "application/vnd.ms-outlook" }))).toBe("email");
        expect(inferGraphFileType(new File([""], "invite.ics", { type: "text/calendar" }))).toBe("calendar");
        expect(inferGraphFileType(new File([""], "person.vcf", { type: "" }))).toBe("vcard");
    });
});
