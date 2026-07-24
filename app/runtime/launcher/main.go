// Mayfly in-VM launcher (productionized from the Phase 2 / Phase 2b spikes).
//
//   - binds its listeners SYNCHRONOUSLY before serving, so the MicroVM build
//     snapshot can't be taken before :8080 is bound;
//   - answers MicroVM lifecycle hooks with 200;
//   - receives the JIT config at POST /jit and execs run.sh for exactly one job;
//   - if a dockerd binary is present, starts it LAZILY on /jit (so we don't
//     snapshot a running daemon) — one launcher binary serves both the lean and
//     docker-capable images;
//   - exposes /status and /health; does NOT exit after the job (the control
//     plane observes /status via the endpoint and terminates the MicroVM).
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
	// MicrovmID is handed to us by the control plane. Every VM is restored from one
	// build snapshot, so nothing the kernel set at boot (boot_id, machine-id, hostname)
	// differs between VMs — this is the only value in the guest that identifies which
	// MicroVM this is, and it can only come from outside.
	MicrovmID string `json:"microvmId"`
}

var (
	mu       sync.Mutex
	started  atomic.Bool
	jobDone  atomic.Bool
	jobCode  atomic.Int32
	dockerUp atomic.Bool
	doneCh   = make(chan int, 1)
)

func hookOK(w http.ResponseWriter, r *http.Request) {
	log.Printf("[launcher] lifecycle hook: POST %s", r.URL.Path)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("{}"))
}

// startDockerd launches dockerd in the background and waits for its socket.
// No-op (returns nil) when dockerd isn't installed — the lean image.
func startDockerd() error {
	if _, err := exec.LookPath("dockerd"); err != nil {
		return nil // lean image: no docker, nothing to start
	}
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

	log.Println("[launcher] received JIT config; starting runner for one job")
	w.WriteHeader(http.StatusAccepted)
	_, _ = w.Write([]byte("accepted\n"))

	go func() {
		if err := startDockerd(); err != nil {
			log.Printf("[launcher] WARN dockerd: %v (continuing; docker steps will fail)", err)
		}
		cmd := exec.Command("/actions-runner/run.sh", "--jitconfig", req.JitConfig)
		cmd.Dir = "/actions-runner"
		// Expose the VM's identity to the job. Steps read $MAYFLY_MICROVM_ID.
		cmd.Env = append(os.Environ(), "MAYFLY_MICROVM_ID="+req.MicrovmID)
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
		log.Printf("[launcher] runner process exited code=%d", code)
		jobCode.Store(int32(code))
		jobDone.Store(true)
		doneCh <- code
	}()
}

func handleStatus(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("content-type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"started": started.Load(),
		"done":    jobDone.Load(),
		"code":    jobCode.Load(),
		"docker":  dockerUp.Load(),
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
	// Bind both listeners synchronously (fail fast), THEN serve — so the sockets
	// are up before the build snapshot could be taken. 8080 = endpoint/JIT traffic;
	// 9000 = lifecycle hooks if delivered on a separate port.
	for _, addr := range []string{":8080", ":9000"} {
		ln, err := net.Listen("tcp", addr)
		if err != nil {
			log.Fatalf("[launcher] listen %s: %v", addr, err)
		}
		log.Printf("[launcher] listening on %s", addr)
		go func(l net.Listener) { _ = http.Serve(l, h) }(ln)
	}
	code := <-doneCh
	log.Printf("[launcher] one job complete code=%d; staying alive for control-plane teardown", code)
	select {} // block; control plane observes /status and terminates the MicroVM
}
