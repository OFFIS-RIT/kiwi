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
      'Are you sure you want to delete the project "{projectName}"? This action cannot be undone.',
    "delete.project.error": "An error occurred while deleting the project.",
    "delete.group.confirm": "Delete Group?",
    "delete.group.description":
      'Are you sure you want to delete the group "{groupName}"? This will also delete all projects within the group. This action cannot be undone.',
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
    "files.considered": "Files considered: {count}",
    "files.used": "Files used: {count}",

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
    "process.pending": "Queued",
    "process.preprocessing": "Preprocessing",
    "process.metadata": "Extracting Metadata",
    "process.chunking": "Chunking",
    "process.extracting": "Extracting Graph",
    "process.deduplicating": "Deduplicating",
    "process.describing": "Generating Descriptions",
    "process.completed": "Completed",
    "process.failed": "Failed",
    "process.remaining": "~{time} remaining",
    "process.eta_confidence": "ETA confidence",
    "process.eta_samples": "Samples",
    "process.eta.low": "Learning",
    "process.eta.medium": "Medium",
    "process.eta.high": "High",
    processing: "Processing...",
    "projects.processing": "{count} processing",

    // Language
    language: "Language",
    english: "English",
    german: "German",
    "app.build": "Build",

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
    "error.creating.project": "Error creating project:",
    "error.unknown": "Unknown error",

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

    // Edit Project Errors
    "error.load.project.files.unknown": "Unknown error while loading files",
    "error.delete.files": "Error deleting files",
    "error.update.project.name": "Error updating the project name",
    "error.add.files": "Error adding files",
    "error.unexpected": "An unexpected error occurred.",

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

    // File Status
    "file.status.processing": "Processing...",
    "file.status.processed": "Processed successfully",
    "file.status.failed": "Processing failed",
    "file.status.no_status": "Status unknown",

    // Error messages (additional)
    "error.loading.data": "Error loading data. Please try again later.",
    "error.loading.users": "Failed to load users",
    "error.saving": "Failed to save changes",

    // Text Reference Badge
    "text.reference": "Text Reference",
    "reference.id": "Reference ID",
    "loading.text.content": "Loading text content...",
    "error.loading": "Error loading:",
    "text.content": "Text content:",
    copy: "Copy",
    created: "Created:",
    file: "File:",
    "file.id": "File ID:",

    // Clarification
    "clarification.placeholder": "Your answer...",
    "clarification.submitted": "Answers submitted",

    // Query Error Boundary
    "error.something.went.wrong": "Something went wrong",
    "error.unexpected.try.again":
      "An unexpected error occurred. Please try again.",
    "try.again": "Try again",
    "reload.page": "Reload page",
    "technical.details": "Technical details (development only)",

    // Auth
    "auth.sign.in": "Sign In",
    "auth.sign.up": "Sign Up",
    "auth.sign.out": "Sign Out",
    "auth.email": "Email",
    "auth.username": "Username",
    "auth.password": "Password",
    "auth.password.confirm": "Confirm Password",
    "auth.name": "Name",
    "auth.name.placeholder": "Enter your name",
    "auth.email.placeholder": "Enter your email",
    "auth.username.placeholder": "Enter your username",
    "auth.password.placeholder": "Enter your password",
    "auth.password.confirm.placeholder": "Confirm your password",
    "auth.no.account": "Don't have an account?",
    "auth.have.account": "Already have an account?",
    "auth.signing.in": "Signing in...",
    "auth.signing.up": "Signing up...",
    "auth.error.invalid.credentials": "Invalid credentials. Please try again.",
    "auth.error.email.taken": "This email is already registered.",
    "auth.error.passwords.mismatch": "Passwords do not match.",
    "auth.error.required.fields": "Please fill in all required fields.",
    "auth.error.sign.up": "Registration failed. Please try again.",
    "auth.welcome": "Welcome to KIWI",
    "auth.welcome.subtitle": "AI-powered Knowledge Management",

    // User Management
    "admin.user.management": "User Management",
    "admin.users": "Users",
    "admin.role": "Role",
    "admin.status": "Status",
    "admin.status.active": "Active",
    "admin.status.banned": "Banned",
    "admin.change.role": "Change Role",
    "admin.ban.user": "Ban User",
    "admin.unban.user": "Unban User",
    "admin.create.user": "Create User",
    "admin.create.user.description": "Create a new user account.",
    "admin.search.users": "Search users...",
    "admin.no.users": "No users found",
    "admin.role.admin": "Admin",
    "admin.role.manager": "Manager",
    "admin.role.user": "User",
    "admin.ban.reason": "Ban Reason",
    "admin.ban.reason.placeholder": "Reason for ban...",
    "admin.error.self.action": "You cannot perform this action on yourself.",
    "admin.previous": "Previous",
    "admin.next": "Next",
    "admin.edit.user": "Edit User",
    "admin.edit.user.description": "Update user details.",
    "admin.new.password": "New Password",
    "admin.new.password.placeholder": "Leave empty to keep current",
    "admin.save": "Save Changes",
    "admin.user.updated": "User updated successfully.",
    "admin.password.updated": "Password updated successfully.",
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
      'Möchtest du das Projekt "{projectName}" wirklich löschen? Diese Aktion kann nicht rückgängig gemacht werden.',
    "delete.project.error":
      "Beim Löschen des Projekts ist ein Fehler aufgetreten.",
    "delete.group.confirm": "Gruppe löschen?",
    "delete.group.description":
      'Möchtest du die Gruppe "{groupName}" wirklich löschen? Dadurch werden auch alle Projekte in der Gruppe gelöscht. Diese Aktion kann nicht rückgängig gemacht werden.',
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
    "files.considered": "Dateien betrachtet: {count}",
    "files.used": "Dateien verwendet: {count}",

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
    "process.pending": "In Warteschlange",
    "process.preprocessing": "Vorverarbeitung",
    "process.metadata": "Extrahiere Metadaten",
    "process.chunking": "Erstelle Chunks",
    "process.extracting": "Extrahiere Graph",
    "process.deduplicating": "Dedupliziere",
    "process.describing": "Generiere Beschreibungen",
    "process.completed": "Abgeschlossen",
    "process.failed": "Fehlgeschlagen",
    "process.remaining": "~{time} verbleibend",
    "process.eta_confidence": "ETA-Vertrauen",
    "process.eta_samples": "Beispiele",
    "process.eta.low": "Lernt noch",
    "process.eta.medium": "Mittel",
    "process.eta.high": "Hoch",
    processing: "Verarbeitung...",
    "projects.processing": "{count} in Verarbeitung",

    // Language
    language: "Sprache",
    english: "Englisch",
    german: "Deutsch",
    "app.build": "Version",

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
    "error.creating.project": "Fehler beim Erstellen des Projekts:",
    "error.unknown": "Unbekannter Fehler",

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

    // Edit Project Errors
    "error.load.project.files.unknown":
      "Unbekannter Fehler beim Laden der Dateien",
    "error.delete.files": "Fehler beim Löschen von Dateien",
    "error.update.project.name": "Fehler beim Aktualisieren des Namens",
    "error.add.files": "Fehler beim Hinzufügen der Dateien",
    "error.unexpected": "Ein unerwarteter Fehler ist aufgetreten.",

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

    // File Status
    "file.status.processing": "Wird verarbeitet...",
    "file.status.processed": "Erfolgreich verarbeitet",
    "file.status.failed": "Verarbeitung fehlgeschlagen",
    "file.status.no_status": "Status unbekannt",

    // Error messages (additional)
    "error.loading.data":
      "Fehler beim Laden der Daten. Bitte versuchen Sie es später erneut.",
    "error.loading.users": "Benutzer konnten nicht geladen werden",
    "error.saving": "Änderungen konnten nicht gespeichert werden",

    // Text Reference Badge
    "text.reference": "Text-Referenz",
    "reference.id": "Referenz-ID",
    "loading.text.content": "Lade Textinhalt...",
    "error.loading": "Fehler beim Laden:",
    "text.content": "Textinhalt:",
    copy: "Kopieren",
    created: "Erstellt:",
    file: "Datei:",
    "file.id": "Datei-ID:",

    // Clarification
    "clarification.placeholder": "Ihre Antwort...",
    "clarification.submitted": "Antworten gesendet",

    // Query Error Boundary
    "error.something.went.wrong": "Etwas ist schiefgelaufen",
    "error.unexpected.try.again":
      "Ein unerwarteter Fehler ist aufgetreten. Bitte versuchen Sie es erneut.",
    "try.again": "Erneut versuchen",
    "reload.page": "Seite neu laden",
    "technical.details": "Technische Details (nur in Entwicklung)",

    // Auth
    "auth.sign.in": "Anmelden",
    "auth.sign.up": "Registrieren",
    "auth.sign.out": "Abmelden",
    "auth.email": "E-Mail",
    "auth.username": "Benutzername",
    "auth.password": "Passwort",
    "auth.password.confirm": "Passwort bestätigen",
    "auth.name": "Name",
    "auth.name.placeholder": "Name eingeben",
    "auth.email.placeholder": "E-Mail eingeben",
    "auth.username.placeholder": "Benutzername eingeben",
    "auth.password.placeholder": "Passwort eingeben",
    "auth.password.confirm.placeholder": "Passwort bestätigen",
    "auth.no.account": "Noch kein Konto?",
    "auth.have.account": "Bereits ein Konto?",
    "auth.signing.in": "Anmeldung...",
    "auth.signing.up": "Registrierung...",
    "auth.error.invalid.credentials":
      "Ungültige Anmeldedaten. Bitte erneut versuchen.",
    "auth.error.email.taken": "Diese E-Mail ist bereits registriert.",
    "auth.error.passwords.mismatch": "Passwörter stimmen nicht überein.",
    "auth.error.required.fields": "Bitte alle Pflichtfelder ausfüllen.",
    "auth.error.sign.up":
      "Registrierung fehlgeschlagen. Bitte erneut versuchen.",
    "auth.welcome": "Willkommen bei KIWI",
    "auth.welcome.subtitle": "KI-basiertes Wissensmanagement",

    // User Management
    "admin.user.management": "Benutzerverwaltung",
    "admin.users": "Benutzer",
    "admin.role": "Rolle",
    "admin.status": "Status",
    "admin.status.active": "Aktiv",
    "admin.status.banned": "Gesperrt",
    "admin.change.role": "Rolle ändern",
    "admin.ban.user": "Benutzer sperren",
    "admin.unban.user": "Benutzer entsperren",
    "admin.create.user": "Benutzer erstellen",
    "admin.create.user.description": "Neues Benutzerkonto erstellen.",
    "admin.search.users": "Benutzer suchen...",
    "admin.no.users": "Keine Benutzer gefunden",
    "admin.role.admin": "Admin",
    "admin.role.manager": "Manager",
    "admin.role.user": "Benutzer",
    "admin.ban.reason": "Sperrgrund",
    "admin.ban.reason.placeholder": "Grund für die Sperrung...",
    "admin.error.self.action":
      "Diese Aktion kann nicht auf sich selbst angewendet werden.",
    "admin.previous": "Zurück",
    "admin.next": "Weiter",
    "admin.edit.user": "Benutzer bearbeiten",
    "admin.edit.user.description": "Benutzerdaten aktualisieren.",
    "admin.new.password": "Neues Passwort",
    "admin.new.password.placeholder": "Leer lassen um aktuelles zu behalten",
    "admin.save": "Änderungen speichern",
    "admin.user.updated": "Benutzer erfolgreich aktualisiert.",
    "admin.password.updated": "Passwort erfolgreich aktualisiert.",
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
