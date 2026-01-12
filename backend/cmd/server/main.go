package main

import (
	"kiwi/internal/server"
	"kiwi/internal/util"
	"kiwi/pkg/logger"
	"kiwi/pkg/logger/console"

	_ "github.com/lib/pq"
)

func main() {
	util.LoadEnv()

	debug := util.GetEnvBool("DEBUG", false)

	consoleLogger := console.NewConsoleLogger(console.ConsoleLoggerParams{
		Debug: debug,
	})
	logger.Init(consoleLogger)

	server.Init()
}
