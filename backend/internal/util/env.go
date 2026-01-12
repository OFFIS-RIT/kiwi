package util

import (
	"kiwi/pkg/logger"
	"os"
	"strconv"

	"github.com/joho/godotenv"
)

func LoadEnv() {
	if err := godotenv.Load(); err != nil {
		logger.Debug("No .env file found, using system environment variables")
	}
}

func GetEnv(key string) string {
	value, exists := os.LookupEnv(key)
	if !exists {
		return ""
	}
	return value
}

func GetEnvString(key string, defaultValue string) string {
	value, exists := os.LookupEnv(key)
	if !exists {
		return defaultValue
	}

	return value
}

func GetEnvNumeric(key string, defaultValue int) float64 {
	value, exists := os.LookupEnv(key)
	if !exists {
		return float64(defaultValue)
	}
	returnValue, err := strconv.ParseFloat(value, 64)
	if err != nil {
		return float64(defaultValue)
	}

	return returnValue
}

func GetEnvBool(key string, defaultValue bool) bool {
	value, exists := os.LookupEnv(key)
	if !exists {
		return defaultValue
	}

	if value == "true" || value == "false" {
		return value == "true"
	}

	return defaultValue
}
