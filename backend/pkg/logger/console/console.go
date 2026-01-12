package console

import (
	"os"

	"github.com/charmbracelet/log"
)

// ConsoleLogger implements LoggerInstance using charmbracelet/log for console output.
type ConsoleLogger struct {
	logger *log.Logger
}

// ConsoleLoggerParams contains configuration for creating a ConsoleLogger.
type ConsoleLoggerParams struct {
	Debug bool
}

// NewConsoleLogger creates a new console logger that writes to stderr.
func NewConsoleLogger(params ConsoleLoggerParams) *ConsoleLogger {
	level := log.InfoLevel
	if params.Debug {
		level = log.DebugLevel
	}
	logger := log.NewWithOptions(os.Stderr, log.Options{
		ReportTimestamp: true,
		Level:           level,
	})
	return &ConsoleLogger{
		logger: logger,
	}
}

// Log writes a message at the default level.
func (c *ConsoleLogger) Log(message string, keyvals ...any) {
	c.logger.Print(message, keyvals...)
}

// Info writes a message at INFO level.
func (c *ConsoleLogger) Info(message string, keyvals ...any) {
	c.logger.Info(message, keyvals...)
}

// Warn writes a message at WARN level.
func (c *ConsoleLogger) Warn(message string, keyvals ...any) {
	c.logger.Warn(message, keyvals...)
}

// Error writes a message at ERROR level.
func (c *ConsoleLogger) Error(message string, keyvals ...any) {
	c.logger.Error(message, keyvals...)
}

// Debug writes a message at DEBUG level.
func (c *ConsoleLogger) Debug(message string, keyvals ...any) {
	c.logger.Debug(message, keyvals...)
}

// Fatal writes a message at FATAL level and terminates the program.
func (c *ConsoleLogger) Fatal(message string, keyvals ...any) {
	c.logger.Fatal(message, keyvals...)
}
