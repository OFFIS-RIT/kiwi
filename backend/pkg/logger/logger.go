package logger

// LoggerInstance defines the interface for logging backends.
type LoggerInstance interface {
	Log(message string, keyvals ...any)
	Debug(message string, keyvals ...any)
	Info(message string, keyvals ...any)
	Warn(message string, keyvals ...any)
	Error(message string, keyvals ...any)
	Fatal(message string, keyvals ...any)
}

// Logger holds multiple logging backends and dispatches log calls to all of them.
type Logger struct {
	instances []LoggerInstance
}

var singleton *Logger

func getSingleton() *Logger {
	return singleton
}

// Init initializes the global logger with one or more logging backends.
// This must be called before using any logging functions.
func Init(instances ...LoggerInstance) {
	singleton = &Logger{
		instances: instances,
	}
}

// Log writes a message at the default log level to all configured backends.
func Log(message string, keyvals ...any) {
	logger := getSingleton()
	if logger == nil {
		return
	}

	for _, instance := range logger.instances {
		instance.Log(message)
	}
}

// Info writes a message at INFO level to all configured backends.
func Info(message string, keyvals ...any) {
	logger := getSingleton()
	if logger == nil {
		return
	}

	for _, instance := range logger.instances {
		instance.Info(message, keyvals...)
	}
}

// Warn writes a message at WARN level to all configured backends.
func Warn(message string, keyvals ...any) {
	logger := getSingleton()
	if logger == nil {
		return
	}

	for _, instance := range logger.instances {
		instance.Warn(message, keyvals...)
	}
}

// Error writes a message at ERROR level to all configured backends.
func Error(message string, keyvals ...any) {
	logger := getSingleton()
	if logger == nil {
		return
	}

	for _, instance := range logger.instances {
		instance.Error(message, keyvals...)
	}
}

// Debug writes a message at DEBUG level to all configured backends.
func Debug(message string, keyvals ...any) {
	logger := getSingleton()
	if logger == nil {
		return
	}

	for _, instance := range logger.instances {
		instance.Debug(message, keyvals...)
	}
}

// Fatal writes a message at FATAL level and terminates the program.
func Fatal(message string, keyvals ...any) {
	logger := getSingleton()
	if logger == nil {
		return
	}

	for _, instance := range logger.instances {
		instance.Fatal(message, keyvals...)
	}
}
