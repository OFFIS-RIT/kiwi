"use client";

import type React from "react";

import { createContext, useContext, useEffect, useState } from "react";

/**
 * Supported language codes.
 */
type Language = "en" | "de";

/**
 * Context value type for the LanguageProvider.
 */
type LanguageContextType = {
  language: Language;
  setLanguage: (language: Language) => void;
  t: (key: string, params?: Record<string, string>) => string;
};

const translations = {
  en: {
    // Navigation
    "select.group": "Select a group",
    "select.project": "Select a project",
    "no.group.selected": "No Group Selected",
    "select.group.sidebar":
      "Select a group from the sidebar to view its projects",
    "no.project.selected": "No Project Selected",
    "select.project.sidebar":
      "Select a project from the sidebar to view its details",

    // Groups
    "knowledge.groups": "Groups & Knowledge Projects",
    "no.groups": "No groups found",
    "create.first.group": "Create your first group using the + button",
    "group.not.found": "Group not found",
    "select.another.group": "Please select another group from the sidebar",

    // Projects
    "no.projects": "No projects found in this group",
    "create.first.project": "Create your first project using the + button",

    // Loading states
    loading: "Loading...",
    "loading.groups": "Loading groups, please wait",
    "loading.projects": "Loading projects, please wait",
    "loading.files": "Loading files, please wait",
    "loading.users": "Loading users, please wait",
    error: "Error",
    "please.wait": "Please wait",
    "no.items": "No items found",

    // Project view
    "from.group": "From",
    group: "group",
    "welcome.message":
      "Welcome to the {projectName} knowledge base. How can I help you today?",
    "ask.question": "Ask a question about this knowledge project...",
    "send.message": "Send message",
    "error.chat.api": "Sorry, I couldn't get a response. Please try again.",

    // Group projects view
    "select.knowledge.project": "Select a knowledge project to view",
    "last.updated": "Last updated:",
    messages: "messages",
    sources: "sources",
    "knowledge.project": "Knowledge Project",
    "knowledge.projects": "Knowledge Projects",
    open: "Open",

    // Actions
    "create.new": "Create new",
    "create.new.group": "Create new group",
    "create.new.project": "Create new knowledge project",
    "create.new.project.description":
      "Create a new knowledge project by filling out the form below.",
    "create.new.group.description":
      "Create a new group by entering a name below.",
    "upload.files": "Upload Files",
    "uploading.files": "Uploading Files",
    uploading: "Uploading...",
    edit: "Edit",
    delete: "Delete",
    logout: "Logout",
    options: "Options",
    close: "Close",
    "save.changes": "Save Changes",
    "add.user": "Add User",
    "delete.project.confirm": "Delete Project?",
    "delete.project.description":
      "Are you sure you want to delete the project \"{projectName}\"? This action cannot be undone.",
    "delete.project.error": "An error occurred while deleting the project.",
    "delete.group.confirm":
      "Are you sure you want to delete this group? This will also delete all projects within the group. This action cannot be undone.",
    "delete.group.error": "An error occurred while deleting the group.",
    "reset.chat": "Reset Chat",
    "reset.chat.confirm": "Reset Chat History?",
    "reset.chat.description":
      "Are you sure you want to reset the chat history for {projectName}? This will delete all messages and cannot be undone.",
    "copy.message": "Copy",
    "copied.message": "Copied",
    "start.recording": "Start voice input",
    "stop.recording": "Stop voice input",
    "play.message": "Play",
    "stop.speaking": "Stop",

    // Query Steps
    "step.thinking": "Thinking...",
    "step.db_query": "Searching database...",
    "step.search_entities": "Searching entities...",
    "step.get_entity_neighbours": "Finding related entities...",
    "step.path_between_entities": "Finding connections...",
    "step.get_entity_sources": "Retrieving sources for entities...",
    "step.get_relationship_sources": "Retrieving sources for relationships...",
    "step.get_entity_details": "Loading entity details...",
    "step.get_entity_types": "Getting entity types...",
    "step.search_entities_by_type": "Searching entities by type...",

    // Thinking Dropdown
    "thinking.collapsed": "Thought for {seconds} seconds",
    "thinking.show": "Show reasoning",
    "thinking.processing": "Thinking...",

    // Process Steps
    "process.queued": "Queued",
    "process.processing_files": "Processing Files",
    "process.graph_creation": "Creating Graph",
    "process.generating_descriptions": "Generating Descriptions",
    "process.saving": "Saving",
    "process.completed": "Completed",
    "process.failed": "Failed",
    "process.remaining": "~{time} remaining",
    processing: "Processing...",
    "projects.processing": "{count} processing",

    // Language
    language: "Language",
    english: "English",
    german: "German",

    // Search
    search: "Search",
    "search.placeholder": "Search groups and projects...",
    "no.search.results": "No results found",
    "search.results.found": "results found",
    "search.try.different": "Try a different search term",
    "search.min.chars": "Enter at least {count} characters to search",
    clear: "Clear",

    // Theme
    "theme.dark": "Dark mode",
    "theme.light": "Light mode",

    // Create Project Form
    "project.name": "Project Name",
    "project.name.placeholder": "Enter project name",
    "group.name": "Group Name",
    "group.name.placeholder": "Enter group name",
    "select.group.placeholder": "Select a group",
    "select.admins": "Select Administrators",
    "upload.documents": "Upload Documents",
    "drag.drop.files": "Drag and drop files here",
    or: "or",
    "select.files": "Select Files",
    "selected.files": "Selected Files",
    "remove.file": "Remove file",
    cancel: "Cancel",
    create: "Create",
    creating: "Creating...",
    "error.group.required": "Please select a group to create a project.",

    // Edit Project
    "edit.project": "Edit Project",
    "edit.project.description": "View project information and manage files",
    "project.id": "Project ID",
    "project.files": "Project Files",
    "no.files": "No files found in this project",
    "add.files": "Add Files to Project",
    "mark.delete.file": "Mark file for deletion",
    "undo.delete.file": "Undo marking for deletion",
    "files.marked.deletion.warning":
      "Files marked for deletion will be removed upon saving.",

    // Edit Group
    "edit.group": "Edit Group",
    "edit.group.description": "View group information and manage users",
    "group.id": "Group ID",
    "group.users": "Group Users",
    "no.users": "No users found in this group",
    "user.id": "User ID",
    "user.id.placeholder": "User ID...",
    "error.invalid.userid": "Please enter a valid user ID.",
    "error.duplicate.userid": "This user ID already exists in the group.",
  },
  de: {
    // Navigation
    "select.group": "Wähle eine Gruppe",
    "select.project": "Wähle ein Projekt",
    "no.group.selected": "Keine Gruppe ausgewählt",
    "select.group.sidebar":
      "Wähle eine Gruppe aus der Seitenleiste, um ihre Projekte anzuzeigen",
    "no.project.selected": "Kein Projekt ausgewählt",
    "select.project.sidebar":
      "Wähle ein Projekt aus der Seitenleiste, um dessen Details anzuzeigen",

    // Groups
    "knowledge.groups": "Gruppen & Wissensprojekte",
    "no.groups": "Keine Gruppen gefunden",
    "create.first.group": "Erstelle deine erste Gruppe mit dem + Button",
    "group.not.found": "Gruppe nicht gefunden",
    "select.another.group":
      "Bitte wähle eine andere Gruppe aus der Seitenleiste",

    // Projects
    "no.projects": "Keine Projekte in dieser Gruppe gefunden",
    "create.first.project": "Erstelle dein erstes Projekt mit dem + Button",

    // Loading states
    loading: "Wird geladen...",
    "loading.groups": "Gruppen werden geladen, bitte warten",
    "loading.projects": "Projekte werden geladen, bitte warten",
    "loading.files": "Dateien werden geladen, bitte warten",
    "loading.users": "Benutzer werden geladen, bitte warten",
    error: "Fehler",
    "please.wait": "Bitte warten",
    "no.items": "Keine Einträge gefunden",

    // Project view
    "from.group": "Aus der",
    group: "Gruppe",
    "welcome.message":
      "Willkommen in der {projectName} Wissensdatenbank. Wie kann ich dir heute helfen?",
    "ask.question": "Stelle eine Frage zu diesem Wissensprojekt...",
    "send.message": "Nachricht senden",
    "error.chat.api":
      "Entschuldigung, ich konnte keine Antwort erhalten. Bitte versuche es erneut.",

    // Group projects view
    "select.knowledge.project": "Wähle ein Wissensprojekt zum Anzeigen",
    "last.updated": "Zuletzt aktualisiert:",
    messages: "Nachrichten",
    sources: "Quellen",
    "knowledge.project": "Wissensprojekt",
    "knowledge.projects": "Wissensprojekte",
    open: "Öffnen",

    // Actions
    "create.new": "Neu erstellen",
    "create.new.group": "Neue Gruppe erstellen",
    "create.new.project": "Neues Wissensprojekt erstellen",
    "create.new.project.description":
      "Erstelle ein neues Wissensprojekt, indem du das Formular unten ausfüllst.",
    "create.new.group.description":
      "Erstelle eine neue Gruppe, indem du unten einen Namen eingibst.",
    "upload.files": "Dateien hochladen",
    "uploading.files": "Dateien werden hochgeladen",
    uploading: "Lade hoch...",
    edit: "Bearbeiten",
    delete: "Löschen",
    logout: "Abmelden",
    options: "Optionen",
    close: "Schließen",
    "save.changes": "Änderungen speichern",
    "add.user": "Benutzer hinzufügen",
    "delete.project.confirm": "Projekt löschen?",
    "delete.project.description":
      "Möchtest du das Projekt \"{projectName}\" wirklich löschen? Diese Aktion kann nicht rückgängig gemacht werden.",
    "delete.project.error":
      "Beim Löschen des Projekts ist ein Fehler aufgetreten.",
    "delete.group.confirm":
      "Möchtest du diese Gruppe wirklich löschen? Dadurch werden auch alle Projekte in der Gruppe gelöscht. Diese Aktion kann nicht rückgängig gemacht werden.",
    "delete.group.error": "Beim Löschen der Gruppe ist ein Fehler aufgetreten.",
    "reset.chat": "Chat zurücksetzen",
    "reset.chat.confirm": "Chat-Verlauf zurücksetzen?",
    "reset.chat.description":
      "Möchtest du den Chat-Verlauf für {projectName} wirklich zurücksetzen? Alle Nachrichten werden gelöscht und diese Aktion kann nicht rückgängig gemacht werden.",
    "copy.message": "Kopieren",
    "copied.message": "Kopiert",
    "start.recording": "Spracheingabe starten",
    "stop.recording": "Spracheingabe beenden",
    "play.message": "Abspielen",
    "stop.speaking": "Stopp",

    // Query Steps
    "step.thinking": "Denkt nach...",
    "step.db_query": "Durchsuche Datenbank...",
    "step.search_entities": "Suche Entitäten...",
    "step.get_entity_neighbours": "Suche verwandte Entitäten...",
    "step.path_between_entities": "Finde Verbindungen...",
    "step.get_entity_sources": "Lade Quellen für Entitäten...",
    "step.get_relationship_sources": "Lade Quellen für Beziehungen...",
    "step.get_entity_details": "Lade Entitätsdetails...",
    "step.get_entity_types": "Lade Entitätstypen...",
    "step.search_entities_by_type": "Suche Entitäten nach Typ...",

    // Thinking Dropdown
    "thinking.collapsed": "Gedacht für {seconds} Sekunden",
    "thinking.show": "Reasoning anzeigen",
    "thinking.processing": "Denkt nach...",

    // Process Steps
    "process.queued": "In Warteschlange",
    "process.processing_files": "Verarbeite Dateien",
    "process.graph_creation": "Erstelle Graph",
    "process.generating_descriptions": "Generiere Beschreibungen",
    "process.saving": "Speichern",
    "process.completed": "Abgeschlossen",
    "process.failed": "Fehlgeschlagen",
    "process.remaining": "~{time} verbleibend",
    processing: "Verarbeitung...",
    "projects.processing": "{count} in Verarbeitung",

    // Language
    language: "Sprache",
    english: "Englisch",
    german: "Deutsch",

    // Search
    search: "Suchen",
    "search.placeholder": "Gruppen und Projekte suchen...",
    "no.search.results": "Keine Ergebnisse gefunden",
    "search.results.found": "Ergebnisse gefunden",
    "search.try.different": "Versuche einen anderen Suchbegriff",
    "search.min.chars": "Gib mindestens {count} Zeichen ein, um zu suchen",
    clear: "Löschen",

    // Theme
    "theme.dark": "Dunkelmodus",
    "theme.light": "Hellmodus",

    // Create Project Form
    "project.name": "Projektname",
    "project.name.placeholder": "Projektname eingeben",
    "group.name": "Gruppenname",
    "group.name.placeholder": "Gruppenname eingeben",
    "select.group.placeholder": "Gruppe auswählen",
    "select.admins": "Administratoren auswählen",
    "upload.documents": "Dokumente hochladen",
    "drag.drop.files": "Dateien hier ablegen",
    or: "oder",
    "select.files": "Dateien auswählen",
    "selected.files": "Ausgewählte Dateien",
    "remove.file": "Datei entfernen",
    cancel: "Abbrechen",
    create: "Erstellen",
    creating: "Erstelle...",
    "error.group.required":
      "Bitte wähle eine Gruppe aus, um ein Projekt zu erstellen.",

    // Edit Project
    "edit.project": "Projekt bearbeiten",
    "edit.project.description":
      "Projektinformationen anzeigen und Dateien verwalten",
    "project.id": "Projekt-ID",
    "project.files": "Projektdateien",
    "no.files": "Keine Dateien in diesem Projekt gefunden",
    "add.files": "Dateien zum Projekt hinzufügen",
    "mark.delete.file": "Datei zum Löschen markieren",
    "undo.delete.file": "Löschmarkierung aufheben",
    "files.marked.deletion.warning":
      "Zum Löschen markierte Dateien werden beim Speichern entfernt.",

    // Edit Group
    "edit.group": "Gruppe bearbeiten",
    "edit.group.description":
      "Gruppeninformationen anzeigen und Benutzer verwalten",
    "group.id": "Gruppen-ID",
    "group.users": "Gruppenbenutzer",
    "no.users": "Keine Benutzer in dieser Gruppe gefunden",
    "user.id": "Benutzer-ID",
    "user.id.placeholder": "Benutzer-ID...",
    "error.invalid.userid": "Bitte eine gültige Benutzer-ID eingeben.",
    "error.duplicate.userid":
      "Diese Benutzer-ID existiert bereits in der Gruppe.",
  },
};

