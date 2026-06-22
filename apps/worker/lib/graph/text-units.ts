import type { Unit } from "@kiwi/graph";

export function toTextUnitRows(units: Unit[]) {
    return units.map((unit) => ({
        id: unit.id,
        fileId: unit.fileId,
        text: unit.content,
        startPage: unit.startPage,
        endPage: unit.endPage,
        chunks: unit.chunks,
    }));
}
