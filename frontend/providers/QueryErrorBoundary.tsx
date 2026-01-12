"use client";

import { Button } from "@/components/ui/button";
import { Component, type ReactNode } from "react";

interface QueryErrorBoundaryProps {
  children: ReactNode;
}

interface QueryErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

/**
 * Error Boundary to catch errors from React Query and prevent app crashes
 * Provides a fallback UI with the ability to recover
 */
export class QueryErrorBoundary extends Component<
  QueryErrorBoundaryProps,
  QueryErrorBoundaryState
> {
  constructor(props: QueryErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): QueryErrorBoundaryState {
    // Update state so the next render will show the fallback UI
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    // Log error to console for debugging
    console.error("QueryErrorBoundary caught an error:", error, errorInfo);
  }

  handleReset = () => {
    // Reset the error boundary state
    this.setState({ hasError: false, error: null });
  };

  handleReload = () => {
    // Reload the page to reset everything
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex h-screen items-center justify-center bg-background">
          <div className="max-w-md space-y-4 text-center p-6">
            <div className="space-y-2">
              <h1 className="text-2xl font-bold text-destructive">
                Etwas ist schiefgelaufen
              </h1>
              <p className="text-muted-foreground">
                Ein unerwarteter Fehler ist aufgetreten. Bitte versuchen Sie es
                erneut.
              </p>
            </div>

            {this.state.error && (
              <div className="bg-destructive/10 border border-destructive/20 rounded-md p-4 text-left">
                <p className="text-sm font-mono text-destructive break-words">
                  {this.state.error.message}
                </p>
              </div>
            )}

            <div className="flex gap-3 justify-center">
              <Button variant="outline" onClick={this.handleReset}>
                Erneut versuchen
              </Button>
              <Button onClick={this.handleReload}>Seite neu laden</Button>
            </div>

            {process.env.NODE_ENV === "development" && this.state.error && (
              <details className="mt-4 text-left">
                <summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground">
                  Technische Details (nur in Entwicklung)
                </summary>
                <pre className="mt-2 text-xs bg-muted p-3 rounded overflow-auto max-h-48">
                  {this.state.error.stack}
                </pre>
              </details>
            )}
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
