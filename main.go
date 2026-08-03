// Command m6t is a desktop workbench for Kubernetes manifest repositories.
// It is the composition root: it embeds the built frontend and hands the
// assembled application options to the Wails runtime.
package main

import (
	"embed"
	"log"

	"github.com/wailsapp/wails/v2"

	"github.com/txn2/m6t/internal/app"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	if err := wails.Run(app.Options(assets)); err != nil {
		log.Fatalf("m6t failed to start: %v", err)
	}
}
