export interface VoskBrowserModel {
  readonly id: string;
  readonly languageTag: string;
  readonly language: string;
  readonly nativeLanguage: string;
  readonly fileName: string;
  readonly sizeBytes: number;
  readonly license: "Apache-2.0" | "CC-BY-NC-SA-4.0";
  readonly sourceUrl: string;
  readonly note: string;
}

export const VOSK_BROWSER_SOURCE_REVISION = "a4b0d0fe60359e5ea9800f810f6b6f6c1d2b03c6";
export const VOSK_BROWSER_SOURCE = "https://github.com/ccoreilly/vosk-browser";
export const VOSK_OFFICIAL_MODELS = "https://alphacephei.com/vosk/models";

const MODEL_BASE = `https://raw.githubusercontent.com/ccoreilly/vosk-browser/${VOSK_BROWSER_SOURCE_REVISION}/models`;

function model(
  id: string,
  languageTag: string,
  language: string,
  nativeLanguage: string,
  fileName: string,
  sizeBytes: number,
  license: VoskBrowserModel["license"] = "Apache-2.0",
  note = "Kleines, browsergeeignet verpacktes Offline-Modell",
): VoskBrowserModel {
  return Object.freeze({
    id,
    languageTag,
    language,
    nativeLanguage,
    fileName,
    sizeBytes,
    license,
    sourceUrl: `${MODEL_BASE}/${fileName}`,
    note,
  });
}

export const VOSK_BROWSER_MODELS: readonly VoskBrowserModel[] = Object.freeze([
  model("de-de-small-0.15", "de-DE", "Deutsch", "Deutsch", "vosk-model-small-de-0.15.tar.gz", 46_476_437),
  model("en-us-small-0.15", "en-US", "Englisch (USA)", "English (US)", "vosk-model-small-en-us-0.15.tar.gz", 41_184_862),
  model("en-in-small-0.4", "en-IN", "Englisch (Indien)", "English (India)", "vosk-model-small-en-in-0.4.tar.gz", 37_561_269),
  model("es-es-small-0.3", "es-ES", "Spanisch", "Español", "vosk-model-small-es-0.3.tar.gz", 34_455_485),
  model(
    "fr-fr-small-pguyot-0.3",
    "fr-FR",
    "Französisch",
    "Français",
    "vosk-model-small-fr-pguyot-0.3.tar.gz",
    46_004_187,
    "CC-BY-NC-SA-4.0",
    "Nur nicht-kommerzielle Nutzung; ältere browsergeeignete Modellgeneration",
  ),
  model("it-it-small-0.4", "it-IT", "Italienisch", "Italiano", "vosk-model-small-it-0.4.tar.gz", 34_256_856),
  model("pt-br-small-0.3", "pt-BR", "Portugiesisch (Brasilien)", "Português", "vosk-model-small-pt-0.3.tar.gz", 32_440_432),
  model("ca-es-small-0.4", "ca-ES", "Katalanisch", "Català", "vosk-model-small-ca-0.4.tar.gz", 43_362_859),
  model("zh-cn-small-0.3", "zh-CN", "Chinesisch (Mandarin)", "中文", "vosk-model-small-cn-0.3.tar.gz", 33_235_437),
  model("fa-ir-small-0.4", "fa-IR", "Persisch", "فارسی", "vosk-model-small-fa-0.4.tar.gz", 48_739_672),
  model("ru-ru-small-0.4", "ru-RU", "Russisch", "Русский", "vosk-model-small-ru-0.4.tar.gz", 40_810_065),
  model("tr-tr-small-0.3", "tr-TR", "Türkisch", "Türkçe", "vosk-model-small-tr-0.3.tar.gz", 36_849_555),
  model("vi-vn-small-0.3", "vi-VN", "Vietnamesisch", "Tiếng Việt", "vosk-model-small-vn-0.3.tar.gz", 33_668_590),
]);

export const DEFAULT_VOSK_MODEL_ID = "de-de-small-0.15";

export function findVoskModel(id: unknown): VoskBrowserModel | null {
  return typeof id === "string" ? VOSK_BROWSER_MODELS.find((entry) => entry.id === id) || null : null;
}

export function formatModelSize(sizeBytes: number): string {
  return `${(sizeBytes / 1_000_000).toFixed(1).replace(".", ",")} MB`;
}
