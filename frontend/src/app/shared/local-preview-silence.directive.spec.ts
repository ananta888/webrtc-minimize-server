import { describe, expect, it } from "vitest";

import { LocalPreviewSilenceDirective } from "./local-preview-silence.directive";

function fixture() {
  const nativeElement = { muted: false, volume: 1 } as unknown as HTMLMediaElement;
  const directive = new LocalPreviewSilenceDirective({ nativeElement } as never);
  return { directive, nativeElement: nativeElement as { muted: boolean; volume: number } };
}

describe("LocalPreviewSilenceDirective", () => {
  it("forces local preview media inaudible on init", () => {
    const { directive, nativeElement } = fixture();
    directive.ngAfterViewInit();
    expect(nativeElement.muted).toBe(true);
    expect(nativeElement.volume).toBe(0);
  });

  it("re-silences when the element is reused for another local publication", () => {
    const { directive, nativeElement } = fixture();
    directive.ngAfterViewInit();
    nativeElement.muted = false;
    nativeElement.volume = 1;
    directive.ngOnChanges();
    expect(nativeElement.muted).toBe(true);
    expect(nativeElement.volume).toBe(0);
  });

  it("leaves remote preview media audible", () => {
    const { directive, nativeElement } = fixture();
    directive.silent = false;
    directive.ngAfterViewInit();
    directive.ngOnChanges();
    expect(nativeElement.muted).toBe(false);
    expect(nativeElement.volume).toBe(1);
  });
});
