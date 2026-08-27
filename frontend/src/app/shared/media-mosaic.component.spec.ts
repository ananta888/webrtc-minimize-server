import { describe, expect, it } from "vitest";

import { mosaicGrid } from "./media-mosaic.component";

describe("media mosaic layout", () => {
  it("creates a bounded near-square grid", () => {
    expect(mosaicGrid(1)).toEqual({ columns: 1, rows: 1 });
    expect(mosaicGrid(5)).toEqual({ columns: 3, rows: 2 });
    expect(mosaicGrid(15)).toEqual({ columns: 4, rows: 4 });
  });
});
