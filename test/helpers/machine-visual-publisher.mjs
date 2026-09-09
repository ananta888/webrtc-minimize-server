/** Installed in a test-owned publisher context only; never a physical capture. */
export function installSyntheticVisualSource(kind) {
  if (!["camera", "screen"].includes(kind)) throw new Error("test_visual_source_invalid");
  const capture = async () => {
    const canvas = document.createElement("canvas"); canvas.width = 1280; canvas.height = 720;
    const context = canvas.getContext("2d");
    const paint = () => { context.fillStyle = kind === "camera" ? "#dd2200" : "#00bb22"; context.fillRect(0, 0, 1280, 720); };
    paint(); const stream = canvas.captureStream(10), timer = setInterval(paint, 100);
    stream.getVideoTracks()[0].addEventListener("ended", () => { clearInterval(timer); canvas.width = canvas.height = 0; });
    return stream;
  };
  if (kind === "camera") navigator.mediaDevices.getUserMedia = capture;
  else navigator.mediaDevices.getDisplayMedia = capture;
}

export async function startSyntheticVisualPublisher(page, source) {
  if (!["camera", "screen"].includes(source)) throw new Error("test_visual_source_invalid");
  await page.evaluate(installSyntheticVisualSource, source);
  await page.locator(`#toggle-${source}`).click();
  await page.locator(`#toggle-${source}[aria-pressed="true"]`).waitFor();
}

export async function grantSyntheticVisualPublisher(page, source) {
  if (!["camera", "screen"].includes(source)) throw new Error("test_visual_source_invalid");
  await page.locator(".nav-item", { hasText: "Analyse" }).click();
  const panel = page.locator("app-machine-permissions-panel");
  await panel.getByRole("button", { name: "Für diese KI einstellen" }).click();
  await panel.getByLabel(source === "camera" ? "Meine laufende Kamera zur Analyse" : "Mein laufender Bildschirm zur Analyse", { exact: true }).check();
  await panel.getByRole("button", { name: "Auswahl ausdrücklich freigeben" }).click();
  await panel.getByText("Serverbestätigung erhalten.", { exact: true }).waitFor();
  return panel;
}