const LanguageContext = createContext<LanguageContextType | undefined>(
  undefined
);

/**
 * Provides i18n functionality with English and German translations.
 * Persists language preference to localStorage.
 * Default language is German ("de").
 */
export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [language, setLanguageState] = useState<Language>("de");

  useEffect(() => {
    const savedLanguage = localStorage.getItem("language") as Language;
    if (savedLanguage && (savedLanguage === "en" || savedLanguage === "de")) {
      setLanguageState(savedLanguage);
    }
  }, []);

  const setLanguage = (newLanguage: Language) => {
    setLanguageState(newLanguage);
    localStorage.setItem("language", newLanguage);
  };

  const t = (key: string, params?: Record<string, string>) => {
    let text = (translations[language] as Record<string, string>)[key] || key;
    if (params) {
      Object.entries(params).forEach(([paramKey, value]) => {
        text = text.replace(`{${paramKey}}`, value);
      });
    }
    return text;
  };

  return (
    <LanguageContext.Provider value={{ language, setLanguage, t }}>
      {children}
    </LanguageContext.Provider>
  );
}

/**
 * Hook to access language state and translation function.
 * Must be used within a LanguageProvider.
 *
 * @returns Object with current language, setLanguage function, and t() translator
 * @throws Error if used outside of LanguageProvider
 */
export function useLanguage() {
  const context = useContext(LanguageContext);
  if (context === undefined) {
    throw new Error("useLanguage must be used within a LanguageProvider");
  }
  return context;
}
