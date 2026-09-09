export interface MachineReceiveFeedback {
  readonly title: string;
  readonly message: string;
  readonly diagnostic: string | null;
}

const messages: Readonly<Record<string, readonly [string, string]>> = Object.freeze({
  machine_receive_selection_changed: ["Auswahl nicht mehr aktuell", "Quelle oder Sitzung seit der Auswahl geändert. Es wurde keine neue Freigabe gesendet. Bitte „Für diese KI einstellen“ erneut wählen und die gewünschten Quellen prüfen."],
  machine_receive_hub_capability_missing: ["Vom Hub nicht freigegeben", "Der Hub erlaubt dieser KI die ausgewählte Fähigkeit nicht. Deine Quellenfreigabe kann diese Grenze nicht erweitern."],
  machine_receive_actor_denied: ["Freigabe nicht erlaubt", "Nur berechtigte menschliche Teilnehmer können ihre eigenen Quellen freigeben. Prüfe deine aktuelle Raumteilnahme."],
  machine_receive_scope_denied: ["Quelle oder KI nicht mehr berechtigt", "Die ausgewählte Quelle oder KI passt nicht zur aktuellen Raumfreigabe. Prüfe den Teilnehmer und wähle deine laufenden Quellen erneut."],
  machine_receive_subscription_denied: ["Empfang nicht erlaubt", "Für diesen Empfang fehlen aktuelle Rechte. Prüfe die Hub-Fähigkeiten und deine eigenen Quellenfreigaben."],
  machine_receive_revision_conflict: ["Freigaben inzwischen geändert", "Die angezeigte Auswahl ist nicht mehr aktuell. Öffne „Für diese KI einstellen“ erneut; es wird nichts automatisch wiederholt."],
  machine_receive_ack_timeout: ["Keine Serverbestätigung", "Die Anfrage wurde nicht rechtzeitig bestätigt. Prüfe zuerst die aktuell angezeigten Freigaben: Die Änderung könnte den Server bereits erreicht haben."],
  machine_receive_session_changed: ["Raumteilnahme geändert", "Die frühere Rückmeldung gilt nicht mehr für diese Raumteilnahme. Wähle nach dem Beitritt die gewünschte KI erneut aus."],
  machine_receive_source_not_active: ["Quelle nicht aktiv", "Starte die gewünschte Quelle bewusst über die Mediensteuerung und wähle sie danach erneut aus. Dieses Panel startet keine Aufnahme."],
  machine_receive_target_unavailable: ["KI nicht verfügbar", "Der ausgewählte KI-Teilnehmer ist nicht mehr verfügbar oder die Auswahl ist ungültig. Prüfe die Teilnehmerliste und die Gültigkeitsdauer."],
  machine_receive_selection_invalid: ["Ungültige Auswahl", "Wähle deine gewünschten laufenden Quellen und eine gültige Dauer erneut aus."],
  machine_receive_consent_invalid: ["Freigabe nicht angenommen", "Der Server hat die Freigabe in dieser Form abgelehnt. Prüfe deine Auswahl und die aktuellen Rechte."],
  machine_receive_config_invalid: ["Empfang nicht verfügbar", "Die Empfangskonfiguration ist ungültig. Der Betreiber muss sie prüfen; es wurden keine zusätzlichen Rechte erteilt."],
  machine_receive_policy_invalid: ["Freigabestatus nicht verlässlich", "Die Empfangspolicy konnte nicht verlässlich geprüft werden. Der Betreiber muss die Konfiguration prüfen."],
  machine_receive_request_failed: ["Aktion nicht bestätigt", "Die Aktion konnte nicht bestätigt werden. Prüfe die aktuellen Freigaben, bevor du sie erneut anforderst."],
});

/** Read-only presentation. Never echo unknown server data or retry a command. */
export function machineReceiveFeedback(code: unknown): MachineReceiveFeedback | null {
  if (code === "") return null;
  if (typeof code === "string" && Object.hasOwn(messages, code)) {
    const [title, message] = messages[code];
    return Object.freeze({ title, message, diagnostic: code });
  }
  return Object.freeze({ title: "Aktion nicht bestätigt",
    message: "Die Anfrage lieferte keine verlässliche Rückmeldung. Prüfe die aktuellen Freigaben. Unbekannte Fehlerdetails werden nicht angezeigt.", diagnostic: null });
}
