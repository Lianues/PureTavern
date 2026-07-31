package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

var (
	version = "dev"
	commit  = "unknown"
)

func main() {
	if len(os.Args) == 2 && (os.Args[1] == "--version" || os.Args[1] == "-version") {
		fmt.Println(describeVersion(version, commit))
		return
	}
	if len(os.Args) != 1 {
		log.Fatalf("unknown argument; use --version or start without arguments")
	}
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	configuration, err := loadSettings(os.Getenv)
	if err != nil {
		return err
	}
	handler, err := newProxyServer(configuration, nil)
	if err != nil {
		return err
	}

	listener, err := net.Listen("tcp", address(configuration))
	if err != nil {
		return fmt.Errorf("listen: %w", err)
	}
	defer listener.Close()

	server := &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: 30 * time.Second,
		ReadTimeout:       120 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	log.Printf("PureTavern Go remote server %s listening on http://%s", version, listener.Addr())

	errCh := make(chan error, 1)
	go func() {
		errCh <- server.Serve(listener)
	}()

	signalContext, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	select {
	case serveErr := <-errCh:
		if errors.Is(serveErr, http.ErrServerClosed) {
			return nil
		}
		return fmt.Errorf("serve: %w", serveErr)
	case <-signalContext.Done():
		shutdownContext, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdownContext); err != nil {
			_ = server.Close()
			return fmt.Errorf("shutdown: %w", err)
		}
		serveErr := <-errCh
		if serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
			return fmt.Errorf("serve: %w", serveErr)
		}
		return nil
	}
}
