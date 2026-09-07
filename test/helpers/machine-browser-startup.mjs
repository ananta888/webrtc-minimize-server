// Closed startup diagnostics: never include URLs, console contents, tokens or DOM.
export function observeBrowserStartup(page) {
  const observed = { http_errors: [], script_errors: [], failed_requests: [], console_errors: [] };
  const code = value => String(value).match(/\b(?:NG[0-9]{4}|meet_[a-z_]{1,64}|ERR_[A-Z_]{1,64})\b/)?.[0]
    || (/module script.*MIME|MIME.*module script/i.test(String(value)) ? "module_script_mime" : "unclassified");
  page.on("response", response => {
    if (response.status() >= 400 && observed.http_errors.length < 8) observed.http_errors.push({
      status: response.status(), type: response.request().resourceType(),
    });
  });
  page.on("pageerror", error => {
    if (observed.script_errors.length < 8) observed.script_errors.push({
      kind: ["Error", "TypeError", "ReferenceError"].includes(error.name) ? error.name : "Error", code: code(error.message),
    });
  });
  page.on("requestfailed", request => {
    if (observed.failed_requests.length < 8) observed.failed_requests.push({
      type: request.resourceType(), code: code(request.failure()?.errorText),
    });
  });
  page.on("console", message => {
    if (message.type() === "error" && observed.console_errors.length < 8) observed.console_errors.push(code(message.text()));
  });
  return observed;
}
