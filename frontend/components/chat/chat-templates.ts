export type ChatTemplate = {
  id: string;
  title: string;
  description?: string;
  body: string;
};

export const chatTemplates: ChatTemplate[] = [
  {
    id: "response-standard",
    title: "Auskunft erteilen (Standardbrief)",
    description: "Fertiges Antwortschreiben basierend auf Aktenlage.",
    body: `Erstelle ein höfliches, klares Antwortschreiben (Brief/E-Mail), das direkt versendet werden kann.
- Anrede: neutral und passend.
- Kontext der Anfrage: [kurz eintragen, z.B. "Bitte um Auskunft zu ..."].
- Wesentliche Punkte aus den hinterlegten Dokumenten zusammenfassen und beantworten.
- Falls relevant: konkrete Fundstellen/Quellen knapp benennen (Dokument + Abschnitt).
- Abschluss: anbieten, für Rückfragen zur Verfügung zu stehen.
- Ton: sachlich, verständlich, kein Juristendeutsch.

Ausgabe: Nur den finalen Brieftext, keine weiteren Erklärungen.`,
  },
  {
    id: "request-missing-info",
    title: "Nachforderung fehlender Angaben/Unterlagen",
    description: "Liste klar nennen, Frist setzen, kurz begründen.",
    body: `Erstelle ein höfliches Schreiben (Brief/E-Mail), mit dem fehlende Angaben/Unterlagen angefordert werden.
- Anrede: neutral.
- Bezug zur Anfrage/Aktenzeichen: [eintragen].
- Liste der benötigten Angaben/Unterlagen stichpunktartig (Platzhalter ersetzen):
  - [Angabe/Unterlage 1]
  - [Angabe/Unterlage 2]
- Kurz erklären, warum sie benötigten werden (1-2 Sätze).
- Bitte um Übermittlung per Antwortmail oder Upload, Frist: [Frist einsetzen].
- Abschluss: Danke und Rückfrageangebot.

Ausgabe: Nur den finalen Brieftext, keine weiteren Erklärungen.`,
  },
  {
    id: "status-update",
    title: "Statusupdate & Zeitplan",
    description: "Kurzes Update mit nächsten Schritten und Zeitangabe.",
    body: `Erstelle ein kurzes Statusschreiben (Brief/E-Mail) zum aktuellen Stand.
- Anrede: neutral.
- Anliegen/Aktenzeichen: [eintragen].
- Aktuellen Stand anhand der hinterlegten Dokumente knapp zusammenfassen.
- Nächste Schritte stichpunktartig mit schätzbarer Zeitangabe:
  - Schritt 1: [Beschreibung, erwartete Zeit]
  - Schritt 2: [Beschreibung, erwartete Zeit]
- Falls notwendig: Hinweis auf ausstehende Abhängigkeiten.
- Abschluss: Dank und Rückfrageangebot.

Ausgabe: Nur den finalen Brieftext, keine weiteren Erklärungen.`,
  },
];
