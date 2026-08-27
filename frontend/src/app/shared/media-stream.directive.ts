import { Directive, ElementRef, Input } from "@angular/core";

@Directive({ selector: "video[appMediaStream],audio[appMediaStream]", standalone: true })
export class MediaStreamDirective {
  constructor(private readonly element: ElementRef<HTMLMediaElement>) {}

  @Input() set appMediaStream(stream: MediaStream | null) {
    this.element.nativeElement.srcObject = stream;
  }
}
