// Test-only observer. Exactly one user click, never an enrollment retry.
export async function observeNativeInstallerDownload(page, origin) {
  const matches = request => {
    const url = new URL(request.url());
    return url.origin === origin && url.pathname === "/api/native-packagers/enrollments"
      && !url.search && request.method() === "POST";
  };
  let observed = false;
  let transport = "none";
  let phase = "click";
  let httpStatus = 0;
  const requestSeen = request => { if (matches(request)) observed = true; };
  const requestFailed = request => {
    if (!matches(request)) return;
    const code = request.failure()?.errorText;
    transport = ["net::ERR_NETWORK_CHANGED", "net::ERR_ABORTED", "net::ERR_FAILED", "net::ERR_CONNECTION_CLOSED"]
      .includes(code) ? code : "unclassified";
  };
  page.on("request", requestSeen);
  page.on("requestfailed", requestFailed);
  const responsePending = page.waitForResponse(response => matches(response.request()), { timeout: 30_000 });
  const downloadPending = page.waitForEvent("download", { timeout: 30_000 });
  void responsePending.catch(() => undefined);
  void downloadPending.catch(() => undefined);
  try {
    await page.locator("#download-native-packager-installer").click({ timeout: 30_000 });
    phase = "response";
    const response = await responsePending;
    httpStatus = response.status();
    if (httpStatus !== 201) throw new Error("enrollment_rejected");
    phase = "download";
    const download = await downloadPending;
    return { response, download };
  } catch {
    const messages = await page.locator("#app-error").allTextContents().catch(() => []);
    const codes = messages.flatMap(message => message.match(/\b(?:native_packager|oidc|auth|invalid_native_packager)_[a-z0-9_]{1,64}\b/g) || []).slice(0, 3);
    throw new Error(`native_installer_download_failed:phase=${phase}:request=${observed}:http=${httpStatus}:transport=${transport}:ui=${codes.join(",") || "no_bounded_error"}`);
  } finally {
    page.off("request", requestSeen);
    page.off("requestfailed", requestFailed);
  }
}
