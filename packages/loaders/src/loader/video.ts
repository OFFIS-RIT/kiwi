import type { TranscriptionModelV4 } from "@ai-sdk/provider";
import type { GraphBinaryLoader, GraphLoader } from "../types";
import { loadMediaTranscript } from "./audio";

export class VideoLoader implements GraphLoader {
    constructor(
        private options: {
            loader: GraphBinaryLoader;
            model: TranscriptionModelV4;
            mimeType?: string | null;
        }
    ) {}

    async getText(): Promise<string> {
        return loadMediaTranscript({
            ...this.options,
            capability: "video",
            title: "Video Transcript",
            emptyResultMessage: "Video transcription produced no text",
        });
    }
}
