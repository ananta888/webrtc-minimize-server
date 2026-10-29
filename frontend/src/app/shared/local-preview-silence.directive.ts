import { AfterViewInit, Directive, ElementRef, Input, OnChanges } from "@angular/core";

/** Local capture previews must never be audible; remote media keeps its own playback. */
@Directive({ selector: "[appLocalPreviewSilence]", standalone: true })
export class LocalPreviewSilenceDirective implements AfterViewInit, OnChanges {
  @Input("appLocalPreviewSilence") silent = true;

  constructor(private readonly element: ElementRef<HTMLMediaElement>) {}

  ngOnChanges(): void {
    this.apply();
  }

  ngAfterViewInit(): void {
    this.apply();
  }

  private apply(): void {
    if (!this.silent) return;
    const media = this.element.nativeElement;
    media.muted = true;
    media.volume = 0;
  }
}
