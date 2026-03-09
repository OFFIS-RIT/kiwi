package main

import (
	"github.com/OFFIS-RIT/kiwi/backend/internal/util"
	internalworkflow "github.com/OFFIS-RIT/kiwi/backend/internal/workflow"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/logger"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/logger/console"

	_ "github.com/lib/pq"
)

func main() {
	util.LoadEnv()

	debug := util.GetEnvBool("DEBUG", false)
	consoleLogger := console.NewConsoleLogger(console.ConsoleLoggerParams{Debug: debug})
	logger.Init(consoleLogger)

	internalworkflow.Init()
}
