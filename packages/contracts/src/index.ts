export type SourceChunkRegion = {
    kind: "text" | "image" | "page";
    page: number;
    width: number;
    height: number;
    rectangles: Array<{
        left: number;
        top: number;
        width: number;
        height: number;
    }>;
};

export type TextUnitSourceChunk =
    | {
          id: number;
          type: "text";
          text: string;
          startPage: number | null;
          endPage: number | null;
          regions?: SourceChunkRegion[];
      }
    | {
          id: number;
          type: "image";
          text: string;
          imageId: string | null;
          imageKey: string | null;
          startPage: number | null;
          endPage: number | null;
          regions?: SourceChunkRegion[];
      };

export type LoaderSourceChunk =
    | (Omit<Extract<TextUnitSourceChunk, { type: "text" }>, "id"> & {
          startOffset: number;
          endOffset: number;
      })
    | (Omit<Extract<TextUnitSourceChunk, { type: "image" }>, "id"> & {
          startOffset: number;
          endOffset: number;
      });

export type LoadedGraphDocument = {
    text: string;
    sourceChunks?: LoaderSourceChunk[];
};
