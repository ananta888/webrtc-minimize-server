/** Code-native labels remain outside caller image pixels and cannot be omitted. */
export interface MachineAvatarArtwork {
  draw(drawing: CanvasRenderingContext2D): void;
  close(): void;
}

export function drawAvatar(drawing: CanvasRenderingContext2D, sequence: number, artwork?: MachineAvatarArtwork): void {
  drawing.fillStyle = "#102638"; drawing.fillRect(0, 0, 256, 256);
  if (artwork) artwork.draw(drawing);
  else {
    drawing.fillStyle = "#72e1ce";
    drawing.beginPath(); drawing.arc(128, 105, 57, 0, Math.PI * 2); drawing.fill();
    drawing.fillStyle = "#102638";
    drawing.fillRect(99, 94, 12, 12); drawing.fillRect(145, 94, 12, 12);
    drawing.fillRect(108, 125, 40, 5);
  }
  drawing.fillStyle = "#ffffff"; drawing.textAlign = "center";
  drawing.font = "bold 20px sans-serif"; drawing.fillText("ANANTA", 128, 30);
  // Large fixed marks survive the normal 64px camera thumbnail beside screen.
  drawing.font = "bold 44px sans-serif"; drawing.fillText("KI", 128, 211);
  drawing.fillStyle = "#72e1ce"; drawing.fillRect(28, 224, 20 + (sequence % 10) * 20, 12);
}
