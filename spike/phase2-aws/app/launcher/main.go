// Mayfly in-VM launcher (Phase 2, real Lambda MicroVM).
//   - answers MicroVM build + runtime lifecycle hooks (/ready, /run, etc.);
//   - binds its listeners SYNCHRONOUSLY before serving, so the build snapshot
//     can't be taken before :8080 is bound;
//   - JIT hand-off at POST /jit; exposes /status; does not exit after the job
//     (stays alive so the control plane does the teardown).
package main

import (
	"encoding/json"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"sync"
	"sync/atomic"
)

type runReq struct {
	JitConfig string `json:"jitconfig"`
}

var (
	mu      sync.Mutex
	started atomic.Bool
	jobDone atomic.Bool
	jobCode atomic.Int32
	doneCh  = make(chan int, 1)
)

func hookOK(w http.ResponseWriter, r *http.Request) {
	log.Printf("[launcher] lifecycle hook: POST %s", r.URL.Path)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("{}"))
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
	// Bind both listeners synchronously (fail fast if we can't), THEN serve —
	// so the sockets are already up before the build's snapshot could be taken.
	// 8080 = app/endpoint traffic (JIT hand-off); 9000 = lifecycle hooks if
	// delivered on a separate port.
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
