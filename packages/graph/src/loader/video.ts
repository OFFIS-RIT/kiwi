import type { TranscriptionModelV3 } from "@ai-sdk/provider";
import type { GraphBinaryLoader, GraphLoader } from "..";
import { loadMediaTranscript } from "./audio";

export class VideoLoader implements GraphLoader {
    constructor(
        private options: {
            loader: GraphBinaryLoader;
            model: TranscriptionModelV3;
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
