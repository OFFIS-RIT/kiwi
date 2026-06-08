import type { GraphBinaryLoader } from "..";

type WebLoaderOptions = {
    fetch?: typeof globalThis.fetch;
    headers?: RequestInit["headers"];
};

export class WebLoader implements GraphBinaryLoader {
    private response?: {
        content: ArrayBuffer;
        mimeType: string | null;
    };

    constructor(
        private readonly url: string | URL,
        private readonly options: WebLoaderOptions = {}
    ) {}

    async getText(): Promise<string> {
        const response = await this.load();
        return new TextDecoder().decode(response.content);
    }

    async getBinary(): Promise<ArrayBuffer> {
        return (await this.load()).content;
    }

    async getMimeType(): Promise<string | null> {
        return (await this.load()).mimeType;
    }

    private async load(): Promise<{ content: ArrayBuffer; mimeType: string | null }> {
        if (this.response) {
            return this.response;
        }

        const fetchFn = this.options.fetch ?? globalThis.fetch;
        const response = await fetchFn(this.url, { headers: this.options.headers });
        if (!response.ok) {
            throw new Error(`Failed to load ${String(this.url)} (${response.status} ${response.statusText})`);
        }

        this.response = {
            content: await response.arrayBuffer(),
            mimeType: response.headers.get("content-type"),
        };
        return this.response;
    }
}
