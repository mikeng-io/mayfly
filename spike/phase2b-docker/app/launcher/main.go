// Mayfly in-VM launcher (Phase 2b — Docker-in-MicroVM spike).
// Same as Phase 2, but on /jit it starts dockerd LAZILY (so we don't snapshot a
// running daemon) before launching the runner, so job steps can `docker build`/`run`.
package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"sync"
	"sync/atomic"
	"time"
)

type runReq struct {
	JitConfig string `json:"jitconfig"`
}

var (
	mu      sync.Mutex
	started atomic.Bool
	jobDone atomic.Bool
	jobCode atomic.Int32
	dockerUp atomic.Bool
	doneCh  = make(chan int, 1)
)

func hookOK(w http.ResponseWriter, r *http.Request) {
	log.Printf("[launcher] lifecycle hook: POST %s", r.URL.Path)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("{}"))
}

// startDockerd launches dockerd in the background and waits for its socket.
func startDockerd() error {
	if _, err := os.Stat("/var/run/docker.sock"); err == nil {
		dockerUp.Store(true)
		return nil
	}
	log.Println("[launcher] starting dockerd…")
	cmd := exec.Command("dockerd")
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start dockerd: %w", err)
	}
	for i := 0; i < 60; i++ {
		if _, err := os.Stat("/var/run/docker.sock"); err == nil {
			dockerUp.Store(true)
			log.Println("[launcher] dockerd is up")
			return nil
		}
		time.Sleep(time.Second)
	}
	return fmt.Errorf("dockerd socket not ready after 60s")
}

func handleJit(w http.ResponseWriter, r *http.Request) {
	var req runReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.JitConfig == "" {
		http.Error(w, `need {"jitconfig":"<base64>"}`, http.StatusBadRequest)
		return
	}
	mu.Lock()
	if started.Load() {
		mu.Unlock()
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte("already started"))
		return
	}
	started.Store(true)
	mu.Unlock()

	log.Println("[launcher] received JIT config")
	w.WriteHeader(http.StatusAccepted)
	_, _ = w.Write([]byte("accepted\n"))

	go func() {
		if err := startDockerd(); err != nil {
			log.Printf("[launcher] WARN dockerd: %v (continuing; docker steps will fail)", err)
		}
		cmd := exec.Command("/actions-runner/run.sh", "--jitconfig", req.JitConfig)
		cmd.Dir = "/actions-runner"
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		code := 0
		if err := cmd.Run(); err != nil {
			if ee, ok := err.(*exec.ExitError); ok {
				code = ee.ExitCode()
			} else {
				code = 1
			}
		}
		log.Printf("[launcher] runner exited code=%d", code)
		jobCode.Store(int32(code))
		jobDone.Store(true)
		doneCh <- code
	}()
}

func handleStatus(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("content-type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"started": started.Load(), "done": jobDone.Load(), "code": jobCode.Load(), "docker": dockerUp.Load(),
	})
}

func newMux() *http.ServeMux {
	m := http.NewServeMux()
	m.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte("ok")) })
	m.HandleFunc("/status", handleStatus)
	m.HandleFunc("/jit", handleJit)
	for _, h := range []string{"run", "resume", "suspend", "terminate", "ready", "validate"} {
		m.HandleFunc("/aws/lambda-microvms/runtime/v1/"+h, hookOK)
	}
	return m
}

func main() {
	h := newMux()
	for _, addr := range []string{":8080", ":9000"} {
		ln, err := net.Listen("tcp", addr)
		if err != nil {
			log.Fatalf("[launcher] listen %s: %v", addr, err)
		}
		log.Printf("[launcher] listening on %s", addr)
		go func(l net.Listener) { _ = http.Serve(l, h) }(ln)
	}
	code := <-doneCh
	log.Printf("[launcher] one job complete code=%d; staying alive for teardown", code)
	select {}
}
